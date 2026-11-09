// popup.js

const GEMINI_BASE  = 'https://generativelanguage.googleapis.com/v1beta/models';
const CLAUDE_URL   = 'https://api.anthropic.com/v1/messages';
const UPDATES_URL  = 'https://raw.githubusercontent.com/brianvoit/jira-timetrack/main/updates.json';
const ADDON_ID     = 'jira-time-helper@brianvoit';

// Defaults used when the model field in settings is blank.
// If a provider retires one, users can override it in settings without a release.
const DEFAULT_MODELS = {
  gemini: 'gemini-3.5-flash-lite',
  claude: 'claude-haiku-5-5',
};
const PROVIDER_NAMES = { gemini: 'Gemini', claude: 'Claude' };

const AI_TIMEOUT_MS   = 20000;
const RETRY_STATUSES  = new Set([429, 500, 502, 503, 529]);
const CACHE_MAX       = 50;
const CACHE_TTL_MS    = 7 * 24 * 60 * 60 * 1000;

// ── DOM ────────────────────────────────────────────────────────
const panelMain     = document.getElementById('panel-main');
const panelSettings = document.getElementById('panel-settings');
const btnSettings   = document.getElementById('btn-settings');
const modelBtns     = document.querySelectorAll('.model-btn');
const sectionGemini = document.getElementById('section-gemini');
const sectionClaude = document.getElementById('section-claude');
const geminiInput   = document.getElementById('gemini-key-input');
const claudeInput   = document.getElementById('claude-key-input');
const geminiModelInput = document.getElementById('gemini-model-input');
const claudeModelInput = document.getElementById('claude-model-input');
const btnSaveGemini = document.getElementById('btn-save-gemini');
const btnSaveClaude = document.getElementById('btn-save-claude');
const noKeyWarn     = document.getElementById('no-key-warn');
const loading       = document.getElementById('loading');
const fieldsEl      = document.getElementById('fields');
const emptyStateEl  = document.getElementById('empty-state');
const emptyMsgEl    = document.getElementById('empty-msg');
const valKey        = document.getElementById('val-key');
const valSum        = document.getElementById('val-summary');
const valDesc       = document.getElementById('val-desc');
const aiResult      = document.getElementById('ai-result');
const modelBadge    = document.getElementById('model-badge');
const btnCopyAI     = document.getElementById('btn-copy-ai');
const btnCopyRaw    = document.getElementById('btn-copy-raw');
const btnRefresh      = document.getElementById('btn-refresh');
const statusEl        = document.getElementById('status');
const versionDisplay  = document.getElementById('version-display');
const btnCheckUpdate  = document.getElementById('btn-check-update');
const updateStatusEl  = document.getElementById('update-status');

let currentData    = {};
let currentSummary = '';
let settingsOpen   = false;
let selectedModel  = 'gemini'; // provider: 'gemini' | 'claude'

geminiModelInput.placeholder = DEFAULT_MODELS.gemini;
claudeModelInput.placeholder = DEFAULT_MODELS.claude;

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

// ── Settings: model ID overrides (saved on change; blank = default) ──
function makeModelHandler(inputEl, storageKey) {
  inputEl.addEventListener('change', async () => {
    await browser.storage.local.set({ [storageKey]: inputEl.value.trim() });
    inputEl.classList.add('saved');
    setTimeout(() => inputEl.classList.remove('saved'), 1200);
  });
}

makeModelHandler(geminiModelInput, 'geminiModel');
makeModelHandler(claudeModelInput, 'claudeModel');

btnSettings.addEventListener('click', () => {
  settingsOpen = !settingsOpen;
  panelSettings.classList.toggle('active', settingsOpen);
  panelMain.classList.toggle('active', !settingsOpen);
  btnSettings.style.color = settingsOpen ? 'var(--key-text, #5b9cf6)' : '';
});

// ── Init: restore saved settings ──────────────────────────────
(async () => {
  const stored = await browser.storage.local.get(
    ['geminiApiKey', 'claudeApiKey', 'selectedModel', 'geminiModel', 'claudeModel']
  );
  if (stored.geminiApiKey) geminiInput.value = stored.geminiApiKey;
  if (stored.claudeApiKey) claudeInput.value = stored.claudeApiKey;
  if (stored.geminiModel)  geminiModelInput.value = stored.geminiModel;
  if (stored.claudeModel)  claudeModelInput.value = stored.claudeModel;
  if (stored.selectedModel) {
    selectedModel = stored.selectedModel;
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

function isJiraUrl(url) {
  return (
    /atlassian\.net/i.test(url) ||
    /\/browse\/[A-Z]/i.test(url) ||
    /\/secure\/RapidBoard\.jspa/i.test(url) ||
    /\/jira\/software\/.*\/boards\//i.test(url) ||
    /\/projects\/[^/]+\/issues\/[A-Z]/i.test(url)
  );
}

function buildRawText() {
  const parts = [];
  if (currentData.key)         parts.push(`Ticket:    ${currentData.key}`);
  if (currentData.summary)     parts.push(`Task Name: ${currentData.summary}`);
  if (currentData.description) parts.push(`\nDescription:\n${currentData.description}`);
  return parts.join('\n');
}

function buildPrompt(data) {
  return `You are a time-tracking assistant. A developer is logging work in a tool like Harvest or Toggl.

Given this Jira issue, write a time entry in exactly this format:
{description of work done} (${data.key || 'TICKET'})

Rules:
- The description should be a short, plain-English phrase describing the work
- Give strong preference to the task TITLE/SUMMARY when forming the description — use its wording where possible
- Use the description/acceptance criteria only to add specifics (e.g. which pages, which components)
- Do NOT start with a verb — write it as a noun phrase (e.g. "SEO work on Page 1 and Page 2")
- No jargon, no ticket metadata, no quotes
- Return ONLY the final formatted string. Nothing else.

Example output: SEO work on Page 1, Page 2, and Page 3 (PROJECT-135)

Ticket: ${data.key || 'N/A'}
Summary: ${data.summary || 'N/A'}
Description: ${data.description || 'N/A'}`;
}

// ── Result cache (persists across popup opens) ─────────────────
// Keyed on provider + model + ticket + a hash of the ticket text, so an edited
// ticket or a model change produces a fresh result.
function hashText(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function cacheKey(data, provider, modelId) {
  const text = `${data.summary || ''}\n${data.description || ''}`;
  return `${provider}:${modelId}:${data.key || ''}:${hashText(text)}`;
}

async function getCached(key) {
  const { aiCache = {} } = await browser.storage.local.get('aiCache');
  const entry = aiCache[key];
  return entry && Date.now() - entry.t < CACHE_TTL_MS ? entry.text : null;
}

async function putCached(key, text) {
  const { aiCache = {} } = await browser.storage.local.get('aiCache');
  aiCache[key] = { text, t: Date.now() };
  const now = Date.now();
  const kept = Object.entries(aiCache)
    .filter(([, v]) => now - v.t < CACHE_TTL_MS)
    .sort((a, b) => b[1].t - a[1].t)
    .slice(0, CACHE_MAX);
  await browser.storage.local.set({ aiCache: Object.fromEntries(kept) });
}

// ── Network helpers ────────────────────────────────────────────
class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function readApiError(resp) {
  const body = await resp.json().catch(() => ({}));
  return new ApiError(body?.error?.message || `HTTP ${resp.status}`, resp.status);
}

async function fetchWithTimeout(url, options, ms = 10000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Request timed out — try again.');
    throw e;
  } finally {
    clearTimeout(id);
  }
}

// ── API calls ──────────────────────────────────────────────────
async function callGemini(prompt, apiKey, modelId) {
  const resp = await fetchWithTimeout(`${GEMINI_BASE}/${encodeURIComponent(modelId)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      // Thinking tokens count toward this limit on Gemini 3.x, so leave headroom.
      generationConfig: { maxOutputTokens: 1024 }
    })
  }, AI_TIMEOUT_MS);
  if (!resp.ok) throw await readApiError(resp);
  const result = await resp.json();
  if (result.promptFeedback?.blockReason) {
    throw new ApiError(`Blocked by Gemini safety filter (${result.promptFeedback.blockReason}).`);
  }
  const parts = result.candidates?.[0]?.content?.parts || [];
  return parts.filter(p => !p.thought && p.text).map(p => p.text).join('').trim() || null;
}

async function callClaude(prompt, apiKey, modelId) {
  const resp = await fetchWithTimeout(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    })
  }, AI_TIMEOUT_MS);
  if (!resp.ok) throw await readApiError(resp);
  const result = await resp.json();
  return (result.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim() || null;
}

// Calls the given provider, retrying once on rate-limit / overload / 5xx.
async function callAI(provider, data, apiKey, modelId) {
  const prompt = buildPrompt(data);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return provider === 'claude'
        ? await callClaude(prompt, apiKey, modelId)
        : await callGemini(prompt, apiKey, modelId);
    } catch (e) {
      if (attempt === 0 && RETRY_STATUSES.has(e.status)) {
        setStatus(e.status === 429 ? 'Rate limited — retrying…' : 'Service busy — retrying…');
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw e;
    }
  }
}

function friendlyError(e, modelId) {
  const msg = e.message || 'Unknown error';
  if (e.status === 401 || e.status === 403 || /api.key|authentication/i.test(msg)) {
    return 'Invalid API key — check your key in ··· settings.';
  }
  if (e.status === 404 || /not.found|does not exist|not supported/i.test(msg)) {
    return `Model "${modelId}" isn't available (it may have been retired). Change it in ··· settings.`;
  }
  if (e.status === 429) return 'Rate limited — wait a moment and hit ↻.';
  return `Error: ${msg}`;
}

// ── Scrape + summarise ─────────────────────────────────────────
// regenerate: skip the cached result and ask the AI for a fresh one (↻ button).
async function scrape({ regenerate = false } = {}) {
  btnRefresh.disabled = true;
  emptyStateEl.classList.remove('visible');
  loading.style.display = 'flex';
  fieldsEl.style.display = 'none';
  setStatus('');

  let tabs;
  try { tabs = await browser.tabs.query({ active: true, currentWindow: true }); }
  catch { showError('Could not access the current tab.'); return; }

  const tab = tabs[0];
  if (!tab) { showError('Could not access the current tab.'); return; }

  if (!tab.url || !isJiraUrl(tab.url)) {
    showEmptyState('Open a Jira issue or board page first.'); return;
  }
  if (/RapidBoard|boards/i.test(tab.url) && !/selectedIssue=/i.test(tab.url)) {
    showEmptyState('Click on an issue on the board first, then try again.'); return;
  }

  // Confirmed Jira — light up the toolbar badge
  try {
    browser.browserAction.setBadgeText({ tabId: tab.id, text: '●' });
    browser.browserAction.setBadgeBackgroundColor({ tabId: tab.id, color: '#16a34a' });
  } catch {}

  let data;
  try {
    data = await browser.tabs.sendMessage(tab.id, { type: 'SCRAPE_JIRA' });
  } catch {
    try {
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

  const stored = await browser.storage.local.get(
    ['geminiApiKey', 'claudeApiKey', 'selectedModel', 'geminiModel', 'claudeModel']
  );
  const provider = stored.selectedModel || selectedModel;
  selectedModel  = provider;
  const apiKey   = provider === 'claude' ? stored.claudeApiKey : stored.geminiApiKey;
  const modelId  = (provider === 'claude' ? stored.claudeModel : stored.geminiModel) || DEFAULT_MODELS[provider];

  if (!apiKey) {
    noKeyWarn.style.display = 'block';
    setAiState('error', `Add a ${PROVIDER_NAMES[provider]} API key in ··· settings.`);
    btnRefresh.disabled = false;
    return;
  }
  noKeyWarn.style.display = 'none';

  if (!currentData.key && !currentData.summary) {
    setAiState('error', 'Nothing found — click an issue on the board first.');
    btnRefresh.disabled = false;
    return;
  }

  modelBadge.textContent = modelId;
  modelBadge.title = `${PROVIDER_NAMES[provider]} · ${modelId}`;

  const ck = cacheKey(currentData, provider, modelId);
  if (!regenerate) {
    const cached = await getCached(ck).catch(() => null);
    if (cached) {
      setAiState('ready', cached);
      setStatus('AI summary ready', 'success');
      btnRefresh.disabled = false;
      return;
    }
  }

  setAiState('loading');
  try {
    const summary = await callAI(provider, currentData, apiKey, modelId);
    if (summary) {
      setAiState('ready', summary);
      setStatus('AI summary ready', 'success');
      putCached(ck, summary).catch(() => {});
    } else {
      setAiState('error', 'Empty response — hit ↻ to try again.');
    }
  } catch (e) {
    setAiState('error', friendlyError(e, modelId));
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
    const resp = await fetchWithTimeout(UPDATES_URL, {}, 8000);
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
