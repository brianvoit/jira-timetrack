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

  const urlParams    = new URLSearchParams(window.location.search);
  const selectedIssue = urlParams.get('selectedIssue');

  // ── Issue Key ──────────────────────────────────────────────
  if (selectedIssue) {
    // RapidBoard: the selectedIssue URL param is always authoritative.
    // Do NOT touch the DOM — the backlog list contains many [data-issue-key]
    // elements and the first one matched is almost never the selected issue.
    result.key = selectedIssue.toUpperCase();
  } else {
    // Standard browse page: DOM is reliable here (single issue rendered).
    const keyEl =
      document.querySelector('[data-testid="issue.views.issue-base.foundation.breadcrumbs.current-issue.item"]') ||
      document.querySelector('#key-val') ||
      document.querySelector('[data-issue-key]') ||
      document.querySelector('.ghx-detail-issue-key') ||
      document.querySelector('#ghx-detail-issue-key');
    result.key = keyEl ? keyEl.textContent.trim() : getIssueKeyFromUrl();
  }

  // ── Summary / Title ────────────────────────────────────────
  // On RapidBoard, restrict to the right-side detail panel only.
  // Falling back to `h1` is unsafe there — it can grab sprint/board headings.
  const summaryEl = selectedIssue
    ? (
        document.querySelector('#ghx-detail-issue-title') ||
        document.querySelector('.ghx-detail-issue-title') ||
        document.querySelector('.issue-title') ||
        document.querySelector('[data-field-id="summary"] .value')
      )
    : (
        document.querySelector('h1[data-testid="issue.views.issue-base.foundation.summary.heading"]') ||
        document.querySelector('[data-testid*="summary"] h1') ||
        document.querySelector('#summary-val') ||
        document.querySelector('h1[class*="Summary"]') ||
        document.querySelector('h1')
      );

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
