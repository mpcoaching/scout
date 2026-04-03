// LinkedIn Scout — Content Script v15.3
// Responsibilities:
//   1. Extract page data and send to background
//   2. Handle SPA navigation — re-trigger capture on profile changes
//   3. Execute DOM actions when background instructs
//   4. Nothing else

// ── Extraction ────────────────────────────────────────────────

function extractProfileData() {
  const data = {
    url:         window.location.href,
    extractedAt: new Date().toISOString(),
    name:        '',
    rawText:     '',
    websiteUrls: [],
  };

  // Name — title first, set by LinkedIn's router before DOM renders
  const titleMatch = document.title.match(/^([^|\-]+)/);
  if (titleMatch) data.name = titleMatch[1].trim();

  // Fallback to any heading if title doesn't have a name
  if (!data.name || data.name.toLowerCase().includes('linkedin')) {
    const heading = document.querySelector('h1, h2');
    if (heading) data.name = heading.innerText.trim().substring(0, 100);
  }

  // External URLs
  document.querySelectorAll('a[href]').forEach(a => {
    const href = a.href;
    if (href && !href.includes('linkedin.com') &&
        !href.includes('javascript') && !href.includes('mailto') &&
        href.startsWith('http') && !data.websiteUrls.includes(href)) {
      data.websiteUrls.push(href);
    }
  });

  // Raw text — clone and strip noise, grab everything else
  // Deliberately broad — let the AI parse it, not the scraper
  const clone = document.body.cloneNode(true);
  ['script','style','nav','footer','header','button',
   '[class*="nav"]','[class*="footer"]','[role="button"]'
  ].forEach(sel => {
    try { clone.querySelectorAll(sel).forEach(el => el.remove()); }
    catch(e) {}
  });

  data.rawText = (clone.innerText || '')
    .split('\n').map(l => l.trim()).filter(l => l.length > 1)
    .filter((l,i,a) => i === 0 || l !== a[i-1])
    .join('\n').substring(0, 4000);

  return data;
}

function extractPostData() {
  const data = {
    url:         window.location.href,
    extractedAt: new Date().toISOString(),
    postText:    '',
    authorName:  '',
    authorUrl:   '',
    stats:       { reactions: 0, comments: 0, reposts: 0 },
    comments:    [],
  };

  const authorEl = document.querySelector(
    '.update-components-actor__name span[aria-hidden="true"], ' +
    '.feed-shared-actor__name'
  );
  if (authorEl) data.authorName = authorEl.innerText.trim();

  const authorLink = document.querySelector(
    '.update-components-actor__container a'
  );
  if (authorLink) {
    const m = authorLink.href.match(/linkedin\.com\/in\/([^/?]+)/);
    if (m) data.authorUrl = `https://www.linkedin.com/in/${m[1]}/`;
  }

  const postTextEl = document.querySelector(
    '.feed-shared-update-v2__description, .update-components-text'
  );
  if (postTextEl) data.postText = postTextEl.innerText.trim().substring(0, 2000);

  document.querySelectorAll(
    '.comments-comment-item, .feed-shared-comment-item'
  ).forEach(el => {
    const nameEl = el.querySelector(
      '.comments-post-meta__name-text, .feed-shared-comment__author-name'
    );
    const textEl = el.querySelector(
      '.comments-comment-item__main-content, .feed-shared-comment__text'
    );
    const linkEl = el.querySelector('a[href*="linkedin.com/in/"]');
    const comment = {
      commenterName: nameEl?.innerText.trim() || '',
      commenterUrl:  '',
      text:          textEl?.innerText.trim() || '',
    };
    if (linkEl) {
      const m = linkEl.href.match(/linkedin\.com\/in\/([^/?]+)/);
      if (m) comment.commenterUrl = `https://www.linkedin.com/in/${m[1]}/`;
    }
    if (comment.text.length > 2) data.comments.push(comment);
  });

  return data;
}

// ── Profile capture ───────────────────────────────────────────
// Resilient capture using title + body text volume as signals.
// Does not rely on specific DOM elements LinkedIn can change.
// Polls every 500ms until confident the page has loaded, then fires once.

const SUBPAGES = ['/recent-activity','/posts/','/detail/',
                  '/overlay/','/edit/','/skills/'];

let _captureInterval = null;
let _capturedUrls    = new Set(); // prevent double-capture within session

function isProfileUrl(url) {
  return url.includes('linkedin.com/in/') &&
         !SUBPAGES.some(s => url.includes(s));
}

function startCapture(url) {
  // Don't re-capture same URL in this session
  if (_capturedUrls.has(url)) return;

  // Clear any previous capture loop
  if (_captureInterval) clearInterval(_captureInterval);

  let attempts = 0;
  const maxAttempts = 30; // 15 seconds at 500ms

  _captureInterval = setInterval(() => {
    attempts++;

    // Title is set by LinkedIn's router — reliable across DOM changes
    const titleMatch = document.title.match(/^([^|\-]+)/);
    const name = titleMatch?.[1]?.trim() || '';
    const hasName = name.length > 2 && !name.toLowerCase().includes('linkedin');

    // Body text volume indicates profile content has loaded
    const bodyText = document.body?.innerText || '';
    const hasText  = bodyText.length > 500;

    if (hasName && hasText) {
      clearInterval(_captureInterval);
      _captureInterval = null;

      const data = extractProfileData();
      if (!data.rawText || data.rawText.length < 100) return;

      _capturedUrls.add(url);

      chrome.runtime.sendMessage({
        action:  'autoCapture',
        profile: {
          url:           data.url,
          name:          data.name,
          rawText:       data.rawText,
          websiteUrls:   data.websiteUrls,
          captureSource: 'AUTO_BROWSE',
          capturedAt:    data.extractedAt,
        }
      }).catch(() => {}); // silent — background handles errors
    }

    if (attempts >= maxAttempts) {
      clearInterval(_captureInterval);
      _captureInterval = null;
    }
  }, 500);
}

// ── SPA navigation ────────────────────────────────────────────
// LinkedIn is a SPA — full page loads only happen once.
// navigation API fires on every route change with zero polling overhead.

if (typeof navigation !== 'undefined') {
  navigation.addEventListener('navigate', (e) => {
    const url = e.destination.url;
    if (isProfileUrl(url)) {
      // Small delay to let LinkedIn's router commit the navigation
      setTimeout(() => startCapture(url), 300);
    }
  });
}

// Initial load — handles the first page load (not a SPA navigation)
if (isProfileUrl(window.location.href)) {
  startCapture(window.location.href);
}

// ── Message listener ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  if (request.action === 'extractProfile') {
    sendResponse({ success: true, data: extractProfileData() });
    return true;
  }

  if (request.action === 'extractPost') {
    sendResponse({ success: true, data: extractPostData() });
    return true;
  }

  if (request.action === 'executeFollow') {
    const followBtn = [...document.querySelectorAll('button')]
      .find(b => b.textContent.trim().toLowerCase() === 'follow');
    if (followBtn) {
      followBtn.click();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Follow button not found' });
    }
    return true;
  }

  if (request.action === 'manualScrape') {
    const profiles = scrapeGoogleResults();
    sendResponse({ profiles });
    return true;
  }

});

// ── Google scrape (only runs on google.com/search) ────────────

function scrapeGoogleResults() {
  const profiles = [];
  document.querySelectorAll('a[href]').forEach(a => {
    const match = a.href.match(
      /https?:\/\/(www\.)?linkedin\.com\/in\/([^/?#&"]+)/
    );
    if (!match) return;
    const url  = `https://www.linkedin.com/in/${match[2]}/`;
    const name = a.closest('[data-hveid]')?.querySelector('h3')?.innerText ||
                 a.innerText.trim() || '';
    const snip = a.closest('[data-hveid]')
                  ?.querySelector('.VwiC3b, .lEBKkf')
                  ?.innerText || '';
    if (url && !profiles.find(p => p.url === url)) {
      profiles.push({ url, name: name.substring(0, 100),
                      snippet: snip.substring(0, 200) });
    }
  });
  return profiles;
}
// LinkedIn Scout — Overlay
// Injected onto LinkedIn profile pages to show enrichment data inline
// Appended to content.js — do not load separately

(function ScoutOverlay() {

  const OVERLAY_ID = 'scout-overlay-panel';

  // ── Inject styles ─────────────────────────────────────────

  const style = document.createElement('style');
  style.textContent = `
    #scout-overlay-panel {
      position: fixed;
      top: 72px;
      right: 16px;
      width: 260px;
      z-index: 9999;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 12px;
      pointer-events: auto;
    }
    #scout-overlay-panel .so-card {
      background: #0a0a0a;
      border: 1px solid #222;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 4px 24px rgba(0,0,0,0.6);
    }
    #scout-overlay-panel .so-header {
      background: #1F4E79;
      padding: 6px 10px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
    }
    #scout-overlay-panel .so-title {
      color: white;
      font-size: 10px;
      font-weight: bold;
      letter-spacing: 0.8px;
      text-transform: uppercase;
    }
    #scout-overlay-panel .so-close {
      color: rgba(255,255,255,0.6);
      font-size: 14px;
      cursor: pointer;
      line-height: 1;
      padding: 0 2px;
    }
    #scout-overlay-panel .so-body {
      padding: 8px 10px;
    }
    #scout-overlay-panel .so-rag {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 8px;
      border-radius: 4px;
      margin-bottom: 6px;
    }
    #scout-overlay-panel .so-rag-label {
      font-size: 12px;
      font-weight: bold;
    }
    #scout-overlay-panel .so-priority {
      font-size: 18px;
      font-weight: bold;
      color: white;
    }
    #scout-overlay-panel .so-type {
      font-size: 9px;
    }
    #scout-overlay-panel .so-icp {
      font-size: 10px;
      color: #888;
    }
    #scout-overlay-panel .so-action {
      background: #0d1a2b;
      border-radius: 4px;
      padding: 5px 8px;
      margin-bottom: 6px;
    }
    #scout-overlay-panel .so-action-label {
      font-size: 9px;
      color: #2E75B6;
      font-weight: bold;
    }
    #scout-overlay-panel .so-action-reason {
      font-size: 9px;
      color: #666;
      margin-top: 2px;
      line-height: 1.4;
    }
    #scout-overlay-panel .so-bait {
      background: #0a0a14;
      border: 1px solid #1a1a2e;
      border-radius: 4px;
      padding: 6px 8px;
      margin-bottom: 6px;
    }
    #scout-overlay-panel .so-bait-label {
      font-size: 9px;
      color: #2E75B6;
      margin-bottom: 3px;
    }
    #scout-overlay-panel .so-bait-text {
      font-size: 9px;
      color: #aaa;
      line-height: 1.5;
    }
    #scout-overlay-panel .so-btn {
      display: inline-block;
      margin-top: 5px;
      background: #1F4E79;
      color: white;
      border: none;
      border-radius: 3px;
      padding: 3px 8px;
      font-size: 9px;
      cursor: pointer;
    }
    #scout-overlay-panel .so-btn:hover { opacity: 0.85; }
    #scout-overlay-panel .so-signal {
      font-size: 9px;
      color: #666;
      margin-bottom: 3px;
      line-height: 1.4;
    }
    #scout-overlay-panel .so-lever {
      font-size: 9px;
      color: #555;
      margin-bottom: 3px;
    }
    #scout-overlay-panel .so-status {
      font-size: 10px;
      color: #555;
      text-align: center;
      padding: 8px;
    }
    #scout-overlay-panel .so-minimised .so-body {
      display: none;
    }
    #scout-overlay-toggle {
      position: fixed;
      top: 72px;
      right: 16px;
      width: 32px;
      height: 32px;
      background: #1F4E79;
      border-radius: 50%;
      display: none;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 9999;
      font-size: 14px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      color: white;
    }
  `;
  document.head.appendChild(style);

  // ── Create overlay DOM ────────────────────────────────────

  function createOverlay() {
    if (document.getElementById(OVERLAY_ID)) return;

    const panel = document.createElement('div');
    panel.id = OVERLAY_ID;
    panel.innerHTML = `
      <div class="so-card">
        <div class="so-header" id="so-header">
          <span class="so-title">🔍 Scout</span>
          <span class="so-close" id="so-close">×</span>
        </div>
        <div class="so-body" id="so-body">
          <div class="so-status" id="so-status">Waiting for profile data...</div>
        </div>
      </div>`;
    document.body.appendChild(panel);

    document.getElementById('so-header')?.addEventListener('click', () => {
      panel.querySelector('.so-card').classList.toggle('so-minimised');
    });

    document.getElementById('so-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.style.display = 'none';
    });
  }

  // ── Render overlay content ────────────────────────────────

  function renderOverlay(profile) {
    const body = document.getElementById('so-body');
    if (!body) return;

    if (!profile || profile.enrichStatus !== 'ENRICHED') {
      const statusText = {
        CAPTURED:   '○ Captured — queued for analysis',
        QUEUED:     '○ Queued for enrichment...',
        SENT:       '⏳ Sent for enrichment...',
        PROCESSING: '⏳ Enriching...',
        FAILED:     '✗ Enrichment failed',
      };
      body.innerHTML = `<div class="so-status">${statusText[profile?.enrichStatus] || '○ Not yet captured'}</div>`;
      return;
    }

    const ragColors = { GREEN:'#2d7a2d', AMBER:'#C07000', RED:'#C00000' };
    const ragBgs    = { GREEN:'#0d2b0d', AMBER:'#2b1a00', RED:'#2b0000' };
    const rc  = ragColors[profile.rag] || '#333';
    const rbc = ragBgs[profile.rag]    || '#111';

    const typeLabels = {
      ICP:'✓ ICP', ICP_LEADER:'👑 ICP Leader',
      OTHER_LEADER:'👑 Leader', ADJACENT:'~ Adjacent', UNKNOWN:'? Unknown'
    };

    body.innerHTML = `
      <div class="so-rag" style="background:${rbc};border:1px solid ${rc}">
        <div>
          <div class="so-rag-label" style="color:${rc}">● ${profile.rag}</div>
          <div class="so-type" style="color:${rc};opacity:0.8">${typeLabels[profile.type]||profile.type||'—'}</div>
        </div>
        <div class="so-priority">P${profile.priority||0}</div>
        ${profile.icpScore != null ? `<div class="so-icp">ICP<br>${profile.icpScore}/10</div>` : ''}
      </div>

      ${profile.action ? `
        <div class="so-action">
          <div class="so-action-label">→ ${profile.action}${profile.painUrgency && profile.painUrgency !== 'NONE' ? ` · <span style="color:${profile.painUrgency==='HIGH'?'#C00000':'#C07000'}">${profile.painUrgency}</span>` : ''}</div>
          ${profile.actionReason ? `<div class="so-action-reason">${profile.actionReason.substring(0,100)}</div>` : ''}
        </div>` : ''}

      ${profile.thoughtBait ? `
        <div class="so-bait">
          <div class="so-bait-label">💬 Comment starter</div>
          <div class="so-bait-text" id="so-bait-text">${profile.thoughtBait.substring(0,160)}${profile.thoughtBait.length > 160 ? '…' : ''}</div>
          <button class="so-btn" id="so-copy-bait">Copy comment</button>
        </div>` : ''}

      ${profile.painSignal ? `<div class="so-signal">⚡ ${profile.painSignal}</div>` : ''}
      ${profile.lever      ? `<div class="so-lever">⚙ ${profile.lever.substring(0,80)}</div>` : ''}
      ${profile.keySignal  ? `<div class="so-lever" style="font-style:italic">"${profile.keySignal.substring(0,80)}"</div>` : ''}

      <div style="display:flex;gap:4px;margin-top:6px">
        <button class="so-btn log-comment-btn" style="flex:1;text-align:center">💬 Commented</button>
        <button class="so-btn log-message-btn" style="flex:1;text-align:center;background:#2d5a2d">✉ Messaged</button>
      </div>`;

    document.getElementById('so-copy-bait')?.addEventListener('click', (e) => {
      navigator.clipboard.writeText(profile.thoughtBait || '');
      e.target.textContent = '✓ Copied!';
      setTimeout(() => { e.target.textContent = 'Copy comment'; }, 2000);
    });

    body.querySelector('.log-comment-btn')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        action: 'logInteraction',
        url: window.location.href,
        type: 'COMMENT',
        text: '',
      }).catch(() => {});
    });

    body.querySelector('.log-message-btn')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        action: 'logInteraction',
        url: window.location.href,
        type: 'MESSAGE',
        text: '',
      }).catch(() => {});
    });
  }

  // ── Load profile data ─────────────────────────────────────

  function loadAndRender(url) {
    const panel = document.getElementById(OVERLAY_ID);
    if (!panel) return;

    chrome.storage.local.get(['scout_profiles'], (data) => {
      const profiles = data.scout_profiles || {};
      const m        = url.match(/linkedin\.com\/in\/([^/?#]+)/);
      const key      = m ? `https://www.linkedin.com/in/${m[1]}/` : url;
      const profile  = profiles[key] || null;
      renderOverlay(profile);
    });
  }

  // ── Storage listener — update overlay when enrichment arrives ─

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.scout_profiles) return;
    const url = window.location.href;
    if (!url.includes('linkedin.com/in/')) return;
    const m   = url.match(/linkedin\.com\/in\/([^/?#]+)/);
    const key = m ? `https://www.linkedin.com/in/${m[1]}/` : url;
    const profile = (changes.scout_profiles.newValue || {})[key];
    if (profile) renderOverlay(profile);
  });

  // ── Init and SPA navigation ───────────────────────────────

  function init(url) {
    if (!url.includes('linkedin.com/in/')) {
      const panel = document.getElementById(OVERLAY_ID);
      if (panel) panel.style.display = 'none';
      return;
    }

    const subPages = ['/recent-activity','/posts/','/detail/','/overlay/','/edit/','/skills/'];
    if (subPages.some(s => url.includes(s))) return;

    createOverlay();
    const panel = document.getElementById(OVERLAY_ID);
    if (panel) panel.style.display = 'block';

    loadAndRender(url);
  }

  // Hook into SPA navigation — same navigation listener as capture
  if (typeof navigation !== 'undefined') {
    navigation.addEventListener('navigate', (e) => {
      setTimeout(() => init(e.destination.url), 500);
    });
  }

  // Initial load
  init(window.location.href);

})();