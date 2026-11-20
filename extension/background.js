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
  // 1. Already have an entry for this ticket? Resume it (unless the user picked a different project).
  const existing = status.entries
    .filter(e => JiraUrl.keysInNote(e.note).includes(issue.key.toUpperCase()))
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

// remember: { type: 'jira', projectKey } | { type: 'email', threadId, addresses, ownDomain }
async function switchProject(entryId, projectId, remember = {}) {
  const after = await PM.setEntryProject(entryId, projectId);
  if (remember.type === 'jira' && remember.projectKey) await PM.rememberChoice(remember.projectKey, projectId);
  if (remember.type === 'email') {
    await PM.rememberEmailChoice(remember, projectId);
    if (remember.threadId) await updateEmailEntry(remember.threadId, { projectId: String(projectId) });
  }
  const projects = await PM.getProjects();
  return {
    project: projects.find(p => p.id === String(projectId)),
    status: recordStatus(after),
    emailEntries: await getEmailEntries(),
  };
}

// ── Email (Gmail) timers ───────────────────────────────────────
// One PM entry per Gmail thread: threadId → { entryId, projectId, note, subject, t }.
// Kept locally so the PM note stays exactly "Correspondence with client about …".
async function getEmailEntries() {
  const { emailEntries = {} } = await browser.storage.local.get('emailEntries');
  return emailEntries;
}

async function updateEmailEntry(threadId, data) {
  const map = await getEmailEntries();
  map[threadId] = { ...(map[threadId] || {}), ...data, t: Date.now() };
  const keep = Object.entries(map).sort((a, b) => b[1].t - a[1].t).slice(0, 300);
  await browser.storage.local.set({ emailEntries: Object.fromEntries(keep) });
  return Object.fromEntries(keep);
}

// email: { threadId, subject, body, addresses, ownDomain }
async function startEmailTimer(email, opts = {}) {
  const status = await getStatus({ force: true });
  const map = await getEmailEntries();
  const known = map[email.threadId];

  // 1. This thread already has a PM entry → resume it.
  const existing = known && status.entries.find(e => e.id === known.entryId);
  if (existing && (!opts.projectId || opts.projectId === existing.projectId)) {
    if (existing.running) return { result: 'already-running', entry: existing, status, emailEntries: map };
    const after = await PM.resumeEntry(await PM.getTimers(), existing.id, known.note);
    return { result: 'resumed', entry: existing, status: recordStatus(after),
      emailEntries: await updateEmailEntry(email.threadId, {}) };
  }

  // 2. Which project? Client from addresses only; AI picks among that client's timers.
  const projects = await PM.getProjects();
  let project = opts.projectId ? projects.find(p => p.id === String(opts.projectId)) : null;
  let how = project ? 'your choice' : null;
  if (!project) {
    const r = await PM.resolveEmailProject(email, status);
    if (r.needsChoice) {
      return { result: 'choose', candidates: r.candidates, all: r.all || projects, suggestedId: null, reason: r.reason };
    }
    ({ project, how } = r);
  }

  // 3. Note: "Correspondence with client about …" (falls back to the bare phrase).
  let note = opts.note;
  let noteWarning = null;
  if (!note) {
    try {
      note = await AI.generateEmailNote(email);
    } catch (e) {
      note = AI.EMAIL_NOTE_BASE;
      noteWarning = `AI note unavailable (${AI.friendlyError(e)}) — used "${AI.EMAIL_NOTE_BASE}".`;
    }
  }

  const created = await PM.createEntry(project.id, note);
  await PM.rememberEmailChoice(email, project.id);
  const emailEntries = await updateEmailEntry(email.threadId, {
    entryId: created.entryId, projectId: project.id, note, subject: (email.subject || '').slice(0, 120),
  });
  const status2 = recordStatus(created.timers);
  return {
    result: 'started', project, how, note, entryId: created.entryId, emailEntries,
    warnings: [
      noteWarning,
      created.noteSaved ? null : "PM didn't keep the note — add it on the Timers page.",
      created.running ? null : "PM shows the new entry as not running — press Start on the Timers page.",
      status2.running.length > 1 ? `${status2.running.length} timers are running in PM — pause the others.` : null,
    ].filter(Boolean),
    status: status2,
  };
}

// Reply sent in a thread → pause that thread's timer if it's the one running.
async function emailSent(threadId) {
  const known = (await getEmailEntries())[threadId];
  if (!known) return { paused: false };
  const timers = await PM.getTimers();
  const entry = timers.entries.find(e => e.id === known.entryId);
  if (!entry?.running) return { paused: false };
  const after = await PM.pauseEntry(timers, entry.id);
  return { paused: true, status: recordStatus(after), emailEntries: await getEmailEntries() };
}

// Pause one running entry (Gmail's round timer button, clicked while running).
async function pauseTimer(entryId) {
  const timers = await PM.getTimers();
  if (!timers.entries.find(e => e.id === entryId)?.running) return { paused: false, status: recordStatus(timers) };
  const after = await PM.pauseEntry(timers, entryId);
  return { paused: true, status: recordStatus(after), emailEntries: await getEmailEntries() };
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
  const running = new Set((status?.running || []).flatMap(r => JiraUrl.keysInNote(r.note)));

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
    .sort((a, b) => (b.running - a.running) || ((b.lastSeen || 0) - (a.lastSeen || 0)) || a.key.localeCompare(b.key));

  return {
    tickets,
    jiraAvailable: jira.ok,
    pmAvailable: !!status,
    todayHours: status?.todayHours ?? null,
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

// ── Fill in blank PM timers ────────────────────────────────────
// For PM entries with time today but no note (timers started straight in PM), write a
// note from the Jira tickets touched today for the same client:
//   - client of each ticket: PM.clientForIssue (no AI); only tickets with no PM time yet
//   - client with several timers: the AI checks which timer each ticket fits
//   - several blank entries on one timer: each ticket goes to the entry whose time
//     today started closest to when the ticket was last opened
//   - note: "<description> (KEY)" or, for several tickets, "<description> (KEY-1, KEY-2)"
// Existing notes are never changed.
async function fillBlankEntries() {
  const status = await getStatus({ force: true });
  const blanks = status.emptyNotesToday || [];
  if (!blanks.length) return { filled: [], left: [] };

  const [projects, today] = await Promise.all([PM.getProjects(), todayTickets()]);
  const byId = Object.fromEntries(projects.map(p => [p.id, p]));
  const open = today.tickets.filter(t => !t.pmMinutes && !t.running && t.summary);

  const clientOf = new Map();
  for (const t of open) {
    const { client } = await PM.clientForIssue(t, status, projects).catch(() => ({}));
    if (client) clientOf.set(t.key, client);
  }

  const pickCache = new Map(); // ticket key → best-fit project id (null = unknown)
  async function fitsTimer(ticket, siblings, projectId) {
    if (!pickCache.has(ticket.key)) pickCache.set(ticket.key, await AI.pickProject(ticket, siblings).catch(() => null));
    const pick = pickCache.get(ticket.key);
    return !pick || pick === projectId; // if the AI can't say, keep it with the client
  }

  const used = new Set();
  const plan = new Map(); // entry id → tickets
  const byProject = {};
  blanks.forEach(b => (byProject[b.projectId] = byProject[b.projectId] || []).push(b));

  for (const [projectId, entries] of Object.entries(byProject)) {
    const project = byId[projectId];
    if (!project) continue;
    const siblings = projects.filter(p => p.client === project.client);
    let candidates = open.filter(t => clientOf.get(t.key) === project.client && !used.has(t.key));
    if (siblings.length > 1) {
      const fits = [];
      for (const t of candidates) if (await fitsTimer(t, siblings, projectId)) fits.push(t);
      candidates = fits;
    }
    for (const t of candidates) {
      const target = entries.length === 1 ? entries[0] : entries.reduce((best, e) => {
        if (!t.lastSeen) return (plan.get(e.id)?.length || 0) < (plan.get(best.id)?.length || 0) ? e : best;
        return Math.abs((e.firstStart || 0) - t.lastSeen) < Math.abs((best.firstStart || 0) - t.lastSeen) ? e : best;
      });
      plan.set(target.id, [...(plan.get(target.id) || []), t]);
      used.add(t.key);
    }
  }

  const notes = {};
  const filled = [];
  for (const b of blanks) {
    const tickets = (plan.get(b.id) || []).sort((x, y) => (x.lastSeen || 0) - (y.lastSeen || 0)); // order worked
    if (!tickets.length) continue;
    const keys = tickets.map(t => t.key);
    let note;
    try {
      note = await AI.generateCombinedEntry(tickets);
    } catch {
      note = tickets.length === 1 ? AI.fallbackEntry(tickets[0]) : `${tickets.map(t => t.summary).join('; ')} (${keys.join(', ')})`;
    }
    notes[b.id] = note;
    filled.push({ id: b.id, projectName: b.projectName, client: b.client, note, keys });
  }
  if (filled.length) recordStatus(await PM.setNotes(notes));
  const left = blanks.filter(b => !notes[b.id]).map(b => ({ id: b.id, projectName: b.projectName, client: b.client, minutes: b.minutes }));
  return { filled, left };
}

async function endOfDayCheck({ force = false } = {}) {
  const nowD = new Date();
  if (!force) {
    if (nowD.getDay() === 0 || nowD.getDay() === 6) return; // weekdays only
    // Alarms fire late after sleep; don't act the next morning on "today".
    const { eodTime = EOD_DEFAULT } = await browser.storage.local.get('eodTime');
    const [h, m] = String(eodTime).split(':').map(Number);
    if (nowD.getHours() * 60 + nowD.getMinutes() < (h || 16) * 60 + (m || 0)) return;
  }
  let fill = { filled: [], left: [] };
  let fillError = null;
  try { fill = await fillBlankEntries(); } catch (e) { fillError = e.message || String(e); }

  const { dailyGoalHours } = await browser.storage.local.get('dailyGoalHours');
  const goal = Number(dailyGoalHours) || 6.5;
  const hours = statusCache?.status?.todayHours ?? null;
  const under = hours != null && hours < goal;
  if (!force && !fill.filled.length && !fill.left.length && !under && !fillError) return;

  const parts = [];
  if (fill.filled.length) {
    parts.push(`Filled ${fill.filled.length} blank PM timer${fill.filled.length === 1 ? '' : 's'}: ` +
      fill.filled.map(f => f.keys.join(', ')).join('; ') + '.');
  }
  if (fill.left.length) {
    parts.push(`${fill.left.length} blank timer${fill.left.length === 1 ? '' : 's'} had no matching Jira ticket: ` +
      fill.left.map(l => l.projectName).join(', ') + '.');
  }
  if (fillError) parts.push(`Couldn't fill blank timers: ${fillError}`);
  if (hours != null) parts.push(`Today: ${hours.toFixed(1)} / ${goal} h in PM.`);
  if (!parts.length) parts.push('Nothing to fill in.');
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

// ── Pause timers left running after hours ──────────────────────
// After the cutoff (default 5:00 pm, weekdays), a timer that was already running before
// the cutoff is paused once today's total reaches the daily goal. Timers started after
// the cutoff are deliberate late work and are left alone (so is a timer resumed after an
// auto-pause). A warning comes 5 minutes ahead; clicking it keeps today's timers running.
// Only works while Firefox is open: a pause after sleep is recorded by PM at that moment.
const PAUSE_AFTER_DEFAULT = '17:00';
const PAUSE_WARN_MS = 5 * 60 * 1000;
const pauseHandled = new Set(); // "<entryId>@<startedAt>" already warned / paused / failed
const pauseWarned  = new Set();

function cutoffOn(ms, time) {
  const [h, m] = String(time || PAUSE_AFTER_DEFAULT).split(':').map(Number);
  const d = new Date(ms); d.setHours(h ?? 17, m || 0, 0, 0);
  return d.getTime();
}
const isWeekday = ms => ![0, 6].includes(new Date(ms).getDay());
const segKey = r => `${r.id}@${r.startedAt}`;
const fmtClock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// When each covered running timer should be paused. Today's total grows by one minute
// per minute for every running timer (covered or not).
function pausePlan(status, goalHours, time, now = Date.now()) {
  const running = (status?.running || []).filter(r => r.startedAt);
  if (!running.length) return [];
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  const loggedMs = (status.todayHours || 0) * 3600e3 + running.length * Math.max(0, now - status.fetchedAt);
  const reachesGoal = now + (goalHours * 3600e3 - loggedMs) / running.length;
  return running.flatMap(r => {
    const cut = cutoffOn(r.startedAt, time);
    if (!isWeekday(r.startedAt) || r.startedAt >= cut) return []; // started after hours: leave it
    if (r.startedAt < midnight.getTime()) return [{ r, due: cut, overnight: true }]; // left on since a past day
    return [{ r, due: Math.max(cut, reachesGoal), overnight: false }];
  });
}

async function autoPauseCheck() {
  const { autoPause = true, pauseAfter = PAUSE_AFTER_DEFAULT, autoPauseSkip = null, dailyGoalHours } =
    await browser.storage.local.get(['autoPause', 'pauseAfter', 'autoPauseSkip', 'dailyGoalHours']);
  if (!autoPause || !statusCache) return;
  const goal = Number(dailyGoalHours) || 6.5;
  const wanted = p => !pauseHandled.has(segKey(p.r)) && localDay(new Date(p.r.startedAt)) !== autoPauseSkip;

  let plan = pausePlan(statusCache.status, goal, pauseAfter).filter(wanted);
  if (!plan.length || Math.min(...plan.map(p => p.due)) - Date.now() > PAUSE_WARN_MS) return;

  // Close to (or past) due: re-read PM — the timer may have been paused or switched there.
  const anyDue = plan.some(p => p.due <= Date.now());
  const status = await getStatus({ force: anyDue });
  const now = Date.now();
  plan = pausePlan(status, goal, pauseAfter, now).filter(wanted);
  const due = plan.filter(p => p.due <= now);

  if (!due.length) {
    const soon = plan.filter(p => !pauseWarned.has(segKey(p.r)));
    if (!soon.length) return;
    soon.forEach(p => pauseWarned.add(segKey(p.r)));
    const at = Math.min(...soon.map(p => p.due));
    await browser.notifications.create('autopause-warn', {
      type: 'basic',
      iconUrl: browser.runtime.getURL('icons/icon96.png'),
      title: `Pausing PM timer at ${fmtClock(at)}`,
      message: `${soon.map(p => p.r.note || p.r.projectName).join('; ')} — today will have ${goal} h logged. ` +
        'Click this to keep it running tonight.',
    });
    return;
  }

  let timers = await PM.getTimers();
  const paused = [], failed = [];
  for (const p of due) {
    pauseHandled.add(segKey(p.r));
    try { timers = await PM.pauseEntry(timers, p.r.id); paused.push(p); }
    catch (e) { failed.push({ ...p, error: e.message || String(e) }); }
  }
  let after = recordStatus(timers);

  // A blank timer gets its note now rather than waiting for tomorrow's end-of-day run.
  let filled = [];
  if (paused.some(p => !p.r.note)) {
    try { filled = (await fillBlankEntries()).filled; after = statusCache?.status || after; } catch { /* leave blank */ }
  }

  const parts = [];
  if (paused.length) {
    parts.push(`Paused ${paused.map(p => p.r.note || p.r.projectName).join('; ')}. ` +
      `${(after.todayHours || 0).toFixed(1)} h logged today.`);
    paused.forEach(p => {
      if (p.overnight) parts.push(`It had been running since ${new Date(p.r.startedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} — trim the extra time in PM.`);
      else if (now - p.due > 10 * 60 * 1000) parts.push(`It ran ${formatElapsed(now - p.due)} past ${fmtClock(p.due)} while Firefox was closed or asleep — trim that in PM.`);
    });
  }
  filled.forEach(f => parts.push(`Note added: ${f.note}`));
  failed.forEach(f => parts.push(`Couldn't pause ${f.r.note || f.r.projectName}: ${f.error}`));
  await browser.notifications.clear('autopause-warn');
  await browser.notifications.create('autopause', {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon96.png'),
    title: failed.length && !paused.length ? "Couldn't pause PM timer" : 'Paused PM timer for the day',
    message: parts.join(' '),
  });
}

// Clicking the warning keeps timers started today running tonight.
browser.notifications.onClicked.addListener(async (id) => {
  if (id !== 'autopause-warn') return;
  await browser.storage.local.set({ autoPauseSkip: localDay() });
  await browser.notifications.clear('autopause-warn');
  await browser.notifications.create('autopause', {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon96.png'),
    title: 'Timer keeps running',
    message: "Today's timers won't be paused automatically. Remember to pause it in PM.",
  });
});

// ── Messages from the content script and popup ────────────────
function errorPayload(e) {
  return {
    error: e instanceof PM.PmAuthError ? e.message : (e?.status ? AI.friendlyError(e) : (e?.message || String(e))),
    signIn: e instanceof PM.PmAuthError,
  };
}

browser.runtime.onMessage.addListener((msg) => {
  const handlers = {
    PM_STATUS:      async () => ({ status: await getStatus({ force: !!msg.force }), emailEntries: await getEmailEntries() }),
    PM_START:       () => startTimer(msg.issue, { projectId: msg.projectId, note: msg.note }),
    PM_START_EMAIL: () => startEmailTimer(msg.email, { projectId: msg.projectId, note: msg.note }),
    PM_EMAIL_SENT:  () => emailSent(msg.threadId),
    PM_PAUSE:       () => pauseTimer(msg.entryId),
    PM_SWITCH:      () => switchProject(msg.entryId, msg.projectId, msg.remember),
    PM_PROJECTS:    () => PM.getProjects({ force: !!msg.force }).then(projects => ({ projects })),
    PM_OPEN:        () => browser.tabs.create({ url: `${PM.ORIGIN}/system/` }).then(() => ({})),
    TODAY_TICKETS:  () => todayTickets(),
    TODAY_DISMISS:  () => dismissTicket(msg.key),
    EOD_TEST:       () => endOfDayCheck({ force: true }).then(() => ({})),
    FILL_BLANKS:    () => fillBlankEntries(),
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
  await autoPauseCheck().catch(() => {});
});
