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

  // Design tokens: the PM ("Stylist") theme — keep in sync with popup.html.
  const STYLE = `
    :host { all: initial; }
    .box {
      --pm-surface: #ffffff; --pm-surface-2: #ebebee; --pm-hover: #f0f0f2;
      --pm-glass: rgba(255, 255, 255, .72);
      --pm-border: rgba(60, 60, 67, .12); --pm-border-strong: rgba(60, 60, 67, .22);
      --pm-text: #1d1d1f; --pm-text-2: #48484d; --pm-text-3: #86868b;
      --pm-accent: #007aff; --pm-accent-hover: #0068d9; --pm-accent-soft: #e5f0ff; --pm-on-accent: #fff;
      --pm-success: #28b04b; --pm-success-soft: #e3f6e8;
      --pm-danger: #ff3b30; --pm-danger-soft: #ffebea;
      --pm-warning-text: #b25f00; --pm-warning-soft: #fff3e0;
      --pm-fill: rgba(120, 120, 128, .12); --pm-fill-2: rgba(120, 120, 128, .18);
      --pm-shadow-pop: 0 0 0 .5px rgba(0, 0, 0, .10), 0 10px 30px rgba(0, 0, 0, .16);
      --pm-primary-shadow: inset 0 1px 0 rgba(255, 255, 255, .28), 0 0 0 .5px rgba(0, 0, 0, .08), 0 1px 2px rgba(0, 0, 0, .12);
      --pm-radius: 12px;
      --pm-font: system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI', Roboto, sans-serif;

      position: fixed; right: 18px; bottom: 18px; z-index: 2147483000; width: 300px; overflow: hidden;
      font: 13px/1.45 var(--pm-font); color: var(--pm-text);
      background: var(--pm-glass); -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px);
      border-radius: var(--pm-radius); box-shadow: var(--pm-shadow-pop);
      transition: box-shadow 160ms;
    }
    @media (prefers-color-scheme: dark) {
      .box {
        --pm-surface: #2c2c2e; --pm-surface-2: #3a3a3c; --pm-hover: #333336;
        --pm-glass: rgba(44, 44, 46, .78);
        --pm-border: rgba(84, 84, 88, .45); --pm-border-strong: rgba(120, 120, 128, .45);
        --pm-text: #e5e5e7; --pm-text-2: #aeaeb2; --pm-text-3: #8e8e93;
        --pm-accent: #0a84ff; --pm-accent-hover: #409cff; --pm-accent-soft: #10304f;
        --pm-success: #30d158; --pm-success-soft: #12331d;
        --pm-danger: #ff453a; --pm-danger-soft: #3b1a18;
        --pm-warning-text: #ff9f0a; --pm-warning-soft: #3a2a10;
        --pm-fill: rgba(120, 120, 128, .24); --pm-fill-2: rgba(120, 120, 128, .32);
        --pm-shadow-pop: 0 0 0 .5px rgba(255, 255, 255, .10), 0 12px 32px rgba(0, 0, 0, .5);
        --pm-primary-shadow: inset 0 1px 0 rgba(255, 255, 255, .18), 0 0 0 .5px rgba(0, 0, 0, .3), 0 1px 2px rgba(0, 0, 0, .4);
      }
    }
    .box.is-running { box-shadow: 0 0 0 2px var(--pm-success), var(--pm-shadow-pop); }
    .box.min { width: auto; border-radius: 999px; }
    .row { display: flex; align-items: center; gap: 6px; padding: 10px 10px 8px 12px; }
    button { font: inherit; cursor: pointer; border: 0; }
    button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--pm-accent); outline-offset: 2px; }

    .start {
      flex: 1; height: 34px; padding: 0 12px; border-radius: 9px;
      background: var(--pm-accent); color: var(--pm-on-accent); box-shadow: var(--pm-primary-shadow);
      font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      transition: background-color 120ms;
    }
    .start:hover { background: var(--pm-accent-hover); }
    .start:active:not(:disabled) { transform: translateY(1px); }
    .start:disabled { opacity: .6; cursor: default; }
    .start.running { background: var(--pm-success-soft); color: var(--pm-success); box-shadow: none; }
    .icon {
      width: 28px; height: 28px; border-radius: 8px; background: transparent;
      color: var(--pm-text-3); font-size: 15px; line-height: 1;
    }
    .icon:hover { background: var(--pm-fill); color: var(--pm-text); }

    .meta { padding: 0 12px 10px; font-size: 12px; color: var(--pm-text-2); }
    .meta b { color: var(--pm-text); font-weight: 600; font-variant-numeric: tabular-nums; }
    .bar { height: 5px; margin-top: 6px; border-radius: 999px; background: var(--pm-fill); overflow: hidden; }
    .bar > i { display: block; height: 100%; width: 0; border-radius: 999px; background: var(--pm-accent); }

    .msg { margin: 0 10px 10px; padding: 8px 10px; border-radius: 9px; font-size: 12px; line-height: 1.45; }
    .msg.ok { background: var(--pm-success-soft); color: var(--pm-text); }
    .msg.err { background: var(--pm-danger-soft); color: var(--pm-danger); }
    .msg.warn { background: var(--pm-warning-soft); color: var(--pm-warning-text); }
    .msg .msg.warn { margin: 6px 0 0; padding: 0; background: none; }
    .msg a, .link { color: var(--pm-accent); cursor: pointer; font-weight: 500; text-decoration: none; }
    .msg a:hover { text-decoration: underline; }
    .note { margin: 3px 0 4px; color: var(--pm-text-2); }

    .choose { padding: 0 10px 10px; }
    .reason { padding: 0 2px 6px; font-size: 12px; font-weight: 600; color: var(--pm-text-2); }
    .choose input[type=search] {
      width: 100%; box-sizing: border-box; height: 30px; margin: 0 0 6px; padding: 0 10px;
      border: 1px solid transparent; border-radius: 8px; outline: none;
      background: var(--pm-fill); color: var(--pm-text); font: 12px var(--pm-font);
    }
    .choose input[type=search]:focus {
      background: var(--pm-surface);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--pm-accent) 35%, transparent);
    }
    .list { max-height: 210px; overflow: auto; border-radius: 9px; background: var(--pm-surface); }
    .opt { display: block; padding: 7px 10px; cursor: pointer; border-top: 1px solid var(--pm-border); }
    .opt:first-child { border-top: 0; }
    .opt:hover { background: var(--pm-hover); }
    .opt.sel { background: var(--pm-accent-soft); box-shadow: inset 3px 0 0 var(--pm-accent); }
    .opt small { display: block; color: var(--pm-text-3); font-size: 11.5px; }
    .actions { display: flex; gap: 6px; margin-top: 8px; }
    .actions .start { flex: 1; }
    .ghost {
      height: 34px; padding: 0 12px; border-radius: 9px;
      background: var(--pm-surface); color: var(--pm-text);
      box-shadow: inset 0 0 0 1px var(--pm-border-strong);
    }
    .ghost:hover { background: var(--pm-surface-2); }
    .hidden { display: none !important; }
    .dot {
      width: 36px; height: 36px; border-radius: 50%;
      background: var(--pm-accent); color: var(--pm-on-accent); font-size: 15px; box-shadow: var(--pm-primary-shadow);
    }
    .dot.running { background: var(--pm-success); }`;


  function createWidget(adapter) {
    let host, els, payload = null, busy = false, currentKey = null, status = null, ctx = {};

    const fmtHours = h => (h == null ? '—' : h.toFixed(1));
    const fmtElapsed = ms => {
      const m = Math.max(0, Math.floor(ms / 60000));
      return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
    };
    const send = (m) => browser.runtime.sendMessage(m);
    const openPm = { label: 'Open PM', onClick: () => send({ type: 'PM_OPEN' }) };
    const goal = () => status?.goalHours || 6.5;

    async function withGoal(s) {
      const { dailyGoalHours } = await browser.storage.local.get('dailyGoalHours');
      return { ...s, goalHours: Number(dailyGoalHours) || 6.5 };
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
      const today = status.todayHours;
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
      els.box.classList.toggle('is-running', !!here);
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
