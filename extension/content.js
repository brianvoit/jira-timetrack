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

  // ── The Start timer button (shared widget, lib/widget.js) ─────
  const widget = TimerWidget.createWidget({
    currentKey: () => JiraUrl.issueKeyFromUrl(location.href),
    label: key => key,
    read: async () => {
      const issue = await readIssue();
      if (!issue.key) throw new Error('Open an issue first.');
      return issue;
    },
    startMessage: (issue, opts) => ({ type: 'PM_START', issue, ...opts }),
    runningFor: (status, key) => status.running.find(r => JiraUrl.keysInNote(r.note).includes(key)),
    remember: issue => ({ type: 'jira', projectKey: issue?.projectKey }),
  });

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
