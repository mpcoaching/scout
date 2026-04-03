// LinkedIn Scout — Google Auto-Scraper
// Runs on google.com/search pages, extracts LinkedIn profiles and sends to storage

function scrapeLinkedInProfiles() {
  const items = [];
  const seen = new Set();

  const allLinks = document.querySelectorAll('a[href*="linkedin.com/in/"]');
  allLinks.forEach(link => {
    let url = link.href;
    if (url.includes('/url?') || url.includes('google.com/url')) {
      try {
        const u = new URL(url);
        url = u.searchParams.get('q') || u.searchParams.get('url') || url;
      } catch(e) {}
    }
    const match = url.match(/(https?:\/\/[a-z.]*linkedin\.com\/in\/[^/?#\s]+)/);
    if (!match) return;
    url = match[1];
    if (seen.has(url)) return;
    seen.add(url);

    let container = link;
    for (let i = 0; i < 8; i++) {
      container = container.parentElement;
      if (!container) break;
    }

    const titleEl = container ? container.querySelector('h3') : null;
    const name = titleEl ? titleEl.innerText.trim() : '';

    let snippet = '';
    if (container) {
      const selectors = ['[data-sncf="1"]','[data-sncf="2"]','.VwiC3b','.lEBKkf','.IsZvec','span[jsname]','div[style*="webkit-line-clamp"]','.aCOpRe'];
      for (const sel of selectors) {
        const el = container.querySelector(sel);
        if (el && el.innerText.trim().length > 20) {
          snippet = el.innerText.trim().substring(0, 220);
          break;
        }
      }
    }
    items.push({ url, name, snippet });
  });

  return items;
}

function doAutoScrape() {
  const profiles = scrapeLinkedInProfiles();
  if (profiles.length > 0) {
    chrome.runtime.sendMessage({
      action: 'autoScrapeResults',
      profiles: profiles,
      pageUrl: window.location.href
    });
  }
}

// Wait for page to fully render then scrape
// Use MutationObserver to detect when results have loaded
let scrapeTimer = null;
let scraped = false;

function scheduleScrapeSoon() {
  if (scraped) return;
  clearTimeout(scrapeTimer);
  scrapeTimer = setTimeout(() => {
    if (scraped) return;
    const profiles = scrapeLinkedInProfiles();
    if (profiles.length > 0) {
      scraped = true;
      chrome.runtime.sendMessage({
        action: 'autoScrapeResults',
        profiles: profiles,
        pageUrl: window.location.href
      });
    }
  }, 1200);
}

// Trigger on initial load
if (document.readyState === 'complete') {
  scheduleScrapeSoon();
} else {
  window.addEventListener('load', scheduleScrapeSoon);
}

// Also observe for dynamic content
const observer = new MutationObserver(() => {
  if (!scraped) scheduleScrapeSoon();
});
observer.observe(document.body, { childList: true, subtree: true });

// Listen for manual scrape request from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'manualScrape') {
    const profiles = scrapeLinkedInProfiles();
    sendResponse({ profiles });
  }
  return true;
});
