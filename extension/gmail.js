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

  const widget = TimerWidget.createWidget({
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
    widget.sync();
    setInterval(() => widget.sync(), 1000);
    setInterval(() => { if (document.visibilityState === 'visible') widget.refreshStatus(); }, 60 * 1000);
  });
})();
