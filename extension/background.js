// background.js — runs the PM timer flow for the Jira button and popup, and keeps
// the toolbar badge showing the running PM timer.

const STATUS_TTL_MS   = 3 * 60 * 1000;  // reuse a fresh status for this long (PM's page is ~500 KB)
const POLL_EVERY_MIN  = 10;             // re-read PM in the background this often

let statusCache = null; // { status, at }

// ── Badge ──────────────────────────────────────────────────────
function formatElapsed(ms) {
  const mins = Math.max(0, Math.floor(ms / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}

function updateBadge(status) {
  let text = '', color = '#16a34a', title = 'Jira Time Helper';
  if (status) {
    const running = status.running || [];
    if (running.some(r => r.runaway)) {
      text = '!'; color = '#dc2626'; title = 'A PM timer has been running a long time — check it.';
    } else if (running.length > 1) {
      text = String(running.length); color = '#d97706'; title = `${running.length} PM timers are running.`;
    } else if (running.length === 1) {
      const r = running[0];
      text = r.startedAt ? formatElapsed(Date.now() - r.startedAt) : '●';
      title = `Timing: ${r.note || r.projectName}`;
    }
  }
  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color });
  browser.browserAction.setTitle({ title });
}

// ── Status ─────────────────────────────────────────────────────
function recordStatus(timers) {
  const status = PM.summarize(timers);
  statusCache = { status, at: Date.now() };
  updateBadge(status);
  return status;
}

async function getStatus({ force = false } = {}) {
  if (!force && statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.status;
  return recordStatus(await PM.getTimers());
}

// ── Start a timer for a Jira issue ─────────────────────────────
// issue: { key, projectKey, projectName, summary, description }
// opts:  { projectId?, note? } — projectId when the user picked one; note when edited in the popup.
async function startTimer(issue, opts = {}) {
  const status = await getStatus({ force: true });
  const tag = `(${issue.key})`;

  // 1. Already have an entry for this ticket? Resume it (unless the user picked a different project).
  const existing = status.entries
    .filter(e => e.note.toUpperCase().includes(tag.toUpperCase()))
    .sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (existing && (!opts.projectId || opts.projectId === existing.projectId)) {
    if (existing.running) return { result: 'already-running', entry: existing, status };
    const timers = await PM.getTimers();
    const after = await PM.resumeEntry(timers, existing.id, opts.note);
    return { result: 'resumed', entry: existing, status: recordStatus(after) };
  }

  // 2. Which project?
  const projects = await PM.getProjects();
  let project = opts.projectId ? projects.find(p => p.id === String(opts.projectId)) : null;
  let how = project ? 'your choice' : null;
  if (!project) {
    const r = await PM.resolveProject(issue, status);
    if (r.needsChoice) {
      return { result: 'choose', candidates: r.candidates, all: r.all || projects, suggestedId: r.suggestedId, reason: r.reason };
    }
    ({ project, how } = r);
  }

  // 3. Note — fall back to the ticket title if the AI is unavailable, so the timer still starts.
  let note = opts.note;
  let noteWarning = null;
  if (!note) {
    try {
      note = (await AI.generateEntry(issue)).text;
    } catch (e) {
      note = AI.fallbackEntry(issue) || issue.key;
      noteWarning = `AI note unavailable (${AI.friendlyError(e)}) — used the ticket title.`;
    }
  }

  const created = await PM.createEntry(project.id, note);
  await PM.rememberChoice(issue.projectKey, project.id);
  const status2 = recordStatus(created.timers);
  return {
    result: 'started',
    project, how, note,
    entryId: created.entryId,
    warnings: [
      noteWarning,
      created.noteSaved ? null : "PM didn't keep the note — add it on the Timers page.",
      created.running ? null : "PM shows the new entry as not running — press Start on the Timers page.",
      status2.running.length > 1 ? `${status2.running.length} timers are running in PM — pause the others.` : null,
    ].filter(Boolean),
    status: status2,
  };
}

async function switchProject(entryId, projectId, projectKey) {
  const after = await PM.setEntryProject(entryId, projectId);
  if (projectKey) await PM.rememberChoice(projectKey, projectId);
  const projects = await PM.getProjects();
  return { project: projects.find(p => p.id === String(projectId)), status: recordStatus(after) };
}

// ── Today's Jira tickets vs PM time ────────────────────────────
const pad2 = n => String(n).padStart(2, '0');
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Local log of Jira issues opened, per day (kept 7 days). Complements Jira's own
// "viewed today" search, and works when no Jira tab is open.
async function recordVisit(url) {
  if (!JiraUrl.isJiraUrl(url)) return;
  const key = JiraUrl.issueKeyFromUrl(url);
  if (!key) return;
  const day = localDay();
  const { jiraVisits = {} } = await browser.storage.local.get('jiraVisits');
  const today = jiraVisits[day] || (jiraVisits[day] = {});
  const v = today[key] || (today[key] = { first: Date.now(), n: 0 });
  v.last = Date.now();
  v.n += 1;
  v.base = new URL(url).origin; // to build ticket links later
  const keep = Object.keys(jiraVisits).sort().slice(-7);
  await browser.storage.local.set({ jiraVisits: Object.fromEntries(keep.map(d => [d, jiraVisits[d]])) });
}

browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) recordVisit(info.url).catch(() => {});
}, { properties: ['url'] });

// Ask a Jira tab's content script for today's issues (it has the Jira session).
async function jiraToday(keys) {
  const tabs = (await browser.tabs.query({})).filter(t => t.url && JiraUrl.isJiraUrl(t.url));
  tabs.sort((a, b) => (b.active - a.active) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const tab of tabs) {
    try {
      const res = await browser.tabs.sendMessage(tab.id, { type: 'JIRA_TODAY', keys });
      if (res?.ok) return res;
    } catch { /* tab without a live content script — try the next one */ }
  }
  return { ok: false, issues: [] };
}

// Every ticket touched today (Jira search + local visits + PM time), with PM minutes.
async function todayTickets() {
  const day = localDay();
  const [{ jiraVisits = {}, dismissedTickets = {} }, status] = await Promise.all([
    browser.storage.local.get(['jiraVisits', 'dismissedTickets']),
    getStatus().catch(() => null),
  ]);
  const visits = jiraVisits[day] || {};
  const dismissed = new Set(dismissedTickets[day] || []);
  const pm = status?.minutesByKey || {};
  const running = new Set((status?.running || []).flatMap(r =>
    [...(r.note || '').matchAll(/\(([A-Z][A-Z0-9_]+-\d+)\)/gi)].map(m => m[1].toUpperCase())));

  const jira = await jiraToday(Object.keys(visits));
  const byKey = {};
  const add = (key, extra) => { byKey[key] = { key, ...(byKey[key] || {}), ...extra }; };
  jira.issues.forEach(i => add(i.key, { ...i, source: i.source || 'jira' }));
  Object.entries(visits).forEach(([key, v]) => add(key, { lastSeen: v.last, base: byKey[key]?.base || v.base }));
  Object.keys(pm).forEach(key => { if (pm[key] > 0) add(key, {}); });

  const tickets = Object.values(byKey)
    .filter(t => !dismissed.has(t.key))
    .map(t => ({
      ...t,
      projectKey: t.projectKey || JiraUrl.projectKeyOf(t.key),
      base: t.base || jira.base || null,
      pmMinutes: pm[t.key] || 0,
      running: running.has(t.key),
    }))
    .sort((a, b) =>
      ((a.pmMinutes > 0 || a.running) - (b.pmMinutes > 0 || b.running)) ||
      ((b.lastSeen || 0) - (a.lastSeen || 0)) || a.key.localeCompare(b.key));

  return {
    tickets,
    jiraAvailable: jira.ok,
    pmAvailable: !!status,
    todayBillableHours: status?.todayBillableHours ?? null,
  };
}

async function dismissTicket(key) {
  const day = localDay();
  const { dismissedTickets = {} } = await browser.storage.local.get('dismissedTickets');
  dismissedTickets[day] = [...new Set([...(dismissedTickets[day] || []), key])];
  const keep = Object.keys(dismissedTickets).sort().slice(-3);
  await browser.storage.local.set({ dismissedTickets: Object.fromEntries(keep.map(d => [d, dismissedTickets[d]])) });
  return {};
}

// ── End-of-day reminder ────────────────────────────────────────
const EOD_DEFAULT = '16:30';

async function scheduleEod() {
  const { eodEnabled = true, eodTime = EOD_DEFAULT } = await browser.storage.local.get(['eodEnabled', 'eodTime']);
  await browser.alarms.clear('eod');
  if (!eodEnabled) return;
  const [h, m] = String(eodTime).split(':').map(Number);
  const next = new Date(); next.setHours(h || 16, m || 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  browser.alarms.create('eod', { when: next.getTime() });
}

async function endOfDayCheck({ force = false } = {}) {
  const nowD = new Date();
  if (!force) {
    if (nowD.getDay() === 0 || nowD.getDay() === 6) return; // weekdays only
    // Alarms fire late after sleep; don't nag the next morning about "today".
    const { eodTime = EOD_DEFAULT } = await browser.storage.local.get('eodTime');
    const [h, m] = String(eodTime).split(':').map(Number);
    if (nowD.getHours() * 60 + nowD.getMinutes() < (h || 16) * 60 + (m || 0)) return;
  }
  const [{ dailyGoalHours }, today] = await Promise.all([
    browser.storage.local.get('dailyGoalHours'),
    todayTickets(),
  ]);
  const goal = Number(dailyGoalHours) || 7;
  const gaps = today.tickets.filter(t => !t.pmMinutes && !t.running);
  const hours = today.todayBillableHours;
  const under = hours != null && hours < goal;
  if (!under && !gaps.length && !force) return;
  const parts = [];
  if (hours != null) parts.push(`Today: ${hours.toFixed(1)} / ${goal} h in PM.`);
  if (gaps.length) {
    parts.push(`${gaps.length} Jira ticket${gaps.length === 1 ? '' : 's'} without PM time: ` +
      gaps.slice(0, 4).map(t => t.key).join(', ') + (gaps.length > 4 ? '…' : '') + '.');
    parts.push('Open Jira Time Helper to log them.');
  } else if (!under) {
    parts.push('Every ticket you touched today has PM time.');
  }
  await browser.notifications.create('eod', {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon96.png'),
    title: 'End-of-day time check',
    message: parts.join(' '),
  });
}

browser.storage.onChanged.addListener((changes) => {
  if (changes.eodEnabled || changes.eodTime) scheduleEod();
});
scheduleEod();

// ── Messages from the content script and popup ────────────────
function errorPayload(e) {
  return {
    error: e instanceof PM.PmAuthError ? e.message : (e?.status ? AI.friendlyError(e) : (e?.message || String(e))),
    signIn: e instanceof PM.PmAuthError,
  };
}

browser.runtime.onMessage.addListener((msg) => {
  const handlers = {
    PM_STATUS:      () => getStatus({ force: !!msg.force }).then(status => ({ status })),
    PM_START:       () => startTimer(msg.issue, { projectId: msg.projectId, note: msg.note }),
    PM_SWITCH:      () => switchProject(msg.entryId, msg.projectId, msg.projectKey),
    PM_PROJECTS:    () => PM.getProjects({ force: !!msg.force }).then(projects => ({ projects })),
    PM_OPEN:        () => browser.tabs.create({ url: `${PM.ORIGIN}/system/` }).then(() => ({})),
    TODAY_TICKETS:  () => todayTickets(),
    TODAY_DISMISS:  () => dismissTicket(msg.key),
    EOD_TEST:       () => endOfDayCheck({ force: true }).then(() => ({})),
  };
  const handler = handlers[msg?.type];
  if (!handler) return; // not ours (e.g. SCRAPE_JIRA goes to content scripts)
  return handler().catch(errorPayload);
});

// ── Background refresh ─────────────────────────────────────────
// Every minute: tick the badge clock. Every POLL_EVERY_MIN: re-read PM.
let lastPoll = 0;
browser.alarms.create('pm-tick', { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'eod') {
    await endOfDayCheck().catch(() => {});
    await scheduleEod(); // tomorrow
    return;
  }
  if (alarm.name !== 'pm-tick') return;
  if (Date.now() - lastPoll >= POLL_EVERY_MIN * 60 * 1000) {
    lastPoll = Date.now();
    try { await getStatus({ force: true }); } catch { updateBadge(null); }
  } else if (statusCache) {
    updateBadge(statusCache.status);
  }
});
