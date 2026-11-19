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

  // Older Claude models reject the `effort` setting.
  const claudeSupportsEffort = id => !/claude-(3|haiku-4|sonnet-4-5|sonnet-4-0|opus-4-0|opus-4-1)/.test(id);

  // Claude Haiku 5.5 (and other current models) think before answering, and that
  // thinking counts toward max_tokens. So: low effort for these short tasks, a
  // max_tokens with room for thinking + answer, and (when `schema` is given)
  // structured output so the reply is always parseable JSON.
  async function callClaude(prompt, apiKey, modelId, maxTokens, schema) {
    const outputConfig = {};
    if (claudeSupportsEffort(modelId)) outputConfig.effort = 'low';
    if (schema) outputConfig.format = { type: 'json_schema', schema };
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
        max_tokens: Math.max(maxTokens, 2048),
        ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
        messages: [{ role: 'user', content: prompt }]
      })
    }, AI_TIMEOUT_MS);
    if (!resp.ok) throw await readApiError(resp);
    const result = await resp.json();
    if (result.stop_reason === 'refusal') {
      throw new ApiError("Claude declined this request (safety filter). Try again, or switch to Gemini in ··· settings.");
    }
    // Responses can start with `thinking` blocks — read text blocks by type.
    const text = (result.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();
    if (!text && result.stop_reason === 'max_tokens') {
      throw new ApiError('Claude ran out of room before answering — try again.');
    }
    return text || null;
  }

  // Calls the configured provider, retrying once on rate-limit / overload / 5xx.
  // `schema`: JSON schema for Claude structured output (Gemini returns plain text).
  async function complete(prompt, { maxTokens = 200, onStatus, schema } = {}) {
    const cfg = await getConfig();
    if (!cfg.apiKey) {
      throw new ApiError(`Add a ${PROVIDER_NAMES[cfg.provider]} API key in ··· settings.`, 'no-key');
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = cfg.provider === 'claude'
          ? await callClaude(prompt, cfg.apiKey, cfg.modelId, maxTokens, schema)
          : await callGemini(prompt, cfg.apiKey, cfg.modelId, maxTokens);
        return { text, structured: cfg.provider === 'claude' && !!schema, ...cfg };
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
  // "TIMER: SEO"-style lines in a ticket say which PM timer to use; they aren't work.
  const TIMER_LINE = /^\s*TIMER\s*:\s*(.+?)\s*$/im;
  const timerHint = issue => (issue.description || '').match(TIMER_LINE)?.[1] || null;
  const withoutTimerLines = text => (text || '').replace(new RegExp(TIMER_LINE.source, 'gim'), '').trim();

  // The final entry is ALWAYS exactly: "<description> (<KEY>)".
  // The model writes only the description; code appends " (KEY)" (see cleanEntry).
  function buildEntryPrompt(issue) {
    return `You are a time-tracking assistant. A developer is logging work against a Jira ticket.

Write the DESCRIPTION part of the time entry. The final entry will be exactly:
<description> (${issue.key || 'TICKET-123'})
The ticket key is added automatically — do not include it.

Rules for the description:
- A short, plain-English noun phrase describing the work — do NOT start with a verb
- Give strong preference to the ticket TITLE; use its wording where possible
- Use the ticket description only to add specifics (e.g. which pages, which components)
- No jargon, no ticket metadata, no labels like "PROPOSING:" or "TIMER:", no quotes, no trailing period
- One line

Example description: SEO work on Page 1, Page 2, and Page 3

Ticket title: ${issue.summary || 'N/A'}
Ticket description: ${withoutTimerLines(issue.description) || 'N/A'}`;
  }

  const ENTRY_SCHEMA = {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'The time entry description: a short noun phrase, without the ticket key.' },
    },
    required: ['description'],
    additionalProperties: false,
  };

  // Reads the description out of a model reply (JSON for Claude, text for Gemini).
  function descriptionFrom(res) {
    if (res.structured) {
      try { return JSON.parse(res.text || '{}').description || ''; } catch { return ''; }
    }
    return res.text || '';
  }

  // Enforces the exact format "<description> (<KEY>)": takes the first real line,
  // strips quotes/markdown/labels and any key the model added, then appends the real key.
  function cleanEntry(text, key) {
    const lines = (text || '').split('\n').map(l => l.trim()).filter(l => l && !/^```/.test(l));
    let t = lines[0] || '';
    t = t.replace(/^(description|time entry|entry)\s*:\s*/i, '');
    t = t.replace(/^[\s"'`*_-]+|[\s"'`*_.]+$/g, '').replace(/\s+/g, ' ');
    t = t.replace(/\s*\([A-Z][A-Z0-9_]+-\d+\)\s*$/, '');                     // "(ABC-12)" the model added
    if (key) t = t.replace(new RegExp(`[\\s(-]*\\b${key}\\b\\)?\\s*$`, 'i'), ''); // bare "ABC-12" at the end
    t = t.replace(/[\s.,;:-]+$/, '');
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
    const res = await complete(buildEntryPrompt(issue), { maxTokens: 2048, onStatus, schema: ENTRY_SCHEMA });
    const text = cleanEntry(descriptionFrom(res), issue.key);
    if (!text) throw new ApiError('The AI returned no description — hit ↻ to try again.');
    putCached(ck, text).catch(() => {});
    return { text, cached: false, modelId: res.modelId };
  }

  // One entry covering several tickets: "<one short description> (KEY-1, KEY-2)".
  // The model writes only the description; code appends the keys.
  async function generateCombinedEntry(issues) {
    if (issues.length === 1) return (await generateEntry(issues[0])).text;
    const keys = issues.map(i => i.key);
    const list = issues.map(i => `- ${i.key}: ${i.summary || 'N/A'}`).join('\n');
    const prompt = `You are a time-tracking assistant. One time entry covers work on several Jira tickets.

Write the DESCRIPTION part of the entry. The final entry will be exactly:
<description> (${keys.join(', ')})
The ticket keys are added automatically — do not include them.

Rules for the description:
- One short, plain-English noun phrase covering all the tickets at a high level — do NOT start with a verb
- Prefer the tickets' title wording; no labels like "PROPOSING:", no quotes, no trailing period
- One line, ideally under 12 words

Tickets:
${list}`;
    const res = await complete(prompt, { maxTokens: 2048, schema: ENTRY_SCHEMA });
    let d = descriptionFrom(res);
    d = cleanEntry(d, null) || '';
    // Remove any keys the model added anywhere at the end.
    d = d.replace(/\s*\((?:[A-Z][A-Z0-9_]+-\d+(?:\s*,\s*)?)+\)\s*$/i, '').trim();
    if (!d) throw new ApiError('The AI returned no description.');
    return `${d} (${keys.join(', ')})`;
  }

  // ── Best-fit PM project ─────────────────────────────────────
  // candidates: [{ id, name, client, parents: [..] }]. Returns a candidate id or null.
  const PICK_SCHEMA = {
    type: 'object',
    properties: {
      project: { type: 'integer', description: 'Number of the best project timer, or 0 if none fits.' },
    },
    required: ['project'],
    additionalProperties: false,
  };

  // Asks the AI to pick one of `candidates`; `about` describes the work. Returns an id or null.
  async function chooseFromList(about, candidates) {
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0].id;
    const list = candidates.map((p, i) =>
      `${i + 1}. ${p.name} — ${[...p.parents].reverse().join(' / ')} — client: ${p.client}`
    ).join('\n');
    const prompt = `${about}

Project timers:
${list}

Rules:
- Match the client first, then the service (e.g. Google Ads vs Microsoft Ads vs SEO vs website/CMS support) that best fits the work.
- Reply with ONLY the number of the best project. If none plausibly fits, reply 0.`;
    const res = await complete(prompt, { maxTokens: 1024, schema: PICK_SCHEMA });
    let n = 0;
    if (res.structured) { try { n = Number(JSON.parse(res.text || '{}').project) || 0; } catch { n = 0; } }
    else n = parseInt((res.text || '').match(/\d+/)?.[0] || '0', 10);
    return n >= 1 && n <= candidates.length ? candidates[n - 1].id : null;
  }

  function pickProject(issue, candidates) {
    const hint = timerHint(issue);
    return chooseFromList(`A developer at a digital agency is about to start a timer for this Jira ticket. Pick the project timer the work should be logged against.

Jira ticket: ${issue.key}
Jira project: ${issue.projectName || issue.projectKey || 'unknown'}
Title: ${issue.summary || 'N/A'}
${hint ? `The ticket says which timer to use: "TIMER: ${hint}" — follow it.\n` : ''}Description: ${withoutTimerLines(issue.description).slice(0, 1200) || 'N/A'}`, candidates);
  }

  // ── Email work (Gmail) ──────────────────────────────────────
  // The client is matched from email addresses only (lib/pm.js), never by the AI,
  // and addresses are never sent to the AI. The AI sees only the subject and the
  // latest message (quoted history removed, contact details redacted, capped).
  function pickEmailTimer(email, candidates) {
    return chooseFromList(`Someone at a digital agency is about to log time for reading and answering a client email. The client is already known; pick which of the client's project timers this email's work belongs to.

Subject: ${email.subject || 'N/A'}
Latest message: ${(email.body || '(not shared)').slice(0, 1500)}`, candidates);
  }

  // Note format (exact): "Correspondence with client about X, Y, and Z" — very brief and
  // high level. The model returns only 1–3 broad topics; code builds the sentence.
  const EMAIL_NOTE_BASE = 'Correspondence with client';
  const TOPICS_SCHEMA = {
    type: 'object',
    properties: {
      topics: { type: 'array', items: { type: 'string' }, description: '1-3 broad, high-level topics, 1-4 words each.' },
    },
    required: ['topics'],
    additionalProperties: false,
  };

  function emailNoteFromTopics(topics) {
    const t = (topics || [])
      .map(x => String(x).replace(/^[\s"'`*-]+|[\s"'`*.;:,]+$/g, '').replace(/\s+/g, ' '))
      .filter(x => x && x.split(' ').length <= 5)
      .map(x => (/^[A-Z][a-z]/.test(x) ? x[0].toLowerCase() + x.slice(1) : x)) // keep acronyms like SEO
      .slice(0, 3);
    if (!t.length) return EMAIL_NOTE_BASE;
    const list = t.length === 1 ? t[0] : t.length === 2 ? `${t[0]} and ${t[1]}` : `${t[0]}, ${t[1]}, and ${t[2]}`;
    return `${EMAIL_NOTE_BASE} about ${list}`;
  }

  function topicsFrom(res) {
    const raw = res.text || '';
    try {
      const json = res.structured ? JSON.parse(raw) : JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
      if (Array.isArray(json.topics)) return json.topics;
    } catch { /* fall through */ }
    return raw.split(/\n|,/).map(s => s.replace(/^\s*(\d+[.)]|[-*•])\s*/, '')).filter(Boolean);
  }

  async function generateEmailNote(email, { regenerate = false } = {}) {
    const cfg = await getConfig();
    const ck = `email:${cfg.provider}:${cfg.modelId}:${email.threadId}:${hashText(`${email.subject}\n${email.body || ''}`)}`;
    if (!regenerate) {
      const cached = await getCached(ck).catch(() => null);
      if (cached) return cached;
    }
    const prompt = `Summarize what this client email is about as 1-3 broad topics for a time entry. The entry will read:
"${EMAIL_NOTE_BASE} about <topic>, <topic>, and <topic>"

Rules:
- 1 to 3 topics; fewer is better. Each topic is 1-4 words, lowercase, generic (e.g. "campaign performance", "budget", "website updates", "SEO strategy").
- Keep it high level: no names, companies, numbers, dates, URLs, or specifics.
- Return JSON: {"topics": ["...", "..."]}

Subject: ${email.subject || 'N/A'}
Latest message: ${(email.body || '(not shared)').slice(0, 1500)}`;
    const res = await complete(prompt, { maxTokens: 1024, schema: TOPICS_SCHEMA });
    const note = emailNoteFromTopics(topicsFrom(res));
    putCached(ck, note).catch(() => {});
    return note;
  }

  globalThis.AI = {
    DEFAULT_MODELS, PROVIDER_NAMES, ApiError,
    getConfig, complete, friendlyError,
    generateEntry, generateCombinedEntry, cleanEntry, fallbackEntry, pickProject, timerHint,
    pickEmailTimer, generateEmailNote, emailNoteFromTopics, EMAIL_NOTE_BASE,
    fetchWithTimeout,
  };
})();
