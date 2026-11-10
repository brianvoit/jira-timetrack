// lib/ai.js — AI calls shared by the popup and the background page.
(() => {
  if (globalThis.AI) return;

  const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
  const CLAUDE_URL  = 'https://api.anthropic.com/v1/messages';

  // Defaults used when the model field in settings is blank.
  // If a provider retires one, users can override it in settings without a release.
  const DEFAULT_MODELS = {
    gemini: 'gemini-3.5-flash-lite',
    claude: 'claude-haiku-5-5',
  };
  const PROVIDER_NAMES = { gemini: 'Gemini', claude: 'Claude' };

  const AI_TIMEOUT_MS  = 20000;
  const RETRY_STATUSES = new Set([429, 500, 502, 503, 529]);
  const CACHE_MAX      = 50;
  const CACHE_TTL_MS   = 7 * 24 * 60 * 60 * 1000;

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  // ── Settings ────────────────────────────────────────────────
  async function getConfig() {
    const s = await browser.storage.local.get(
      ['geminiApiKey', 'claudeApiKey', 'selectedModel', 'geminiModel', 'claudeModel']
    );
    const provider = s.selectedModel === 'claude' ? 'claude' : 'gemini';
    return {
      provider,
      apiKey:  provider === 'claude' ? s.claudeApiKey : s.geminiApiKey,
      modelId: (provider === 'claude' ? s.claudeModel : s.geminiModel) || DEFAULT_MODELS[provider],
    };
  }

  // ── Network ─────────────────────────────────────────────────
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

  async function callGemini(prompt, apiKey, modelId, maxTokens) {
    const resp = await fetchWithTimeout(`${GEMINI_BASE}/${encodeURIComponent(modelId)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // Thinking tokens count toward this limit on Gemini 3.x, so leave headroom.
        generationConfig: { maxOutputTokens: Math.max(maxTokens, 1024) }
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

  async function callClaude(prompt, apiKey, modelId, maxTokens) {
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
        max_tokens: maxTokens,
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

  // Calls the configured provider, retrying once on rate-limit / overload / 5xx.
  async function complete(prompt, { maxTokens = 200, onStatus } = {}) {
    const cfg = await getConfig();
    if (!cfg.apiKey) {
      throw new ApiError(`Add a ${PROVIDER_NAMES[cfg.provider]} API key in ··· settings.`, 'no-key');
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = cfg.provider === 'claude'
          ? await callClaude(prompt, cfg.apiKey, cfg.modelId, maxTokens)
          : await callGemini(prompt, cfg.apiKey, cfg.modelId, maxTokens);
        return { text, ...cfg };
      } catch (e) {
        if (attempt === 0 && RETRY_STATUSES.has(e.status)) {
          onStatus?.(e.status === 429 ? 'Rate limited — retrying…' : 'Service busy — retrying…');
          await new Promise(r => setTimeout(r, 1500));
          continue;
        }
        e.modelId = cfg.modelId;
        throw e;
      }
    }
  }

  function friendlyError(e) {
    const msg = e?.message || 'Unknown error';
    if (e?.status === 'no-key') return msg;
    if (e?.status === 401 || e?.status === 403 || /api.key|authentication/i.test(msg)) {
      return 'Invalid API key — check your key in ··· settings.';
    }
    if (e?.status === 404 || /not.found|does not exist|not supported/i.test(msg)) {
      return `Model "${e?.modelId || '?'}" isn't available (it may have been retired). Change it in ··· settings.`;
    }
    if (e?.status === 429) return 'Rate limited — wait a moment and try again.';
    return `Error: ${msg}`;
  }

  // ── Time entry text ─────────────────────────────────────────
  function buildEntryPrompt(issue) {
    return `You are a time-tracking assistant. A developer is logging work in a tool like Harvest or Toggl.

Given this Jira issue, write a time entry in exactly this format:
{description of work done} (${issue.key || 'TICKET'})

Rules:
- The description should be a short, plain-English phrase describing the work
- Give strong preference to the task TITLE/SUMMARY when forming the description — use its wording where possible
- Use the description/acceptance criteria only to add specifics (e.g. which pages, which components)
- Do NOT start with a verb — write it as a noun phrase (e.g. "SEO work on Page 1 and Page 2")
- No jargon, no ticket metadata, no quotes
- Return ONLY the final formatted string. Nothing else.

Example output: SEO work on Page 1, Page 2, and Page 3 (PROJECT-135)

Ticket: ${issue.key || 'N/A'}
Summary: ${issue.summary || 'N/A'}
Description: ${issue.description || 'N/A'}`;
  }

  // Tidies the model's output and guarantees it ends with the real ticket key,
  // whatever the model did with it.
  function cleanEntry(text, key) {
    let t = (text || '').split('\n').find(l => l.trim()) || '';
    t = t.replace(/^[\s"'`*]+|[\s"'`*.]+$/g, '').replace(/\s+/g, ' ');
    t = t.replace(/\s*\([A-Z][A-Z0-9_]+-\d+\)\s*$/i, '').replace(/[\s.]+$/, '');
    if (!t) return null;
    return key ? `${t} (${key})` : t;
  }

  // Used when the AI is unavailable, so a timer can still start with a sensible note.
  function fallbackEntry(issue) {
    const s = (issue.summary || '').trim();
    return s ? `${s} (${issue.key})` : null;
  }

  // ── Result cache (persists across popup opens) ─────────────
  function hashText(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  async function cacheKeyFor(issue) {
    const cfg = await getConfig();
    const text = `${issue.summary || ''}\n${issue.description || ''}`;
    return `${cfg.provider}:${cfg.modelId}:${issue.key || ''}:${hashText(text)}`;
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

  // Returns { text, cached, modelId }. Throws ApiError on failure.
  async function generateEntry(issue, { regenerate = false, onStatus } = {}) {
    const ck = await cacheKeyFor(issue);
    if (!regenerate) {
      const cached = await getCached(ck).catch(() => null);
      if (cached) return { text: cached, cached: true, modelId: (await getConfig()).modelId };
    }
    const res = await complete(buildEntryPrompt(issue), { maxTokens: 200, onStatus });
    const text = cleanEntry(res.text, issue.key);
    if (!text) throw new ApiError('Empty response — try again.');
    putCached(ck, text).catch(() => {});
    return { text, cached: false, modelId: res.modelId };
  }

  // ── Best-fit PM project ─────────────────────────────────────
  // candidates: [{ id, name, client, parents: [..] }]. Returns a candidate id or null.
  async function pickProject(issue, candidates) {
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0].id;
    const list = candidates.map((p, i) =>
      `${i + 1}. ${p.name} — ${[...p.parents].reverse().join(' / ')} — client: ${p.client}`
    ).join('\n');
    const prompt = `A developer at a digital agency is about to start a timer for this Jira ticket. Pick the project timer the work should be logged against.

Jira ticket: ${issue.key}
Jira project: ${issue.projectName || issue.projectKey || 'unknown'}
Title: ${issue.summary || 'N/A'}
Description: ${(issue.description || 'N/A').slice(0, 1200)}

Project timers:
${list}

Rules:
- Match the client first, then the service (e.g. Google Ads vs Microsoft Ads vs SEO vs website/CMS support) that best fits the ticket's work.
- Reply with ONLY the number of the best project. If none plausibly fits, reply 0.`;
    const res = await complete(prompt, { maxTokens: 10 });
    const n = parseInt((res.text || '').match(/\d+/)?.[0] || '0', 10);
    return n >= 1 && n <= candidates.length ? candidates[n - 1].id : null;
  }

  globalThis.AI = {
    DEFAULT_MODELS, PROVIDER_NAMES, ApiError,
    getConfig, complete, friendlyError,
    generateEntry, cleanEntry, fallbackEntry, pickProject,
    fetchWithTimeout,
  };
})();
