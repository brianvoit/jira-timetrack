// popup.js — v1.4

const GEMINI_URL   = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const CLAUDE_URL   = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5';

// ── DOM ────────────────────────────────────────────────────────
const panelMain     = document.getElementById('panel-main');
const panelSettings = document.getElementById('panel-settings');
const btnSettings   = document.getElementById('btn-settings');
const modelBtns     = document.querySelectorAll('.model-btn');
const sectionGemini = document.getElementById('section-gemini');
const sectionClaude = document.getElementById('section-claude');
const geminiInput   = document.getElementById('gemini-key-input');
const claudeInput   = document.getElementById('claude-key-input');
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
const btnRefresh    = document.getElementById('btn-refresh');
const statusEl      = document.getElementById('status');

let currentData    = {};
let currentSummary = '';
let settingsOpen   = false;
let selectedModel  = 'gemini'; // 'gemini' | 'claude'

const resultCache  = new Map(); // key: `${ticketKey}:${model}`

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

btnSettings.addEventListener('click', () => {
  settingsOpen = !settingsOpen;
  panelSettings.classList.toggle('active', settingsOpen);
  panelMain.classList.toggle('active', !settingsOpen);
  btnSettings.style.color = settingsOpen ? 'var(--key-text, #5b9cf6)' : '';
});

// ── Init: restore saved settings ──────────────────────────────
(async () => {
  const stored = await browser.storage.local.get(['geminiApiKey', 'claudeApiKey', 'selectedModel']);
  if (stored.geminiApiKey) geminiInput.value = stored.geminiApiKey;
  if (stored.claudeApiKey) claudeInput.value = stored.claudeApiKey;
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
    /\/jira\/software\/.*\/boards\//i.test(url)
  );
}

function buildRawText() {
  const parts = [];
  if (currentData.key)         parts.push(`Ticket:  ${currentData.key}`);
  if (currentData.summary)     parts.push(`Summary: ${currentData.summary}`);
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

// ── Network helpers ────────────────────────────────────────────
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
async function callGemini(data, apiKey) {
  const resp = await fetchWithTimeout(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildPrompt(data) }] }],
      generationConfig: { maxOutputTokens: 80, temperature: 0.3 }
    })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${resp.status}`);
  }
  const result = await resp.json();
  return result.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
}

async function callClaude(data, apiKey) {
  const resp = await fetchWithTimeout(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 80,
      messages: [{ role: 'user', content: buildPrompt(data) }]
    })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${resp.status}`);
  }
  const result = await resp.json();
  return result.content?.[0]?.text?.trim() || null;
}

// Wraps the selected model call with a single 429 retry
async function callAI(data, apiKey) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return selectedModel === 'claude'
        ? await callClaude(data, apiKey)
        : await callGemini(data, apiKey);
    } catch (e) {
      if (attempt === 0 && /429|rate.limit|too many/i.test(e.message)) {
        setStatus('Rate limited — retrying…');
        await new Promise(r => setTimeout(r, 1500));
        continue;
      }
      throw e;
    }
  }
}

// ── Scrape + summarise ─────────────────────────────────────────
async function scrape() {
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

  const stored = await browser.storage.local.get(['geminiApiKey', 'claudeApiKey', 'selectedModel']);
  selectedModel = stored.selectedModel || selectedModel;
  const apiKey = selectedModel === 'claude' ? stored.claudeApiKey : stored.geminiApiKey;

  if (!apiKey) {
    noKeyWarn.style.display = 'block';
    setAiState('error', `Add a ${selectedModel === 'claude' ? 'Claude' : 'Gemini'} API key in ··· settings.`);
    btnRefresh.disabled = false;
    return;
  }
  noKeyWarn.style.display = 'none';

  if (!currentData.key && !currentData.summary) {
    setAiState('error', 'Nothing found — click an issue on the board first.');
    btnRefresh.disabled = false;
    return;
  }

  modelBadge.textContent = selectedModel === 'claude' ? 'Claude Haiku' : 'Gemini';

  // Return cached result if available for this ticket + model combo
  const ck = `${currentData.key || ''}:${selectedModel}`;
  if (resultCache.has(ck)) {
    setAiState('ready', resultCache.get(ck));
    setStatus('AI summary ready', 'success');
    btnRefresh.disabled = false;
    return;
  }

  setAiState('loading');
  try {
    const summary = await callAI(currentData, apiKey);
    if (summary) {
      resultCache.set(ck, summary);
      setAiState('ready', summary);
      setStatus('AI summary ready', 'success');
    } else {
      setAiState('error', 'Empty response — try refreshing.');
    }
  } catch (e) {
    const msg = e.message || '';
    if (/api.key|401|authentication/i.test(msg)) {
      setAiState('error', 'Invalid API key — check your key in settings.');
    } else {
      setAiState('error', `Error: ${msg}`);
    }
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
btnRefresh.addEventListener('click', scrape);

scrape();
