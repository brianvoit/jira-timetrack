// lib/pm.js — client for pm.plaudit.com, Plaudit's project-management / time system.
// Runs in the background page (needs DOMParser + the pm.plaudit.com host permission).
//
// How PM works (learned from its Timers and Tree pages):
// - A time entry = project + note + a list of start/stop segments. Pressing an
//   entry's Start button resumes it; with "Pause running" checked, PM pauses
//   whatever else is running at the same time.
// - Every button on the Timers page submits the WHOLE form to time.php (all notes,
//   projects, users, billable flags). So we always replay the full form exactly
//   as the browser would for a real click, and never post a partial form.
// - GET time.php?new_project=<projectId> creates a new entry for that project
//   (it's what the stopwatch icon in the project tree does).
(() => {
  if (globalThis.PM) return;

  const ORIGIN      = 'https://pm.plaudit.com';
  const BASE        = `${ORIGIN}/system/`;
  const TIMERS_PATH = 'time.php';
  const TREE_PATH   = 'iframes/projectView/tree.php';
  const PROJECTS_TTL_MS = 12 * 60 * 60 * 1000;

  class PmAuthError extends Error {}

  // ── Transport ───────────────────────────────────────────────
  // Requests go straight from the background page using the PM session cookie.
  // If that comes back as the sign-in page (e.g. the cookie isn't sent to
  // extension requests), retry from inside an open pm.plaudit.com tab.
  let viaTab = false;

  function looksLikeSignIn(url, html) {
    if (/\/login\.php/i.test(url)) return true;
    return /Sign in with OAuth/i.test(html) && !/listOfTimeEntries|id="projectTree"/.test(html);
  }

  async function directFetch(url, init) {
    const r = await fetch(url, { credentials: 'include', ...init });
    return { url: r.url, status: r.status, html: await r.text() };
  }

  async function tabFetch(url, init) {
    const tabs = await browser.tabs.query({ url: `${ORIGIN}/*` });
    if (!tabs.length) return null;
    const code = `(async () => {
      const r = await content.fetch(${JSON.stringify(url)},
        Object.assign({ credentials: 'include' }, ${JSON.stringify(init || {})}));
      return { url: r.url, status: r.status, html: await r.text() };
    })();`;
    const [res] = await browser.tabs.executeScript(tabs[0].id, { code });
    return res;
  }

  // After we change something in PM, reload any open PM tabs. Every PM button resubmits the
  // whole page (all notes), so a tab still showing old values would undo our change the next
  // time it's used. The reload waits until our requests have gone quiet, so it never lands
  // mid-sequence (we may be sending requests through that tab). PM's own "leave without
  // saving?" prompt still protects anything being edited there.
  const RELOAD_QUIET_MS = 1500;
  let reloadPending = false, reloadTimer = null, inFlight = 0;

  function armReload() {
    clearTimeout(reloadTimer);
    if (!reloadPending || inFlight) return;
    reloadTimer = setTimeout(async () => {
      if (inFlight) return;
      reloadPending = false;
      try {
        const tabs = await browser.tabs.query({ url: `${ORIGIN}/*` });
        tabs.forEach(t => browser.tabs.reload(t.id).catch(() => {}));
      } catch { /* no PM tabs, or no access */ }
    }, RELOAD_QUIET_MS);
  }

  const isWrite = (path, init) =>
    String(init?.method || 'GET').toUpperCase() === 'POST' || /[?&]new_project=/.test(path);

  async function request(path, init) {
    inFlight++;
    clearTimeout(reloadTimer);
    try {
      const res = await send(path, init);
      if (isWrite(path, init)) reloadPending = true;
      return res;
    } finally {
      inFlight--;
      armReload();
    }
  }

  async function send(path, init) {
    const url = new URL(path, BASE).href;
    if (!viaTab) {
      const res = await directFetch(url, init);
      if (!looksLikeSignIn(res.url, res.html)) return res;
    }
    // A sign-in redirect means the request was not applied, so retrying is safe.
    const res = await tabFetch(url, init).catch(() => null);
    if (res && !looksLikeSignIn(res.url, res.html)) { viaTab = true; return res; }
    viaTab = false;
    throw new PmAuthError('Not signed in to PM — open pm.plaudit.com, sign in, then try again.');
  }

  // ── Parsing the Timers page ─────────────────────────────────
  const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;

  function parseLocalDate(s) {
    const [d, t] = s.split(' ');
    const [y, mo, day] = d.split('-').map(Number);
    const [h, mi, se = 0] = t.split(':').map(Number);
    return new Date(y, mo - 1, day, h, mi, se);
  }

  function parseTimers(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const form = [...doc.forms].find(f =>
      /time\.php/i.test(f.getAttribute('action') || '') &&
      (f.getAttribute('method') || '').toUpperCase() === 'POST');
    if (!form) throw new Error("Couldn't read PM's Timers page — its layout may have changed.");

    const entries = [...form.querySelectorAll('textarea[name^="note_"]')].map(ta => {
      const id = ta.getAttribute('name').slice('note_'.length);
      const box = ta.closest('table.timeEntry');
      const title = box?.querySelector('.timer-title');
      const segments = [...(box?.querySelectorAll('table.timeEntryDetails tbody tr') || [])]
        .map(tr => {
          const cells = [...tr.children].map(td => td.textContent.trim());
          if (!DATE_RE.test(cells[0] || '')) return null;
          return {
            start: cells[0],
            stop: DATE_RE.test(cells[1] || '') ? cells[1] : null,
            minutes: parseInt(cells[2], 10) || 0,
          };
        })
        .filter(Boolean);
      const total = box?.querySelector('.totalTimeOnEntry')?.textContent.match(/(\d+)\s*min/);
      return {
        id,
        projectId:   doc.getElementById(`project_${id}`)?.getAttribute('value') || '',
        projectName: doc.getElementById(`show_project_${id}`)?.textContent.trim() || '',
        client:      box?.querySelector('.clientName')?.textContent.trim() || '',
        note:        ta.value.trim(),
        running:     !!title?.classList.contains('timerRunning'),
        canStart:    !!form.querySelector(`button[name="start_times_detail_${id}"]`),
        totalMinutes: total ? parseInt(total[1], 10) : 0,
        segments,
      };
    });

    // Quick Report: rows like "Total Billable: | today | week | 30 days"
    const report = {};
    doc.querySelectorAll('fieldset.quickReport tbody tr').forEach(tr => {
      const cells = [...tr.children].map(td => td.textContent.trim());
      if (cells.length < 2) return;
      report[cells[0].replace(/:$/, '').toLowerCase()] = cells.slice(1).map(v => parseFloat(v) || 0);
    });

    return { form, entries, report };
  }

  // Serialises the form the way a browser does for a click on `submitter`.
  function formBody(form, overrides = {}, submitter = null) {
    const p = new URLSearchParams();
    for (const el of form.elements) {
      const name = el.getAttribute('name');
      if (!name || el.disabled) continue;
      const tag = el.tagName;
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'BUTTON' || ['submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
      if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
      if (tag === 'SELECT') {
        const opts = [...el.options];
        const sel = opts.filter(o => o.selected);
        (sel.length ? sel : opts.slice(0, 1)).forEach(o => p.append(name, o.value));
        continue;
      }
      p.append(name, el.value);
    }
    for (const [k, v] of Object.entries(overrides)) p.set(k, v);
    if (submitter) p.append(submitter.name, submitter.value ?? '');
    return p.toString();
  }

  async function getTimers() {
    const res = await request(TIMERS_PATH);
    return parseTimers(res.html);
  }

  async function submit(timers, overrides, submitter) {
    const res = await request(TIMERS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody(timers.form, overrides, submitter),
    });
    return parseTimers(res.html);
  }

  const startButton = id => ({ name: `start_times_detail_${id}`, value: 'Start' });
  const saveButton  = { name: 'submit', value: '' };
  const PAUSE_OTHERS = { isPauseAnyRunningCheckboxPresent: 'yes', pauseAnyRunning: 'yes' };

  // ── Actions ─────────────────────────────────────────────────
  // Resume an existing entry (pausing anything else). Fills the note only if empty.
  async function resumeEntry(timers, entryId, note) {
    const entry = timers.entries.find(e => e.id === entryId);
    if (!entry) throw new Error('That PM entry is no longer on the Timers page.');
    if (entry.running) return timers;
    const overrides = { ...PAUSE_OTHERS };
    if (note && !entry.note) overrides[`note_${entryId}`] = note;
    const after = await submit(timers, overrides, startButton(entryId));
    if (!after.entries.find(e => e.id === entryId)?.running) {
      throw new Error("PM didn't report the timer as running — check the Timers page.");
    }
    return after;
  }

  // Create a new entry on `projectId`, set its note, and make sure it is running.
  async function createEntry(projectId, note) {
    const before = await getTimers();
    const known = new Set(before.entries.map(e => e.id));
    const res = await request(`${TIMERS_PATH}?new_project=${encodeURIComponent(projectId)}`);
    const created = parseTimers(res.html);
    const entry = created.entries
      .filter(e => !known.has(e.id) && e.projectId === String(projectId))
      .sort((a, b) => Number(b.id) - Number(a.id))[0];
    if (!entry) throw new Error("PM didn't create a new timer entry for that project.");

    const after = await submit(
      created,
      { ...PAUSE_OTHERS, [`note_${entry.id}`]: note },
      entry.running ? saveButton : startButton(entry.id)
    );
    const saved = after.entries.find(e => e.id === entry.id);
    if (!saved) throw new Error('The new PM entry disappeared after saving — check the Timers page.');
    return { timers: after, entryId: entry.id, noteSaved: saved.note === note.trim(), running: saved.running };
  }

  // Pause a running entry by pressing its Pause button. Matched by the button's visible
  // text/value only — never by name, because PM's Stop button is named "stopPaused_…".
  async function pauseEntry(timers, entryId) {
    const box = timers.form.querySelector(`textarea[name="note_${entryId}"]`)?.closest('table.timeEntry');
    const btn = [...(box?.querySelectorAll('button') || [])].find(b =>
      /^\s*pause\s*$/i.test(b.textContent) || /^\s*pause\s*$/i.test(b.getAttribute('value') || ''));
    if (!btn) throw new Error("Couldn't find PM's Pause button for this timer — pause it on the Timers page.");
    const after = await submit(timers, {}, { name: btn.getAttribute('name'), value: btn.getAttribute('value') ?? '' });
    if (after.entries.find(e => e.id === entryId)?.running) {
      throw new Error('PM still shows the timer running — pause it on the Timers page.');
    }
    return after;
  }

  // Move an entry to another project (PM's "Switch Timer").
  async function setEntryProject(entryId, projectId) {
    const timers = await getTimers();
    if (!timers.entries.some(e => e.id === entryId)) {
      throw new Error('That PM entry is no longer on the Timers page.');
    }
    const after = await submit(timers, { [`project_${entryId}`]: String(projectId) }, saveButton);
    if (after.entries.find(e => e.id === entryId)?.projectId !== String(projectId)) {
      throw new Error("PM didn't accept the project change — check the Timers page.");
    }
    return after;
  }

  // ── Status for the badge, popup and Jira button ─────────────
  function summarize(timers) {
    const now = Date.now();
    const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
    const running = timers.entries.filter(e => e.running).map(e => {
      const open = e.segments.find(s => !s.stop);
      const startedAt = open ? parseLocalDate(open.start).getTime() : null;
      return {
        id: e.id, projectId: e.projectId, projectName: e.projectName, client: e.client, note: e.note,
        startedAt,
        runaway: !!startedAt && (now - startedAt > 4 * 3600e3 || startedAt < midnight.getTime()),
      };
    });
    const localToday = `${midnight.getFullYear()}-${String(midnight.getMonth() + 1).padStart(2, '0')}-${String(midnight.getDate()).padStart(2, '0')}`;
    const midMs = midnight.getTime();
    // Minutes an entry has today, and when its first segment today started.
    function today(e) {
      let ms = 0, first = null;
      e.segments.forEach(s => {
        const a = parseLocalDate(s.start).getTime();
        const b = s.stop ? parseLocalDate(s.stop).getTime() : now; // open segment = running
        const overlap = Math.min(b, now) - Math.max(a, midMs);
        if (overlap > 0) { ms += overlap; first = Math.min(first ?? Infinity, Math.max(a, midMs)); }
      });
      return { minutes: Math.round(ms / 60000), firstStart: first };
    }
    // Entries with time today but no note — what end-of-day fill-in completes.
    const emptyNotesToday = timers.entries
      .filter(e => !e.note && e.segments.some(s => s.start.startsWith(localToday) || (s.stop || '').startsWith(localToday)))
      .map(e => ({ id: e.id, projectId: e.projectId, projectName: e.projectName, client: e.client, running: e.running, ...today(e) }));
    // Minutes logged today per Jira key, from notes ending in "(KEY-123)" or "(KEY-1, KEY-2)".
    const minutesByKey = {};
    timers.entries.forEach(e => {
      const keys = JiraUrl.keysInNote(e.note);
      if (!keys.length) return;
      const mins = today(e).minutes;
      keys.forEach(k => { minutesByKey[k] = (minutesByKey[k] || 0) + mins; });
    });

    return {
      // Every timer's time today (running ones up to now), billable or not.
      todayHours: timers.entries.reduce((sum, e) => sum + today(e).minutes, 0) / 60,
      running,
      emptyNotesToday,
      minutesByKey,
      entries: timers.entries.map(({ id, projectId, projectName, client, note, running: r }) =>
        ({ id, projectId, projectName, client, note, running: r })),
      fetchedAt: now,
    };
  }

  // ── Projects (from the project tree) ────────────────────────
  async function getProjects({ force = false } = {}) {
    if (!force) {
      const { pmProjects } = await browser.storage.local.get('pmProjects');
      if (pmProjects && Date.now() - pmProjects.t < PROJECTS_TTL_MS) return pmProjects.list;
    }
    const res = await request(TREE_PATH);
    const doc = new DOMParser().parseFromString(res.html, 'text/html');
    const rows = [...doc.querySelectorAll('tr[treenodeid^="project_"]')];
    if (!rows.length) throw new Error("Couldn't read PM's project list — its layout may have changed.");
    const nameOf = {};
    const info = rows.map(tr => {
      const id = tr.getAttribute('treenodeid').slice('project_'.length);
      const cells = tr.querySelectorAll('td');
      // Leaf projects show their name as a link; parent folders (e.g. "smartvest.com -
      // Google Ads") show it as plain text. The name cell's text covers both.
      const name = (tr.querySelector('td.projectName')?.textContent || '').replace(/\s+/g, ' ').trim();
      nameOf[id] = name;
      return {
        id, name,
        client: (cells[cells.length - 1]?.textContent || '').trim(),
        path: (tr.getAttribute('treenodepath') || '/').split('/').filter(Boolean).map(s => s.replace('project_', '')),
        hasTimer: !!tr.querySelector('a[href*="new_project="]'),
      };
    });
    const list = info.filter(p => p.hasTimer).map(p => ({
      id: p.id, name: p.name, client: p.client,
      parents: p.path.map(pid => nameOf[pid]).filter(Boolean).reverse(), // nearest parent first
    }));
    await browser.storage.local.set({ pmProjects: { t: Date.now(), list } });
    return list;
  }

  // ── Which project does a Jira issue belong to? ──────────────
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const tokens = s => (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

  // How strongly a project's client/site names point at this Jira project.
  function clientScore(p, issue) {
    const key = (issue.projectKey || '').toLowerCase();
    const jname = norm(issue.projectName);
    const texts = [p.client, ...p.parents];
    let score = 0;
    texts.forEach((t, i) => {
      const toks = tokens(t);
      const isClient = i === 0;
      // Jira key matches a site/client word: SMARTVEST ~ smartvest.com, ROCHPH ~ rochph.com, PHI ~ PHI.com
      if (key.length >= 3 && toks.some(w => w === key || (key.length >= 4 && w.startsWith(key)))) score = Math.max(score, 3);
      // Jira project name appears in the client/site name: "Medical Alley" ~ "medicalalley.org - Website Redesign"
      if (jname.length >= 4 && norm(t).includes(jname)) score = Math.max(score, 3);
      // Client name appears in the Jira project name: "Sound Physicians" ~ "Sound Physicians - SEO"
      if (isClient && norm(t).length >= 6 && jname.includes(norm(t))) score = Math.max(score, 3);
      // Initials of the client: MRO ~ "Midwest Reliability Organization"
      if (isClient && key.length >= 3 && toks.map(w => w[0]).join('').startsWith(key)) score = Math.max(score, 2);
    });
    return score;
  }

  // Which PM client a Jira issue belongs to — from remembered choices, past PM notes for
  // this Jira project, and name matching. No AI. client is null when unclear.
  async function clientForIssue(issue, status, projects) {
    projects = projects || await getProjects();
    const byId = Object.fromEntries(projects.map(p => [p.id, p]));
    const { pmMap = {} } = await browser.storage.local.get('pmMap');
    const remembered = pmMap[issue.projectKey] || null;
    const history = (status?.entries || []).filter(e =>
      byId[e.projectId] && JiraUrl.keysInNote(e.note).some(k => JiraUrl.projectKeyOf(k) === issue.projectKey));

    const clientVotes = {};
    const vote = (client, n) => { if (client) clientVotes[client] = (clientVotes[client] || 0) + n; };
    if (remembered && byId[remembered.projectId]) vote(byId[remembered.projectId].client, 5);
    history.forEach(e => vote(byId[e.projectId].client, 2));
    projects.forEach(p => vote(p.client, clientScore(p, issue)));

    const ranked = Object.entries(clientVotes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const client = ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
    return { client, remembered, history };
  }

  // Write notes on several entries in one save (Refresh / Save). Only the given notes change.
  async function setNotes(notesById) {
    const ids = Object.keys(notesById);
    if (!ids.length) return null;
    const timers = await getTimers();
    const overrides = {};
    ids.forEach(id => {
      if (!timers.entries.some(e => e.id === id)) throw new Error('A PM entry is no longer on the Timers page.');
      overrides[`note_${id}`] = notesById[id];
    });
    const after = await submit(timers, overrides, saveButton);
    const missed = ids.filter(id => after.entries.find(e => e.id === id)?.note !== notesById[id].trim());
    if (missed.length) throw new Error("PM didn't keep some notes — check the Timers page.");
    return after;
  }

  // Returns { project, how } when confident, or { needsChoice: true, candidates, suggestedId }.
  async function resolveProject(issue, status) {
    const projects = await getProjects();
    const byId = Object.fromEntries(projects.map(p => [p.id, p]));
    const text = `${issue.summary || ''}\n${issue.description || ''}`;

    // 1. The ticket names the PM project (a link, or a project ID / exact name).
    const linked = text.match(/viewProjects=(\d+)/) || text.match(/new_project=(\d+)/);
    if (linked && byId[linked[1]]) return { project: byId[linked[1]], how: 'listed on the ticket' };
    const named = projects.filter(p => p.name.length > 8 && text.toLowerCase().includes(p.name.toLowerCase()));
    if (named.length === 1) return { project: named[0], how: 'listed on the ticket' };

    // 2. Find the client (no AI).
    const { client: knownClient, remembered, history } = await clientForIssue(issue, status, projects);

    if (knownClient) {
      const candidates = projects.filter(p => p.client === knownClient);
      // "TIMER: SEO" on the ticket names the timer within the client.
      const hint = AI.timerHint(issue);
      if (hint && candidates.length > 1) {
        const h = norm(hint);
        const hinted = candidates.filter(p => norm(p.name).includes(h) || norm(p.parents[0]).includes(h));
        if (hinted.length === 1) return { project: hinted[0], how: `TIMER: ${hint} on the ticket` };
      }
      let pickedId = candidates.length === 1 ? candidates[0].id : null;
      if (!pickedId) pickedId = await AI.pickProject(issue, candidates).catch(() => null);
      if (!pickedId && remembered && candidates.some(p => p.id === remembered.projectId)) pickedId = remembered.projectId;
      if (!pickedId && history.length) pickedId = history[0].projectId;
      if (pickedId && byId[pickedId]) {
        const how = candidates.length === 1 ? `only ${knownClient} timer` : `best fit for ${knownClient}`;
        return { project: byId[pickedId], how };
      }
      return { needsChoice: true, candidates, suggestedId: null, reason: `Which ${knownClient} timer?` };
    }

    // 3. No client found: let the AI suggest from everything, but ask first.
    const suggestedId = await AI.pickProject(issue, projects).catch(() => null);
    const suggested = suggestedId && byId[suggestedId];
    const candidates = suggested ? projects.filter(p => p.client === suggested.client) : projects;
    return {
      needsChoice: true, candidates, all: projects, suggestedId,
      reason: suggested ? `Best guess: ${suggested.client}. Confirm the timer:` : 'Pick the PM timer for this ticket:',
    };
  }

  // ── Which project does an email belong to? (addresses only — no AI for the client) ──
  const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'live.com',
    'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'comcast.net', 'proton.me', 'protonmail.com', 'gmx.com']);
  const AUTOMATED = /^(no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|calendar-notification|bounce)/i;

  function baseDomain(domain) {
    const parts = domain.toLowerCase().split('.');
    if (parts.length > 2 && /^(co|com|org|net|ac|gov|edu)$/.test(parts[parts.length - 2])) return parts.slice(-3).join('.');
    return parts.slice(-2).join('.');
  }

  // Addresses outside your own domain, minus automated senders.
  function externalAddresses(email) {
    const own = (email.ownDomain || '').toLowerCase();
    return [...new Set((email.addresses || []).map(a => a.toLowerCase().trim()))].filter(a => {
      const [user, dom] = a.split('@');
      if (!user || !dom) return false;
      if (own && (dom === own || dom.endsWith(`.${own}`))) return false;
      if (/(^|\.)google\.com$/.test(dom) || AUTOMATED.test(user)) return false;
      return true;
    });
  }

  // How strongly a project's client/site names point at an email domain.
  function domainScore(p, domain) {
    const base = baseDomain(domain);           // "smartvest.com"
    const label = norm(base.split('.')[0]);    // "smartvest" ("matrix-eng" → "matrixeng")
    let score = 0;
    [p.client, ...p.parents, p.name].forEach(t => {
      const low = (t || '').toLowerCase();
      if (low.includes(base)) score = Math.max(score, 3);                           // "smartvest.com - Google Ads"
      if (label.length >= 4 && tokens(t).some(w => w === label || (label.length >= 5 && w.startsWith(label)))) {
        score = Math.max(score, 2);                                                  // "Electromed, Inc. (SmartVest)"
      }
      if (label.length >= 6 && norm(t).includes(label)) score = Math.max(score, 2); // "luckyshotspickleball.com"
    });
    return score;
  }

  // Returns { project, how } when confident, or { needsChoice, candidates, reason }.
  async function resolveEmailProject(email, status) {
    const projects = await getProjects();
    const byId = Object.fromEntries(projects.map(p => [p.id, p]));
    const ext = externalAddresses(email);
    if (!ext.length) {
      return { needsChoice: true, candidates: [], all: projects, reason: 'No client address on this email — pick the timer:' };
    }

    const { pmEmailMap = {} } = await browser.storage.local.get('pmEmailMap');
    const votes = {};
    const vote = (client, n) => { if (client) votes[client] = (votes[client] || 0) + n; };
    let remembered = null;
    ext.forEach(a => {
      const dom = baseDomain(a.split('@')[1]);
      const hit = pmEmailMap[`addr:${a}`] || (!FREEMAIL.has(dom) && pmEmailMap[`dom:${dom}`]);
      if (hit && byId[hit.projectId]) { vote(byId[hit.projectId].client, 6); remembered = remembered || hit.projectId; }
      if (!FREEMAIL.has(dom)) projects.forEach(p => vote(p.client, domainScore(p, dom)));
    });

    const ranked = Object.entries(votes).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const knownClient = ranked.length && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
    if (knownClient) {
      const candidates = projects.filter(p => p.client === knownClient);
      if (candidates.length === 1) return { project: candidates[0], how: `only ${knownClient} timer` };
      let pickedId = await AI.pickEmailTimer(email, candidates).catch(() => null);
      if (!pickedId && remembered && candidates.some(p => p.id === remembered)) pickedId = remembered;
      if (pickedId && byId[pickedId]) return { project: byId[pickedId], how: `best fit for ${knownClient}` };
      return { needsChoice: true, candidates, all: projects, reason: `Which ${knownClient} timer?` };
    }
    if (ranked.length > 1) {
      const tied = new Set(ranked.filter(([, v]) => v === ranked[0][1]).map(([c]) => c));
      return { needsChoice: true, candidates: projects.filter(p => tied.has(p.client)), all: projects,
        reason: 'These addresses match more than one client — pick the timer:' };
    }
    return { needsChoice: true, candidates: [], all: projects,
      reason: `No PM client matches ${ext[0].split('@')[1]} — pick the timer (it will be remembered):` };
  }

  // Remember the client for these addresses: by domain for company domains,
  // by full address for personal (gmail.com etc.) addresses.
  async function rememberEmailChoice(email, projectId) {
    const { pmEmailMap = {} } = await browser.storage.local.get('pmEmailMap');
    externalAddresses(email).forEach(a => {
      const dom = baseDomain(a.split('@')[1]);
      const key = FREEMAIL.has(dom) ? `addr:${a}` : `dom:${dom}`;
      pmEmailMap[key] = { projectId: String(projectId), t: Date.now() };
    });
    await browser.storage.local.set({ pmEmailMap });
  }

  async function rememberChoice(projectKey, projectId) {
    const { pmMap = {} } = await browser.storage.local.get('pmMap');
    pmMap[projectKey] = { projectId: String(projectId), t: Date.now() };
    await browser.storage.local.set({ pmMap });
  }

  globalThis.PM = {
    ORIGIN, PmAuthError,
    getTimers, summarize, resumeEntry, createEntry, setEntryProject, pauseEntry,
    getProjects, resolveProject, rememberChoice, clientForIssue, setNotes,
    resolveEmailProject, rememberEmailChoice, externalAddresses,
    // exposed for tests
    _parseTimers: parseTimers, _formBody: formBody, _clientScore: clientScore,
  };
})();
