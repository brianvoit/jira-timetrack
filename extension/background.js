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
  if (alarm.name !== 'pm-tick') return;
  if (Date.now() - lastPoll >= POLL_EVERY_MIN * 60 * 1000) {
    lastPoll = Date.now();
    try { await getStatus({ force: true }); } catch { updateBadge(null); }
  } else if (statusCache) {
    updateBadge(statusCache.status);
  }
});
