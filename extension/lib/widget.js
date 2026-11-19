// lib/widget.js — the floating "Start timer" panel, shared by Jira (content.js) and Gmail (gmail.js).
//
// createWidget(adapter) where adapter = {
//   currentKey()                 → id of what's open (Jira issue key / Gmail thread id) or null
//   label(key)                   → short text for the button ("KEYHOLE-117", "this email")
//   read()                       → Promise<payload> describing what's open (throws with a user message if not ready)
//   startMessage(payload, opts)  → runtime message that starts the timer ({ projectId?, note? } in opts)
//   runningFor(status, key, ctx) → the running PM timer for this key, or null (ctx = extras from background)
//   remember(payload)            → what the background should remember when the user changes the timer
// }
(() => {
  if (globalThis.TimerWidget) return;

  const STYLE = `
    :host { all: initial; }
    .box { position: fixed; right: 18px; bottom: 18px; z-index: 2147483000;
           font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #141d33; color: #c8d8f0; border: 1px solid #2a3a60; border-radius: 10px;
           box-shadow: 0 6px 24px rgba(0,0,0,.25); width: 300px; overflow: hidden; }
    .box.min { width: auto; }
    .row { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }
    button { font: inherit; cursor: pointer; border-radius: 6px; border: 0; }
    .start { flex: 1; background: #2563eb; color: #fff; font-weight: 600; padding: 8px 10px; }
    .start:hover { background: #3b74f0; }
    .start:disabled { opacity: .55; cursor: default; }
    .start.running { background: #16a34a; }
    .icon { background: none; color: #5a7aaa; padding: 4px 6px; font-size: 14px; }
    .icon:hover { color: #c8d8f0; }
    .meta { padding: 0 12px 10px; font-size: 12px; color: #8aa0c8; }
    .meta b { color: #c8d8f0; font-weight: 600; }
    .bar { height: 4px; background: #1e2d4a; border-radius: 2px; margin-top: 6px; overflow: hidden; }
    .bar > i { display: block; height: 100%; background: #16a34a; width: 0; }
    .msg { padding: 0 12px 10px; font-size: 12px; }
    .msg.ok { color: #7ee2a8; } .msg.err { color: #ff8a8a; } .msg.warn { color: #e5c76b; }
    .msg a, .link { color: #8ab4ff; cursor: pointer; text-decoration: underline; background: none; padding: 0; }
    .note { color: #a8d4ff; }
    .choose { padding: 0 12px 10px; }
    .choose input[type=search] { width: 100%; box-sizing: border-box; margin: 4px 0 6px; padding: 6px 8px;
           background: #0c1020; color: #c8d8f0; border: 1px solid #2a3a60; border-radius: 6px; font: inherit; }
    .list { max-height: 210px; overflow: auto; border: 1px solid #2a3a60; border-radius: 6px; }
    .opt { display: block; padding: 6px 8px; cursor: pointer; border-bottom: 1px solid #1e2d4a; }
    .opt:last-child { border-bottom: 0; }
    .opt:hover { background: #1a2540; }
    .opt.sel { background: #1a3060; }
    .opt small { display: block; color: #6c84ae; }
    .actions { display: flex; gap: 6px; margin-top: 8px; }
    .actions .start { flex: 1; }
    .ghost { background: #1e2d4a; color: #a0b8e0; padding: 8px 10px; }
    .hidden { display: none !important; }
    .dot { width: 30px; height: 30px; border-radius: 50%; background: #2563eb; color: #fff; font-size: 14px; }
    .dot.running { background: #16a34a; }
    @media (prefers-color-scheme: light) {
      .box { background: #fff; color: #1a2540; border-color: #c4d0e8; box-shadow: 0 6px 24px rgba(20,40,80,.15); }
      .meta { color: #4a5e8a; } .meta b { color: #1a2540; }
      .bar { background: #e0eaf8; }
      .note { color: #0f2050; }
      .choose input[type=search] { background: #f0f4f8; color: #1a2540; border-color: #c4d0e8; }
      .list { border-color: #c4d0e8; } .opt { border-color: #e0eaf8; }
      .opt:hover { background: #edf4ff; } .opt.sel { background: #dce8ff; }
      .opt small { color: #6070a0; }
      .ghost { background: #e0eaf8; color: #1a2540; }
      .msg.ok { color: #15803d; } .msg.err { color: #b91c1c; } .msg.warn { color: #92400e; }
      .msg a, .link { color: #1d4ed8; }
    }`;


  function createWidget(adapter) {
    let host, els, payload = null, busy = false, currentKey = null, status = null, ctx = {};

    const fmtHours = h => (h == null ? '—' : h.toFixed(1));
    const fmtElapsed = ms => {
      const m = Math.max(0, Math.floor(ms / 60000));
      return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
    };
    const send = (m) => browser.runtime.sendMessage(m);
    const openPm = { label: 'Open PM', onClick: () => send({ type: 'PM_OPEN' }) };
    const goal = () => status?.goalHours || 7;

    async function withGoal(s) {
      const { dailyGoalHours } = await browser.storage.local.get('dailyGoalHours');
      return { ...s, goalHours: Number(dailyGoalHours) || 7 };
    }
    function takeExtras(res) { if (res?.emailEntries) ctx = { ...ctx, emailEntries: res.emailEntries }; }

    function build() {
      host = document.createElement('div');
      host.id = 'jira-time-helper-widget';
      const root = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = STYLE;
      const tpl = document.createElement('template');
      // Static markup only — all dynamic text is set with textContent.
      tpl.innerHTML = `
    <div class="box">
      <div class="full">
        <div class="row">
          <button class="start">▶ Start timer</button>
          <button class="icon min-btn" title="Minimize">–</button>
        </div>
        <div class="meta"></div>
        <div class="msg hidden"></div>
        <div class="choose hidden">
          <div class="reason"></div>
          <input type="search" placeholder="Search all PM timers…">
          <div class="list"></div>
          <div class="actions">
            <button class="start confirm">Start on this timer</button>
            <button class="ghost cancel">Cancel</button>
          </div>
        </div>
      </div>
      <button class="dot hidden" title="Jira Time Helper">⏱</button>
    </div>`;
      root.append(style, tpl.content);
      const q = s => root.querySelector(s);
      els = {
        box: q('.box'), full: q('.full'), dot: q('.dot'), start: q('.full .start'), min: q('.min-btn'),
        meta: q('.meta'), msg: q('.msg'), choose: q('.choose'), reason: q('.reason'),
        search: q('input[type=search]'), list: q('.list'), confirm: q('.confirm'), cancel: q('.cancel'),
      };
      els.start.addEventListener('click', () => start());
      els.min.addEventListener('click', () => setMinimized(true));
      els.dot.addEventListener('click', () => setMinimized(false));
      els.cancel.addEventListener('click', () => hideChooser());
      document.documentElement.appendChild(host);
      browser.storage.local.get('widgetMinimized').then(s => setMinimized(!!s.widgetMinimized, false));
    }

    function setMinimized(min, save = true) {
      els.full.classList.toggle('hidden', min);
      els.dot.classList.toggle('hidden', !min);
      els.box.classList.toggle('min', min);
      if (save) browser.storage.local.set({ widgetMinimized: min });
    }

    function showMsg(text, kind = 'ok', link) {
      els.msg.className = `msg ${kind}`;
      els.msg.textContent = text;
      if (link) {
        const a = document.createElement('a');
        a.textContent = ` ${link.label}`;
        a.addEventListener('click', link.onClick);
        els.msg.appendChild(a);
      }
    }
    const clearMsg = () => { els.msg.className = 'msg hidden'; els.msg.textContent = ''; };

    function runningHere() {
      return status && currentKey ? adapter.runningFor(status, currentKey, ctx) || null : null;
    }

    // Today's hours + what's running, under the button.
    function renderMeta() {
      if (!els) return;
      els.meta.textContent = '';
      if (!status) { els.meta.textContent = 'PM: checking…'; return; }
      const today = status.todayBillableHours;
      const line = document.createElement('div');
      line.append('Today ');
      const b = document.createElement('b'); b.textContent = `${fmtHours(today)} / ${goal()} h`; line.append(b);
      const here = runningHere();
      const elsewhere = status.running.find(r => !here || r.id !== here.id);
      if (elsewhere) line.append(` · running: ${elsewhere.note || elsewhere.projectName}`.slice(0, 80));
      els.meta.appendChild(line);
      const bar = document.createElement('div'); bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.min(100, ((today || 0) / goal()) * 100)}%`;
      bar.appendChild(fill); els.meta.appendChild(bar);

      const label = currentKey ? adapter.label(currentKey) : '';
      if (here) {
        els.start.textContent = `● Timing ${label} · ${here.startedAt ? fmtElapsed(Date.now() - here.startedAt) : ''}`;
        els.start.classList.add('running');
      } else if (!busy) {
        els.start.textContent = `▶ Start timer${label ? ` · ${label}` : ''}`;
        els.start.classList.remove('running');
      }
      els.dot.classList.toggle('running', !!here);
      const runaway = status.running.find(r => r.runaway);
      if (runaway && !busy && els.msg.classList.contains('hidden')) {
        showMsg(`A timer has been running since ${new Date(runaway.startedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}: ${runaway.note || runaway.projectName}.`, 'warn', openPm);
      }
    }

    async function refreshStatus(force = false) {
      const res = await send({ type: 'PM_STATUS', force }).catch(e => ({ error: String(e) }));
      if (!els) return;
      takeExtras(res);
      if (res?.status) {
        status = await withGoal(res.status);
        renderMeta();
      } else {
        status = null;
        els.meta.textContent = res?.signIn ? '' : 'PM status unavailable.';
        if (res?.signIn) showMsg('Sign in to PM to start timers.', 'warn', openPm);
      }
    }

    function setBusy(on, label) {
      busy = on;
      els.start.disabled = on;
      if (on) els.start.textContent = label;
    }

    async function start({ projectId, note } = {}) {
      if (busy) return;
      currentKey = adapter.currentKey(); // so sync() doesn't reset the panel mid-start
      if (!host) { build(); refreshStatus(); }
      host.style.display = '';
      setMinimized(false, false);
      clearMsg(); hideChooser();
      setBusy(true, 'Reading…');
      try {
        payload = await adapter.read();
        setBusy(true, projectId ? 'Starting timer…' : 'Finding the right timer…');
        const res = await send(adapter.startMessage(payload, { projectId, note }));
        takeExtras(res);
        if (res.error) {
          showMsg(res.error, 'err', res.signIn ? openPm : null);
        } else if (res.result === 'choose') {
          showChooser(res, note);
        } else if (res.result === 'already-running') {
          showMsg(`Already timing this: ${res.entry.note}`, 'ok');
        } else if (res.result === 'resumed') {
          showMsg(`Resumed: ${res.entry.note} — ${res.entry.projectName}`, 'ok');
        } else if (res.result === 'started') {
          showStarted(res);
        }
        if (res.status) status = await withGoal(res.status);
      } catch (e) {
        showMsg(e.message || String(e), 'err');
      } finally {
        setBusy(false);
        renderMeta();
      }
    }

    function showStarted(res) {
      els.msg.className = 'msg ok';
      els.msg.textContent = '';
      const head = document.createElement('div');
      head.textContent = `Started on ${res.project.name} — ${res.project.client}`;
      const n = document.createElement('div'); n.className = 'note'; n.textContent = res.note;
      const change = document.createElement('a'); change.textContent = 'Change timer';
      change.addEventListener('click', async () => {
        const r = await send({ type: 'PM_PROJECTS' });
        showChooser({
          candidates: (r.projects || []).filter(p => p.client === res.project.client),
          all: r.projects || [], suggestedId: res.project.id,
          reason: 'Move this entry to:', switchEntryId: res.entryId,
        });
      });
      els.msg.append(head, n, change);
      (res.warnings || []).forEach(w => {
        const d = document.createElement('div');
        d.className = 'msg warn'; d.style.padding = '4px 0 0'; d.textContent = w;
        els.msg.appendChild(d);
      });
    }

    // ── Project picker ──
    let chooser = null;
    function showChooser(res, note) {
      chooser = { res, note, selected: res.suggestedId || res.candidates?.[0]?.id || null };
      els.reason.textContent = res.reason || 'Pick the PM timer:';
      els.search.value = '';
      els.choose.classList.remove('hidden');
      renderList();
      els.search.oninput = renderList;
      els.confirm.textContent = res.switchEntryId ? 'Move to this timer' : 'Start on this timer';
      els.confirm.onclick = confirmChoice;
    }
    function hideChooser() { if (els) els.choose.classList.add('hidden'); chooser = null; }

    function renderList() {
      if (!chooser) return;
      const q = els.search.value.trim().toLowerCase();
      const pool = q ? (chooser.res.all || chooser.res.candidates)
        : (chooser.res.candidates?.length ? chooser.res.candidates : chooser.res.all);
      const items = (pool || [])
        .filter(p => !q || `${p.name} ${p.client} ${p.parents.join(' ')}`.toLowerCase().includes(q))
        .slice(0, 60);
      els.list.textContent = '';
      items.forEach(p => {
        const o = document.createElement('label');
        o.className = 'opt' + (p.id === chooser.selected ? ' sel' : '');
        o.textContent = p.name;
        const s = document.createElement('small');
        s.textContent = `${p.client}${p.parents[0] ? ' · ' + p.parents[0] : ''}`;
        o.appendChild(s);
        o.addEventListener('click', () => { chooser.selected = p.id; renderList(); });
        o.addEventListener('dblclick', () => { chooser.selected = p.id; confirmChoice(); });
        els.list.appendChild(o);
      });
      if (!items.length) els.list.textContent = 'No matching timers.';
    }

    async function confirmChoice() {
      if (!chooser?.selected) return;
      const { res, note, selected } = chooser;
      hideChooser();
      if (res.switchEntryId) {
        setBusy(true, 'Moving entry…');
        const r = await send({ type: 'PM_SWITCH', entryId: res.switchEntryId, projectId: selected, remember: adapter.remember(payload) });
        setBusy(false);
        takeExtras(r);
        if (r.error) showMsg(r.error, 'err');
        else { showMsg(`Moved to ${r.project.name} — ${r.project.client}`, 'ok'); status = await withGoal(r.status); }
        renderMeta();
      } else {
        start({ projectId: selected, note });
      }
    }

    // Show when something is open, hide otherwise; Jira and Gmail change URLs without reloading.
    function sync() {
      const key = adapter.currentKey();
      if (key === currentKey) return;
      currentKey = key;
      if (!host) { if (!key) return; build(); refreshStatus(); }
      host.style.display = key ? '' : 'none';
      clearMsg(); hideChooser();
      renderMeta();
    }

    // For messages from outside the widget (e.g. Gmail: "paused after sending").
    async function notify(text, kind = 'ok', res) {
      if (!els) return;
      takeExtras(res);
      if (res?.status) status = await withGoal(res.status);
      showMsg(text, kind);
      renderMeta();
    }

    return { sync, start, refreshStatus, notify };
  }

  globalThis.TimerWidget = { createWidget };
})();
