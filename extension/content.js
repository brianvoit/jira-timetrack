// content.js — runs on Jira pages. Reads the open issue (via Jira's REST API, with a
// DOM fallback) and shows a small "Start timer" button that starts the matching
// PM timer with an AI-written note.
(() => {
  if (window.__jiraTimeHelper) return; // guard against double injection
  window.__jiraTimeHelper = true;

  const DESC_LIMIT = 1400;

  // ── Reading the issue ─────────────────────────────────────────
  function jiraBase() {
    const meta = document.querySelector('meta[name="ajs-base-url"]');
    return (meta?.content || location.origin).replace(/\/$/, '');
  }

  // Firefox: content.fetch sends the request as the page (with the Jira session).
  const pageFetch = (typeof content !== 'undefined' && content.fetch) ? content.fetch.bind(content) : fetch;

  function trimDescription(text) {
    if (!text) return null;
    const t = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return t.length > DESC_LIMIT ? t.slice(0, DESC_LIMIT) + '…' : t;
  }

  async function issueFromApi(key) {
    const fields = 'summary,description,project,issuetype,status';
    const resp = await pageFetch(`${jiraBase()}/rest/api/2/issue/${encodeURIComponent(key)}?fields=${fields}`, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`Jira API ${resp.status}`);
    const json = await resp.json();
    const f = json.fields || {};
    return {
      key: json.key || key,
      projectKey: f.project?.key || JiraUrl.projectKeyOf(key),
      projectName: f.project?.name || null,
      issueType: f.issuetype?.name || null,
      summary: f.summary || null,
      description: trimDescription(typeof f.description === 'string' ? f.description : null),
      source: 'api',
    };
  }

  // Fallback when the REST API isn't reachable: read what the page shows.
  function issueFromDom(key) {
    const onBoard = JiraUrl.isBoardUrl(location.href);
    const pick = (sels) => { for (const s of sels) { const el = document.querySelector(s); if (el) return el; } return null; };
    const summaryEl = onBoard
      ? pick(['#ghx-detail-issue-title', '.ghx-detail-issue-title', 'input#summary', '.issue-title',
              '[data-field-id="summary"] .value', 'h1[data-testid="issue.views.issue-base.foundation.summary.heading"]',
              '#summary-val'])
      : pick(['h1[data-testid="issue.views.issue-base.foundation.summary.heading"]', '[data-testid*="summary"] h1',
              '#summary-val', 'h1[class*="Summary"]', 'h1']);
    const summary = summaryEl
      ? ((summaryEl.tagName === 'INPUT' || summaryEl.tagName === 'TEXTAREA') ? summaryEl.value : summaryEl.textContent).trim()
      : null;
    const descEl = pick(['.ghx-detail-description .ghx-description', '#ghx-detail-contents .description .value',
      '[data-field-id="description"] .value', '.gh-detail-description',
      '[data-testid="issue.views.issue-base.foundation.description.rendered-field"]',
      '#description-val', '#description .user-content-block']);
    const projectName = document.querySelector('#project-name-val')?.textContent.trim() || null;
    return {
      key,
      projectKey: JiraUrl.projectKeyOf(key),
      projectName,
      summary,
      description: trimDescription(descEl?.innerText || null),
      source: 'page',
    };
  }

  async function readIssue() {
    const key = JiraUrl.issueKeyFromUrl(location.href);
    if (!key) return { key: null };
    try {
      return await issueFromApi(key);
    } catch {
      return issueFromDom(key);
    }
  }

  // ── Today's issues (for the end-of-day list) ─────────────────
  async function searchJira(jql, max = 50) {
    const fields = 'summary,description,project,status';
    const url = `${jiraBase()}/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=${fields}&maxResults=${max}`;
    const resp = await pageFetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`Jira search ${resp.status}`);
    const json = await resp.json();
    return (json.issues || []).map(i => ({
      key: i.key,
      projectKey: i.fields?.project?.key || JiraUrl.projectKeyOf(i.key),
      projectName: i.fields?.project?.name || null,
      summary: i.fields?.summary || null,
      description: trimDescription(typeof i.fields?.description === 'string' ? i.fields.description : null),
      status: i.fields?.status?.name || null,
      base: jiraBase(),
    }));
  }

  // Issues viewed today, or assigned to me and updated today, plus any keys the
  // extension saw opened today (so titles show for those too).
  async function jiraToday(keys = []) {
    const queries = [
      'lastViewed >= startOfDay() OR (assignee = currentUser() AND updated >= startOfDay()) ORDER BY lastViewed DESC',
      'assignee = currentUser() AND updated >= startOfDay() ORDER BY updated DESC', // if lastViewed isn't searchable
    ];
    let issues = [];
    for (const q of queries) {
      try { issues = (await searchJira(q)).map(i => ({ ...i, source: 'jira' })); break; } catch { /* next */ }
    }
    const missing = keys.filter(k => !issues.some(i => i.key === k));
    if (missing.length) {
      try {
        issues.push(...(await searchJira(`issuekey in (${missing.join(',')})`, missing.length)).map(i => ({ ...i, source: 'visited' })));
      } catch {
        // One deleted/moved key fails the whole query — fetch individually instead.
        for (const k of missing) {
          try { issues.push({ ...(await issueFromApi(k)), base: jiraBase(), source: 'visited' }); } catch { /* skip */ }
        }
      }
    }
    return { ok: true, issues, base: jiraBase() };
  }

  // ── Messages from the popup / background ──────────────────────
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'SCRAPE_JIRA') return readIssue();
    if (msg.type === 'JIRA_TODAY') return jiraToday(msg.keys);
    if (msg.type === 'WIDGET_START') { widget.start({ note: msg.note }); return Promise.resolve({ ok: true }); }
  });

  // ── The Start timer button ────────────────────────────────────
  const widget = (() => {
    let host, root, els, issue = null, lastResult = null, busy = false, currentKey = null, status = null;

    const fmtHours = h => (h == null ? '—' : h.toFixed(1));
    const fmtElapsed = ms => {
      const m = Math.max(0, Math.floor(ms / 60000));
      return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
    };
    const send = (m) => browser.runtime.sendMessage(m);

    function build() {
      host = document.createElement('div');
      host.id = 'jira-time-helper-widget';
      root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
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
          }
        </style>
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

    // Today's hours + what's running, under the button.
    function renderMeta() {
      els.meta.textContent = '';
      if (!status) { els.meta.textContent = 'PM: checking…'; return; }
      const { goalHours = 7 } = status;
      const today = status.todayBillableHours;
      const line = document.createElement('div');
      line.append('Today ');
      const b = document.createElement('b'); b.textContent = `${fmtHours(today)} / ${goalHours} h`; line.append(b);
      const runningHere = status.running.find(r => currentKey && r.note.toUpperCase().includes(`(${currentKey})`));
      const runningElse = status.running.find(r => r !== runningHere);
      if (runningElse) {
        line.append(` · running: ${runningElse.note || runningElse.projectName}`.slice(0, 80));
      }
      els.meta.appendChild(line);
      const bar = document.createElement('div'); bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.min(100, ((today || 0) / goalHours) * 100)}%`;
      bar.appendChild(fill); els.meta.appendChild(bar);

      if (runningHere) {
        els.start.textContent = `● Timing ${currentKey} · ${runningHere.startedAt ? fmtElapsed(Date.now() - runningHere.startedAt) : ''}`;
        els.start.classList.add('running');
      } else if (!busy) {
        els.start.textContent = `▶ Start timer${currentKey ? ` · ${currentKey}` : ''}`;
        els.start.classList.remove('running');
      }
      els.dot.classList.toggle('running', !!runningHere);
      const runaway = status.running.find(r => r.runaway);
      if (runaway && !busy && els.msg.classList.contains('hidden')) {
        showMsg(`A timer has been running since ${new Date(runaway.startedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}: ${runaway.note || runaway.projectName}.`, 'warn',
          { label: 'Open PM', onClick: () => send({ type: 'PM_OPEN' }) });
      }
    }

    async function refreshStatus(force = false) {
      const res = await send({ type: 'PM_STATUS', force }).catch(e => ({ error: String(e) }));
      if (res?.status) {
        const { dailyGoalHours } = await browser.storage.local.get('dailyGoalHours');
        status = { ...res.status, goalHours: Number(dailyGoalHours) || 7 };
      } else {
        status = null;
        els.meta.textContent = res?.signIn ? '' : 'PM status unavailable.';
        if (res?.signIn) {
          showMsg('Sign in to PM to start timers.', 'warn', { label: 'Open PM', onClick: () => send({ type: 'PM_OPEN' }) });
        }
        return;
      }
      renderMeta();
    }

    function setBusy(on, label) {
      busy = on;
      els.start.disabled = on;
      if (on) els.start.textContent = label;
    }

    async function start({ projectId, note } = {}) {
      if (busy) return;
      currentKey = JiraUrl.issueKeyFromUrl(location.href); // so sync() doesn't reset the panel mid-start
      if (!host) { build(); refreshStatus(); }
      host.style.display = '';
      setMinimized(false, false);
      clearMsg(); hideChooser();
      setBusy(true, 'Reading ticket…');
      try {
        issue = await readIssue();
        if (!issue.key) throw new Error('Open an issue first.');
        setBusy(true, projectId ? 'Starting timer…' : 'Finding the right timer…');
        const res = await send({ type: 'PM_START', issue, projectId, note });
        lastResult = res;
        if (res.error) {
          showMsg(res.error, 'err', res.signIn ? { label: 'Open PM', onClick: () => send({ type: 'PM_OPEN' }) } : null);
        } else if (res.result === 'choose') {
          showChooser(res, note);
        } else if (res.result === 'already-running') {
          showMsg(`Already timing this ticket: ${res.entry.note}`, 'ok');
        } else if (res.result === 'resumed') {
          showMsg(`Resumed: ${res.entry.note} — ${res.entry.projectName}`, 'ok');
        } else if (res.result === 'started') {
          showStarted(res);
        }
        if (res.status) status = { ...res.status, goalHours: status?.goalHours || 7 };
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
      (res.warnings || []).forEach(w => { const d = document.createElement('div'); d.className = 'msg warn'; d.style.padding = '4px 0 0'; d.textContent = w; els.msg.appendChild(d); });
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
    function hideChooser() { els.choose.classList.add('hidden'); chooser = null; }

    function renderList() {
      if (!chooser) return;
      const q = els.search.value.trim().toLowerCase();
      const pool = q ? (chooser.res.all || chooser.res.candidates) : (chooser.res.candidates?.length ? chooser.res.candidates : chooser.res.all);
      const items = (pool || []).filter(p => !q || `${p.name} ${p.client} ${p.parents.join(' ')}`.toLowerCase().includes(q)).slice(0, 60);
      els.list.textContent = '';
      items.forEach(p => {
        const o = document.createElement('label');
        o.className = 'opt' + (p.id === chooser.selected ? ' sel' : '');
        o.textContent = p.name;
        const s = document.createElement('small'); s.textContent = `${p.client}${p.parents[0] ? ' · ' + p.parents[0] : ''}`;
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
        const r = await send({ type: 'PM_SWITCH', entryId: res.switchEntryId, projectId: selected, projectKey: issue?.projectKey });
        setBusy(false);
        if (r.error) showMsg(r.error, 'err');
        else { showMsg(`Moved to ${r.project.name} — ${r.project.client}`, 'ok'); status = { ...r.status, goalHours: status?.goalHours || 7 }; }
        renderMeta();
      } else {
        start({ projectId: selected, note });
      }
    }

    // Show on issue pages, hide elsewhere; Jira changes URLs without reloading.
    function sync() {
      const key = JiraUrl.issueKeyFromUrl(location.href);
      if (key === currentKey) return;
      currentKey = key;
      if (!host) { if (!key) return; build(); refreshStatus(); }
      host.style.display = key ? '' : 'none';
      clearMsg(); hideChooser();
      renderMeta();
    }

    return { sync, start, refreshStatus };
  })();

  // Opened from the popup's end-of-day list with "▶": start the timer right away.
  if (location.hash === '#jth-start') {
    history.replaceState(null, '', location.pathname + location.search);
    widget.start();
  }

  browser.storage.local.get('showJiraButton').then(({ showJiraButton }) => {
    if (showJiraButton === false) return;
    widget.sync();
    setInterval(() => widget.sync(), 1000);
    // Keep "today" and the running timer fresh while the page is open. The background
    // caches PM's status for a few minutes, so this is cheap.
    setInterval(() => { if (document.visibilityState === 'visible') widget.refreshStatus(); }, 60 * 1000);
  });
})();
