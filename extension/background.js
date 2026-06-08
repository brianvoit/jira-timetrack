// background.js — sets toolbar badge when the active tab is a Jira page

function isJiraUrl(url) {
  if (!url) return false;
  return (
    /atlassian\.net/i.test(url) ||
    /\/browse\/[A-Z]/i.test(url) ||
    /\/secure\/RapidBoard\.jspa/i.test(url) ||
    /\/jira\/software\/.*\/boards\//i.test(url) ||
    /\/projects\/[^/]+\/issues\/[A-Z]/i.test(url)
  );
}

function updateBadge(tabId, url) {
  if (isJiraUrl(url)) {
    browser.browserAction.setBadgeText({ tabId, text: '●' });
    browser.browserAction.setBadgeBackgroundColor({ tabId, color: '#16a34a' });
  } else {
    browser.browserAction.setBadgeText({ tabId, text: '' });
  }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url !== undefined) updateBadge(tabId, changeInfo.url);
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await browser.tabs.get(tabId);
    updateBadge(tabId, tab.url);
  } catch {}
});
