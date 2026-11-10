// lib/jira.js — the single source of truth for "is this a Jira issue page, and which issue?"
// Loaded by the background page, the popup, and the content script.
(() => {
  if (globalThis.JiraUrl) return;

  const ISSUE_KEY = /([A-Z][A-Z0-9_]+-\d+)/i;

  // Returns the issue key the URL points at, or null.
  // Order matters: on boards the selectedIssue param is authoritative, because
  // the page contains many issue keys and only the URL knows which one is open.
  function issueKeyFromUrl(url) {
    let u;
    try { u = new URL(url); } catch { return null; }

    const selected = u.searchParams.get('selectedIssue');
    if (selected && ISSUE_KEY.test(selected)) return selected.toUpperCase();

    const patterns = [
      /\/browse\/([A-Z][A-Z0-9_]+-\d+)/i,                 // /browse/KEY-1
      /\/projects\/[^/]+\/issues\/([A-Z][A-Z0-9_]+-\d+)/i, // /projects/PROJ/issues/KEY-1
    ];
    for (const re of patterns) {
      const m = u.pathname.match(re);
      if (m) return m[1].toUpperCase();
    }
    return null;
  }

  function isBoardUrl(url) {
    return /\/secure\/RapidBoard\.jspa/i.test(url) || /\/jira\/software\/.*\/boards\//i.test(url);
  }

  // A Jira page the extension can work with: an issue page, or a board
  // (where the user may not have selected an issue yet).
  function isJiraUrl(url) {
    if (!url) return false;
    return !!issueKeyFromUrl(url) || isBoardUrl(url) || /atlassian\.net\/(browse|jira)\//i.test(url);
  }

  function projectKeyOf(issueKey) {
    return (issueKey || '').split('-')[0].toUpperCase();
  }

  globalThis.JiraUrl = { issueKeyFromUrl, isBoardUrl, isJiraUrl, projectKeyOf };
})();
