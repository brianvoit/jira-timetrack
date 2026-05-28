// content.js — supports /browse/ issue pages AND RapidBoard planning/sprint views

function getIssueKeyFromUrl() {
  // RapidBoard: ?selectedIssue=PROJ-123
  const params = new URLSearchParams(window.location.search);
  const selected = params.get('selectedIssue');
  if (selected) return selected.toUpperCase();

  // Standard browse URL: /browse/PROJ-123
  const match = window.location.pathname.match(/\/browse\/([A-Z][A-Z0-9]+-\d+)/i);
  if (match) return match[1].toUpperCase();

  return null;
}

function scrapeJiraIssue() {
  const result = { key: null, summary: null, description: null };

  // ── Issue Key ──────────────────────────────────────────────
  // Try DOM first, fall back to URL
  const keyEl =
    document.querySelector('[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]') ||
    document.querySelector('#key-val') ||
    document.querySelector('[data-issue-key]') ||
    document.querySelector('.ghx-detail-issue-key') ||
    document.querySelector('#ghx-detail-issue-key');

  result.key = keyEl ? keyEl.textContent.trim() : getIssueKeyFromUrl();

  // ── Summary / Title ────────────────────────────────────────
  // RapidBoard detail panel selectors first, then standard page selectors
  const summaryEl =
    // RapidBoard side panel (Jira Server)
    document.querySelector('#ghx-detail-issue-title') ||
    document.querySelector('.ghx-detail-issue-title') ||
    document.querySelector('.issue-title') ||
    document.querySelector('[data-field-id="summary"] .value') ||
    // Standard issue page (Jira Cloud)
    document.querySelector('h1[data-testid="issue.views.issue-base.foundation.summary.heading"]') ||
    document.querySelector('[data-testid*="summary"] h1') ||
    // Standard issue page (Jira Server)
    document.querySelector('#summary-val') ||
    document.querySelector('h1[class*="Summary"]') ||
    document.querySelector('h1');

  if (summaryEl) result.summary = summaryEl.textContent.trim();

  // ── Description ────────────────────────────────────────────
  // RapidBoard shows a limited detail panel — description may be truncated or absent
  const descEl =
    // RapidBoard panel description
    document.querySelector('.ghx-detail-description .ghx-description') ||
    document.querySelector('#ghx-detail-contents .description .value') ||
    document.querySelector('[data-field-id="description"] .value') ||
    document.querySelector('.gh-detail-description') ||
    // Jira Cloud full page
    document.querySelector('[data-testid="issue.views.issue-base.foundation.description.rendered-field"]') ||
    document.querySelector('[data-testid*="description"] [class*="renderer"]') ||
    // Jira Server full page
    document.querySelector('#description-val') ||
    document.querySelector('#description .user-content-block') ||
    document.querySelector('[class*="description"] [class*="content"]');

  if (descEl) {
    result.description = descEl.innerText
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (result.description.length > 1400) {
      result.description = result.description.substring(0, 1400) + '…';
    }
  }

  return result;
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SCRAPE_JIRA') {
    return Promise.resolve(scrapeJiraIssue());
  }
});
