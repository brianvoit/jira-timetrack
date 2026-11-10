// popup.js — uses lib/jira.js (JiraUrl) and lib/ai.js (AI), loaded before this file.

const UPDATES_URL = 'https://raw.githubusercontent.com/brianvoit/jira-timetrack/main/updates.json';
const ADDON_ID    = 'jira-time-helper@brianvoit';

// ── DOM ────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const panelMain     = $('panel-main');
const panelSettings = $('panel-settings');
const btnSettings   = $('btn-settings');
const modelBtns     = document.querySelectorAll('.model-btn');
const sectionGemini = $('section-gemini');
const sectionClaude = $('section-claude');
const geminiInput   = $('gemini-key-input');
const claudeInput   = $('claude-key-input');
const geminiModelInput = $('gemini-model-input');
const claudeModelInput = $('claude-model-input');
const btnSaveGemini = $('btn-save-gemini');
const btnSaveClaude = $('btn-save-claude');
const goalInput     = $('goal-input');
const showButtonInput = $('show-button-input');
const noKeyWarn     = $('no-key-warn');
const loading       = $('loading');
const fieldsEl      = $('fields');
const emptyStateEl  = $('empty-state');
const emptyMsgEl    = $('empty-msg');
const valKey        = $('val-key');
const valSum        = $('val-summary');
const valDesc       = $('val-desc');
const aiResult      = $('ai-result');
const modelBadge    = $('model-badge');
const btnStartPm    = $('btn-start-pm');
const btnCopyAI     = $('btn-copy-ai');
const btnCopyRaw    = $('btn-copy-raw');
const btnRefresh    = $('btn-refresh');
const statusEl      = $('status');
const pmEl          = $('pm-status');
const versionDisplay = $('version-display');
const btnCheckUpdate = $('btn-check-update');
const updateStatusEl = $('update-status');

let currentData    = {};
let currentSummary = '';
let currentTabId   = null;
let settingsOpen   = false;
let selectedModel  = 'gemini'; // provider: 'gemini' | 'claude'

geminiModelInput.placeholder = AI.DEFAULT_MODELS.gemini;
claudeModelInput.placeholder = AI.DEFAULT_MODELS.claude;

// ── Settings: model picker ─────────────────────────────────────
modelBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    selectedModel = btn.dataset.model;
    modelBtns.forEach(b => b.classList.toggle('active', b === btn));
    sectionGemini.classList.toggle('active', selectedModel === 'gemini');
    sectionClaude.classList.toggle('active', selectedModel === 'claude');
    browser.storage.local.set({ selectedModel });
  });
});

// ── Settings: save keys ────────────────────────────────────────
function makeSaveHandler(inputEl, storageKey, btn) {
  btn.addEventListener('click', async () => {
    const key = inputEl.value.trim();
    if (!key) {
      btn.textContent = '⚠ Empty';
      btn.classList.add('error-state');
      setTimeout(() => { btn.textContent = 'Save'; btn.classList.remove('error-state'); }, 1500);
      return;
    }
    await browser.storage.local.set({ [storageKey]: key });
    btn.textContent = '✓ Saved';
    btn.classList.add('saved');
    setTimeout(() => {
      btn.textContent = 'Save';
      btn.classList.remove('saved');
      settingsOpen = false;
      panelSettings.classList.remove('active');
      panelMain.classList.add('active');
      btnSettings.style.color = '';
      scrape();
    }, 1000);
  });
}

makeSaveHandler(geminiInput, 'geminiApiKey', btnSaveGemini);
makeSaveHandler(claudeInput, 'claudeApiKey', btnSaveClaude);

// Fields saved on change (blank = default).
function saveOnChange(inputEl, storageKey, read = el => el.value.trim()) {
  inputEl.addEventListener('change', async () => {
    await browser.storage.local.set({ [storageKey]: read(inputEl) });
    inputEl.classList.add('saved');
    setTimeout(() => inputEl.classList.remove('saved'), 1200);
  });
}

saveOnChange(geminiModelInput, 'geminiModel');
saveOnChange(claudeModelInput, 'claudeModel');
saveOnChange(goalInput, 'dailyGoalHours', el => Number(el.value) || 7);
showButtonInput.addEventListener('change', () => browser.storage.local.set({ showJiraButton: showButtonInput.checked }));

btnSettings.addEventListener('click', () => {
  settingsOpen = !settingsOpen;
  panelSettings.classList.toggle('active', settingsOpen);
  panelMain.classList.toggle('active', !settingsOpen);
  btnSettings.style.color = settingsOpen ? 'var(--key-text, #5b9cf6)' : '';
});

// ── Init: restore saved settings ──────────────────────────────
(async () => {
  const s = await browser.storage.local.get(
    ['geminiApiKey', 'claudeApiKey', 'selectedModel', 'geminiModel', 'claudeModel', 'dailyGoalHours', 'showJiraButton']
  );
  if (s.geminiApiKey) geminiInput.value = s.geminiApiKey;
  if (s.claudeApiKey) claudeInput.value = s.claudeApiKey;
  if (s.geminiModel)  geminiModelInput.value = s.geminiModel;
  if (s.claudeModel)  claudeModelInput.value = s.claudeModel;
  goalInput.value = s.dailyGoalHours || 7;
  showButtonInput.checked = s.showJiraButton !== false;
  if (s.selectedModel) {
    selectedModel = s.selectedModel;
    modelBtns.forEach(b => b.classList.toggle('active', b.dataset.model === selectedModel));
    sectionGemini.classList.toggle('active', selectedModel === 'gemini');
    sectionClaude.classList.toggle('active', selectedModel === 'claude');
  }
})();

// ── Helpers ────────────────────────────────────────────────────
function setField(el, text) {
  if (text) { el.textContent = text; el.classList.remove('empty'); }
  else { el.textContent = 'Not found'; el.classList.add('empty'); }
}

let statusTimer = null;
function setStatus(msg, type = '') {
  clearTimeout(statusTimer);
  statusEl.textContent = msg;
  statusEl.className = 'status-bar ' + type;
  if (type === 'success' && msg) {
    statusTimer = setTimeout(() => {
      statusEl.textContent = '';
      statusEl.className = 'status-bar';
    }, 3500);
  }
}

function setAiState(state, text = '') {
  aiResult.className = 'ai-result';
  if (state === 'loading') {
    aiResult.contentEditable = 'false';
    aiResult.classList.add('loading-state');
    aiResult.innerHTML = '<span class="shimmer"></span>';
    currentSummary = '';
    btnCopyAI.disabled = true;
  } else if (state === 'error') {
    aiResult.contentEditable = 'false';
    aiResult.classList.add('error-state');
    aiResult.textContent = text;
    currentSummary = '';
    btnCopyAI.disabled = true;
  } else {
    aiResult.contentEditable = 'true';
    aiResult.textContent = text;
    currentSummary = text;
    btnCopyAI.disabled = false;
  }
}

function buildRawText() {
  const parts = [];
  if (currentData.key)         parts.push(`Ticket:    ${currentData.key}`);
  if (currentData.summary)     parts.push(`Task Name: ${currentData.summary}`);
  if (currentData.description) parts.push(`\nDescription:\n${currentData.description}`);
  return parts.join('\n');
}

// ── Scrape + summarise ─────────────────────────────────────────
// regenerate: skip the cached result and ask the AI for a fresh one (↻ button).
async function scrape({ regenerate = false } = {}) {
  btnRefresh.disabled = true;
  btnStartPm.disabled = true;
  emptyStateEl.classList.remove('visible');
  loading.style.display = 'flex';
  fieldsEl.style.display = 'none';
  setStatus('');

  let tabs;
  try { tabs = await browser.tabs.query({ active: true, currentWindow: true }); }
  catch { showError('Could not access the current tab.'); return; }

  const tab = tabs[0];
  if (!tab) { showError('Could not access the current tab.'); return; }
  currentTabId = tab.id;

  if (!tab.url || !JiraUrl.isJiraUrl(tab.url)) {
    showEmptyState('Open a Jira issue or board page first.'); return;
  }
  if (!JiraUrl.issueKeyFromUrl(tab.url)) {
    showEmptyState('Click on an issue on the board first, then try again.'); return;
  }

  let data;
  try {
    data = await browser.tabs.sendMessage(tab.id, { type: 'SCRAPE_JIRA' });
  } catch {
    try {
      await browser.tabs.executeScript(tab.id, { file: 'lib/jira.js' });
      await browser.tabs.executeScript(tab.id, { file: 'content.js' });
      data = await browser.tabs.sendMessage(tab.id, { type: 'SCRAPE_JIRA' });
    } catch { showError('Could not read the page. Try refreshing.'); return; }
  }

  currentData = data || {};
  setField(valKey,  currentData.key);
  setField(valSum,  currentData.summary);
  setField(valDesc, currentData.description);

  loading.style.display = 'none';
  fieldsEl.style.display = 'block';
  btnStartPm.disabled = !currentData.key;

  const cfg = await AI.getConfig();
  if (!cfg.apiKey) {
    noKeyWarn.style.display = 'block';
    setAiState('error', `Add a ${AI.PROVIDER_NAMES[cfg.provider]} API key in ··· settings.`);
    btnRefresh.disabled = false;
    return;
  }
  noKeyWarn.style.display = 'none';

  if (!currentData.key && !currentData.summary) {
    setAiState('error', 'Nothing found — click an issue on the board first.');
    btnRefresh.disabled = false;
    return;
  }

  modelBadge.textContent = cfg.modelId;
  modelBadge.title = `${AI.PROVIDER_NAMES[cfg.provider]} · ${cfg.modelId}`;

  setAiState('loading');
  try {
    const res = await AI.generateEntry(currentData, { regenerate, onStatus: msg => setStatus(msg) });
    setAiState('ready', res.text);
    setStatus('AI summary ready', 'success');
  } catch (e) {
    setAiState('error', AI.friendlyError(e));
  } finally {
    btnRefresh.disabled = false;
  }
}

function showError(msg) {
  btnRefresh.disabled = false;
  emptyStateEl.classList.remove('visible');
  loading.style.display = 'none';
  fieldsEl.style.display = 'block';
  setStatus(msg, 'error');
  setField(valKey, null); setField(valSum, null); setField(valDesc, null);
  setAiState('error', msg);
}

function showEmptyState(msg) {
  btnRefresh.disabled = false;
  loading.style.display = 'none';
  fieldsEl.style.display = 'none';
  emptyStateEl.classList.add('visible');
  emptyMsgEl.textContent = msg;
}

// ── PM: start timer (handed to the on-page button, which handles project choice) ──
btnStartPm.addEventListener('click', async () => {
  if (currentTabId == null) return;
  try {
    await browser.tabs.sendMessage(currentTabId, { type: 'WIDGET_START', note: currentSummary || undefined });
    window.close();
  } catch {
    setStatus('Could not reach the page — refresh it and try again.', 'error');
  }
});

// ── PM: today's hours, running timer, warnings ────────────────
const fmtElapsed = ms => {
  const m = Math.max(0, Math.floor(ms / 60000));
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

function pmLine(text, cls) {
  const d = document.createElement('div');
  d.className = cls || 'pm-line';
  d.textContent = text;
  pmEl.appendChild(d);
  return d;
}

async function loadPmStatus() {
  pmEl.textContent = '';
  const [res, { dailyGoalHours }] = await Promise.all([
    browser.runtime.sendMessage({ type: 'PM_STATUS' }).catch(e => ({ error: String(e) })),
    browser.storage.local.get('dailyGoalHours'),
  ]);
  const goal = Number(dailyGoalHours) || 7;

  if (!res?.status) {
    const d = pmLine(res?.signIn ? 'PM: not signed in. ' : `PM: ${res?.error || 'unavailable'}`, 'pm-line muted');
    if (res?.signIn) {
      const a = document.createElement('a');
      a.textContent = 'Open PM';
      a.addEventListener('click', () => browser.runtime.sendMessage({ type: 'PM_OPEN' }).then(() => window.close()));
      d.appendChild(a);
    }
    return;
  }
  const s = res.status;
  const today = s.todayBillableHours;

  const head = pmLine('', 'pm-head');
  const label = document.createElement('span'); label.textContent = 'Today';
  const val = document.createElement('strong');
  val.textContent = `${today == null ? '—' : today.toFixed(1)} / ${goal} h`;
  head.append(label, val);
  const bar = document.createElement('div'); bar.className = 'pm-bar';
  const fill = document.createElement('i'); fill.style.width = `${Math.min(100, ((today || 0) / goal) * 100)}%`;
  if ((today || 0) >= goal) fill.classList.add('done');
  bar.appendChild(fill); pmEl.appendChild(bar);

  if (s.running.length) {
    s.running.forEach(r => pmLine(
      `● ${r.note || r.projectName}${r.startedAt ? ` · ${fmtElapsed(Date.now() - r.startedAt)}` : ''}`,
      'pm-line running'));
  } else {
    pmLine('No timer running.', 'pm-line muted');
  }
  s.running.filter(r => r.runaway).forEach(r => pmLine(
    `Running since ${new Date(r.startedAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })} — is that right?`,
    'pm-line warn'));
  s.longSegments.forEach(l => pmLine(
    `${Math.round(l.minutes / 60)} h segment on ${l.note || l.projectName} (${l.start.slice(5, 16)} → ${l.stop.slice(5, 16)}) — check before invoicing.`,
    'pm-line warn'));
  if (s.emptyNotesToday.length) {
    pmLine(`${s.emptyNotesToday.length} entr${s.emptyNotesToday.length === 1 ? 'y' : 'ies'} from today without a note: ` +
      s.emptyNotesToday.map(e => e.projectName).join(', '), 'pm-line warn');
  }
}

// ── Copy ───────────────────────────────────────────────────────
async function copyText(text, btn, label) {
  if (!text) { setStatus('Nothing to copy.', 'error'); return; }
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = '✓ Copied';
    btn.classList.add('copied');
    setStatus('Copied to clipboard', 'success');
    setTimeout(() => { btn.textContent = label; btn.classList.remove('copied'); }, 2000);
  } catch { setStatus('Copy failed — try again.', 'error'); }
}

// ── AI result: editable, no newlines ──────────────────────────
aiResult.addEventListener('keydown', e => {
  if (e.key === 'Enter') e.preventDefault();
});
aiResult.addEventListener('input', () => {
  currentSummary = aiResult.textContent.trim();
  btnCopyAI.disabled = !currentSummary;
});

btnCopyAI.addEventListener('click',  () => copyText(currentSummary, btnCopyAI,  'Copy Summary'));
btnCopyRaw.addEventListener('click', () => copyText(buildRawText(), btnCopyRaw, 'Copy Raw'));
btnRefresh.addEventListener('click', () => scrape({ regenerate: true }));

// ── Version display + update check ────────────────────────────
const currentVersion = browser.runtime.getManifest().version;
versionDisplay.textContent = `v${currentVersion}`;

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

btnCheckUpdate.addEventListener('click', async () => {
  btnCheckUpdate.disabled = true;
  btnCheckUpdate.textContent = 'Checking…';
  updateStatusEl.className = 'update-status';
  updateStatusEl.textContent = '';

  try {
    const resp = await AI.fetchWithTimeout(UPDATES_URL, {}, 8000);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const updates = data?.addons?.[ADDON_ID]?.updates || [];
    if (!updates.length) throw new Error('No version info found.');

    const latest = updates[updates.length - 1];

    if (compareVersions(latest.version, currentVersion) > 0) {
      btnCheckUpdate.textContent = 'Check for updates';
      btnCheckUpdate.disabled = false;
      updateStatusEl.textContent = '';
      const linkText = document.createTextNode(`v${latest.version} available — `);
      const linkEl = document.createElement('a');
      linkEl.href = latest.update_link;
      linkEl.target = '_blank';
      linkEl.rel = 'noopener noreferrer';
      linkEl.textContent = 'download';
      updateStatusEl.appendChild(linkText);
      updateStatusEl.appendChild(linkEl);
      updateStatusEl.className = 'update-status visible has-update';
    } else {
      btnCheckUpdate.textContent = '✓ Up to date';
      btnCheckUpdate.classList.add('up-to-date');
      setTimeout(() => {
        btnCheckUpdate.textContent = 'Check for updates';
        btnCheckUpdate.classList.remove('up-to-date');
        btnCheckUpdate.disabled = false;
      }, 2500);
    }
  } catch (e) {
    btnCheckUpdate.textContent = 'Check for updates';
    btnCheckUpdate.disabled = false;
    updateStatusEl.textContent = 'Could not check — try again.';
    updateStatusEl.className = 'update-status visible error';
  }
});

scrape();
loadPmStatus();
