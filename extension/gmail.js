// gmail.js — runs on mail.google.com. Adds the shared "Start timer" button to an open
// email thread (one PM entry per thread) and pauses that timer when you send a reply.
//
// Privacy: the client is matched from email ADDRESSES only (in the background, no AI).
// The AI only sees the subject and the latest message, with quoted history removed,
// email addresses / phone numbers redacted, and length capped — or the subject alone
// if "Use email text" is off in settings.
(() => {
  if (window.__jiraTimeHelperGmail) return;
  window.__jiraTimeHelperGmail = true;

  const BODY_LIMIT = 1500;

  // Gmail URLs look like #inbox/FMfcgzQ…, #label/Clients/FMfcg…, #search/foo/FMfcg….
  // The thread id is the last segment when a thread is open ("#inbox" or "#inbox/p2" are lists).
  function threadIdFromUrl() {
    const parts = location.hash.replace(/^#/, '').split('?')[0].split('/');
    const last = parts[parts.length - 1];
    return parts.length >= 2 && /^[A-Za-z0-9_-]{16,}$/.test(last) ? last : null;
  }

  function main() {
    return document.querySelector('div[role="main"]') || document.body;
  }

  // An open thread = thread id in the URL and a subject on screen.
  function openThreadId() {
    const id = threadIdFromUrl();
    return id && main().querySelector('h2.hP, h2[data-thread-perm-id]') ? id : null;
  }

  function ownAddress() {
    // Page title: "Subject - you@company.com - Company Mail"
    return (document.title.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/) || [])[0] || null;
  }

  function redact(text) {
    return text
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
      .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, '[phone]')
      .replace(/https?:\/\/\S+/g, '[link]');
  }

  // Text of the latest expanded message, without quoted history or signature.
  function latestMessageText() {
    const bodies = [...main().querySelectorAll('div.a3s')].filter(el => el.offsetParent !== null);
    const last = bodies[bodies.length - 1];
    if (!last) return '';
    const clone = last.cloneNode(true);
    clone.querySelectorAll('.gmail_quote, blockquote, .gmail_signature, .gmail_extra').forEach(n => n.remove());
    // A detached copy has no layout, so innerText won't add line breaks — add them for <br> and blocks.
    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    clone.querySelectorAll('div, p, li, tr').forEach(el => el.append('\n'));
    let text = clone.textContent || '';
    text = text.split(/\n\s*On .{5,200}wrote:\s*\n/)[0];       // "On Mon, … wrote:" reply header
    text = text.split(/\n-{2,}\s*Original Message\s*-{2,}/i)[0];
    text = redact(text.replace(/\n{3,}/g, '\n\n').trim());
    return text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) + '…' : text;
  }

  async function readEmail() {
    const threadId = openThreadId();
    if (!threadId) throw new Error('Open an email thread first.');
    const m = main();
    const subject = (m.querySelector('h2.hP, h2[data-thread-perm-id]')?.textContent || document.title.split(' - ')[0]).trim();
    const addresses = [...new Set([...m.querySelectorAll('[email]')].map(el => el.getAttribute('email')).filter(Boolean))];
    const own = ownAddress();
    const { emailUseBody } = await browser.storage.local.get('emailUseBody');
    return {
      threadId,
      subject,
      addresses,
      ownDomain: own ? own.split('@')[1].toLowerCase() : null,
      body: emailUseBody === false ? '' : latestMessageText(),
    };
  }

  // ── Round timer button in Gmail's Reply all / Reply / Forward row ──────
  // Gmail shows that row once, under the last message of the thread. The button copies the
  // Forward button's size and colours so it fits whatever theme (or Stylist restyle) is on.
  // If the row can't be found, the floating panel stays as the way to start the timer.
  const INLINE_STYLE = `
    :host { all: initial; display: inline-flex; vertical-align: middle; }
    button {
      box-sizing: border-box; display: grid; place-items: center; padding: 0; margin: 0; cursor: pointer;
      width: var(--size, 36px); height: var(--size, 36px); border-radius: 50%;
      background: var(--bg, #e8f0fe); color: var(--fg, #0b57d0); border: var(--border, 0); box-shadow: var(--shadow, none);
      transition: background-color 150ms, color 150ms, box-shadow 150ms, filter 120ms;
    }
    button:hover { filter: brightness(.95); }
    button:active { transform: translateY(1px); }
    button:focus-visible { outline: 2px solid var(--fg, #0b57d0); outline-offset: 2px; }
    svg { width: 55%; height: 55%; }
    .pause { display: none; }
    button.running { background: #28b04b; color: #fff; border-color: transparent; box-shadow: 0 0 0 3px rgba(40, 176, 75, .25); }
    button.running:hover .watch { display: none; }
    button.running:hover .pause { display: block; }
    button.busy { cursor: progress; }
    button.busy .watch { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }`;

  let inline = null;      // { host, btn }
  let inlineThread = null; // thread whose reply row has had the button (→ compact panel)
  let inlineState = { busy: false, running: null };

  function replyRow() {
    const visible = el => el.offsetParent !== null;
    const rows = [...main().querySelectorAll('.amn')].filter(visible);
    if (rows.length) return rows[rows.length - 1];
    // Fallback: the parent of the last visible "Forward" control that also holds "Reply".
    const fwd = [...main().querySelectorAll('[role="link"], [role="button"], button')]
      .filter(el => visible(el) && /^forward$/i.test(el.textContent.trim()));
    const last = fwd[fwd.length - 1];
    return last && /reply/i.test(last.parentElement?.textContent || '') ? last.parentElement : null;
  }

  function buildInline() {
    const host = document.createElement('span');
    host.className = 'jira-time-helper-inline';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = INLINE_STYLE;
    const tpl = document.createElement('template');
    tpl.innerHTML = `<button type="button" aria-label="Start PM timer for this email">
      <svg class="watch" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="14" r="8"/><path d="M12 10v4l2.5 2"/><path d="M10 2h4"/><path d="M19 6l-1.5 1.5"/>
      </svg>
      <svg class="pause" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/></svg>
    </button>`;
    root.append(style, tpl.content);
    const btn = root.querySelector('button');
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); // keep Gmail from treating it as a row click
      if (inlineState.busy) return;
      if (inlineState.running) widget.pause(); else widget.start();
    });
    btn.addEventListener('mouseenter', paintInline);
    return { host, btn };
  }

  // Match the row's buttons: size from Forward, colours from Forward (a secondary button).
  function matchRow(row) {
    const kids = [...row.children].filter(el => el !== inline.host && el.offsetParent !== null);
    const fwd = kids.find(el => /^forward$/i.test(el.textContent.trim())) || kids[kids.length - 1];
    if (!fwd) return;
    const cs = getComputedStyle(fwd);
    const r = fwd.getBoundingClientRect();
    const h = inline.host.style;
    h.setProperty('--size', `${Math.round(Math.max(28, Math.min(48, r.height)))}px`);
    h.setProperty('--bg', cs.backgroundColor);
    h.setProperty('--fg', cs.color);
    h.setProperty('--border', `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`);
    h.setProperty('--shadow', cs.boxShadow);
    // Same spacing as between Reply and Forward (unless the row already uses a flex gap).
    const prev = fwd.previousElementSibling;
    const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
    const space = prev ? Math.round(r.left - prev.getBoundingClientRect().right) : 8;
    h.marginLeft = gap ? '0' : `${Math.max(4, Math.min(24, space))}px`;
  }

  function ensureInline() {
    const threadId = openThreadId();
    const row = threadId ? replyRow() : null;
    if (!row) return;
    if (!inline) inline = buildInline();
    if (inline.host.parentElement !== row) {
      row.appendChild(inline.host);
      matchRow(row);
    }
    inlineThread = threadId;
  }

  function paintInline() {
    if (!inline) return;
    const { busy, running } = inlineState;
    inline.btn.classList.toggle('running', !!running && !busy);
    inline.btn.classList.toggle('busy', busy);
    const label = busy ? 'Working…'
      : running ? `PM timer running${running.startedAt ? ` · ${fmtElapsed(Date.now() - running.startedAt)}` : ''} — click to pause`
      : 'Start PM timer for this email';
    inline.btn.title = label;
    inline.btn.setAttribute('aria-label', label);
  }
  const fmtElapsed = ms => {
    const m = Math.max(0, Math.floor(ms / 60000));
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  };

  const widget = TimerWidget.createWidget({
    compact: () => !!openThreadId() && inlineThread === openThreadId(),
    currentKey: openThreadId,
    label: () => 'this email',
    read: readEmail,
    startMessage: (email, opts) => ({ type: 'PM_START_EMAIL', email, ...opts }),
    runningFor: (status, threadId, ctx) => {
      const entryId = ctx?.emailEntries?.[threadId]?.entryId;
      return entryId ? status.running.find(r => r.id === entryId) : null;
    },
    remember: email => ({
      type: 'email', threadId: email?.threadId, addresses: email?.addresses || [], ownDomain: email?.ownDomain,
    }),
  });

  // ── Pause on send ─────────────────────────────────────────────
  let lastSent = 0;
  async function onSent() {
    const threadId = openThreadId();
    if (!threadId || Date.now() - lastSent < 3000) return;
    lastSent = Date.now();
    const res = await browser.runtime.sendMessage({ type: 'PM_EMAIL_SENT', threadId }).catch(e => ({ error: String(e) }));
    if (res?.paused) widget.notify('Reply sent — paused this email’s timer.', 'ok', res);
    else if (res?.error) widget.notify(res.error, 'err');
  }

  // Gmail's Send button: role=button with a tooltip/label starting "Send" (e.g. "Send ‪(⌘Enter)‬").
  document.addEventListener('click', (e) => {
    const btn = e.target.closest?.('[role="button"]');
    if (!btn) return;
    const label = (btn.getAttribute('data-tooltip') || btn.getAttribute('aria-label') || '').trim();
    if (/^send\b/i.test(label) && !/feedback/i.test(label)) onSent();
  }, true);
  // ⌘/Ctrl+Enter in a compose box.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && e.target.closest?.('[contenteditable="true"], [role="textbox"]')) onSent();
  }, true);

  browser.storage.local.get('showGmailButton').then(({ showGmailButton }) => {
    if (showGmailButton === false) return;
    widget.onChange(state => { inlineState = state; paintInline(); });
    const tick = () => { ensureInline(); widget.sync(); };
    tick();
    setInterval(tick, 1000);
    setInterval(() => { if (document.visibilityState === 'visible') widget.refreshStatus(); }, 60 * 1000);
  });
})();
