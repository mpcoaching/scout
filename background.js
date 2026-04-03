// LinkedIn Scout — Background Service Worker
// Single message pump. All logic delegated to EventBus handlers.
// Imports: event_bus.js, api_client.js, db.js (via importScripts)

importScripts('event_bus.js', 'api_client.js', 'db.js');

// ── Message pump ──────────────────────────────────────────────
// Single entry point for ALL messages from popup and content

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Acknowledge immediately — never make sender wait
  sendResponse({ status: 'queued', action: message.action });

  // Dispatch to event bus for async processing
  EventBus.dispatch(message, sender);

  return false; // synchronous response sent above
});

// ── Register event handlers ───────────────────────────────────

// Profile captured by content script
EventBus.register('autoCapture', async (event) => {
  const profile = event.profile;
  if (!profile?.url) return;

  const existing = await DB.getProfile(profile.url);

  // Don't overwrite enriched data — just update lastVisited
  if (existing?.enrichStatus === 'ENRICHED') {
    await DB.saveProfile(profile.url, { lastVisited: new Date().toISOString() });
    updateBadge();
    return;
  }

  const hasText = profile.rawText && profile.rawText.length > 200;

  await DB.saveProfile(profile.url, {
    name:          profile.name || '',
    rawText:       profile.rawText || '',
    websiteUrls:   profile.websiteUrls || [],
    captureSource: profile.captureSource || 'AUTO_BROWSE',
    enrichStatus:  hasText ? 'QUEUED' : 'CAPTURED',
  });

  updateBadge();

  // Debounced send — batch rapid navigations together
  if (hasText) scheduleSend();
});

// Log an interaction (comment, message, connected, called)
EventBus.register('logInteraction', async (event) => {
  const { url, type, text, postUrl } = event;
  if (!url) return;

  // Optimistic local update immediately
  const stageMap = {
    COMMENT:   'watching',
    MESSAGE:   'connected',
    CONNECTED: 'connected',
    CALLED:    'conversing',
  };
  const newStage = stageMap[type];
  if (newStage) {
    const profile = await DB.getProfile(url);
    const current = profile?.nurtureStage || 'new';
    const order   = ['new','watching','commented','connected',
                     'offer_made','offer_accepted','meeting_booked'];
    if (order.indexOf(newStage) > order.indexOf(current)) {
      await DB.setEnrichStatus(url, profile?.enrichStatus || 'ENRICHED', {
        nurtureStage: newStage,
      });
    }
  }

  // Send to API in background
  await ApiClient.logInteraction(url, type, text || '', postUrl || '');

  // Notify popup to refresh
  EventBus._notifyPopup('profile_updated', { url });
});

// Update lead status
EventBus.register('updateLeadStatus', async (event) => {
  const { url, leadStatus, notes } = event;
  const updates = {};
  if (leadStatus) updates.leadStatus = leadStatus;
  if (notes !== undefined) updates.notes = notes;

  await DB.saveProfile(url, updates);
  await ApiClient.updateLead(url, updates);
  EventBus._notifyPopup('profile_updated', { url });
});

// Mark profile as actioned
EventBus.register('markActioned', async (event) => {
  await DB.saveProfile(event.url, { actioned: true });
  updateBadge();
});

// Save settings
EventBus.register('saveSetting', async (event) => {
  await DB.saveSetting(event.key, event.value);
});

// Request current profile data for popup display
EventBus.register('getProfileData', async (event) => {
  const { url } = event;
  const profile = await DB.getProfile(url);
  const funnel  = await DB.getFunnel();

  EventBus._notifyPopup('profile_data', { url, profile, funnel });
});

// Request stats for settings panel
EventBus.register('getStats', async () => {
  const stats   = await DB.getStats();
  const funnel  = await DB.getFunnel();
  EventBus._notifyPopup('stats_data', { stats, funnel });
});

// Follow button clicked — content script executes, background tracks
EventBus.register('followExecuted', async (event) => {
  const { url, success } = event;
  if (success) {
    await DB.saveProfile(url, { nurtureStage: 'watching', actioned: true });
    await ApiClient.logInteraction(url, 'FOLLOW', '', '');
    updateBadge();
  }
  EventBus._notifyPopup('follow_result', { url, success });
});

// Google scrape results
EventBus.register('autoScrapeResults', async (event) => {
  const newProfiles = event.profiles || [];
  if (!newProfiles.length) return;

  const existing = await DB.getLegacyList();
  const excluded = await DB.getExcluded();
  const settings = await DB.getSettings();
  const max      = settings.maxProfiles || 50;

  const existingUrls = new Set(existing.map(p => p.url));
  const added = newProfiles.filter(
    p => !existingUrls.has(p.url) && !excluded.has(p.url)
  );

  if (added.length > 0) {
    const merged = [...existing, ...added].slice(0, max);
    await DB.saveLegacyList(merged);
    setBadge(String(added.length), '#2d7a2d', 8000);
    EventBus._notifyPopup('list_updated', { count: merged.length });
  }
});

// ── Send scheduler ────────────────────────────────────────────
// Debounced — batches profiles captured in rapid succession

let _sendTimer = null;

function scheduleSend() {
  if (_sendTimer) clearTimeout(_sendTimer);
  _sendTimer = setTimeout(sendQueuedProfiles, 3000);
}

async function sendQueuedProfiles() {
  const queued = await DB.getProfilesByStatus('QUEUED');
  if (!queued.length) return;

  const batch = queued
    .filter(p => p.rawText?.length > 200)
    .slice(0, 5)
    .map(p => ({
      url:     p.url,
      name:    p.name || '',
      rawText: (p.rawText || '').substring(0, 2500),
    }));

  if (!batch.length) return;

  const result = await ApiClient.enrichBatch(batch);
  if (!result?.jobs) return;

  for (const job of result.jobs) {
    await DB.setEnrichStatus(job.url, 'SENT', { jobId: job.job_id });
  }

  updateBadge();
}

// ── Enrichment poller ─────────────────────────────────────────

async function pollEnrichmentResults() {
  const sent = await DB.getProfilesByStatus('SENT');
  const proc = await DB.getProfilesByStatus('PROCESSING');
  const pending = [...sent, ...proc].filter(p => p.jobId);

  if (!pending.length) return;

  let changed = false;

  for (const profile of pending) {
    const data = await ApiClient.getJobStatus(profile.jobId);
    if (!data) continue;

    if (data.status === 'processing') {
      await DB.setEnrichStatus(profile.url, 'PROCESSING');
      changed = true;
    } else if (data.status === 'complete' && data.result) {
      const r = data.result;
      await DB.setEnrichStatus(profile.url, 'ENRICHED', {
        type:               r.type              || 'UNKNOWN',
        rag:                r.rag               || 'RED',
        priority:           r.priority          ?? 0,
        icpScore:           r.icpScore          ?? null,
        painSignal:         r.painSignal        || null,
        painUrgency:        r.painUrgency       || 'NONE',
        isFounder:          r.isFounder         ?? false,
        isB2bService:       r.isB2bService      ?? false,
        leaderOfIcp:        r.leaderOfIcp       ?? false,
        leaderNiche:        r.leaderNiche       || '',
        lever:              r.lever             || '',
        positioningProblem: r.positioningProblem|| '',
        keySignal:          r.keySignal         || '',
        action:             r.action            || 'WATCH',
        actionReason:       r.actionReason      || '',
        isCompetitor:       r.isCompetitor      ?? false,
        thoughtBait:        r.thoughtBait       || '',
        jobId:              null,
        error:              null,
        enrichedAt:         r.enrichedAt        || new Date().toISOString(),
      });
      changed = true;
      EventBus._notifyPopup('profile_enriched', { url: profile.url, result: r });
    } else if (data.status === 'failed') {
      await DB.setEnrichStatus(profile.url, 'FAILED', {
        error: data.error || 'Unknown', jobId: null,
      });
      changed = true;
    }
  }

  if (changed) updateBadge();
}

// ── Funnel refresh ────────────────────────────────────────────

async function refreshFunnel() {
  const funnel = await ApiClient.getFunnel();
  if (funnel && !funnel.error) {
    await DB.saveFunnel(funnel);
    EventBus._notifyPopup('funnel_updated', { funnel });
  }
}

// ── Badge ─────────────────────────────────────────────────────

async function updateBadge() {
  const profiles = await DB.getProfiles();
  const list     = Object.values(profiles);

  const urgent = list.filter(p =>
    p.enrichStatus === 'ENRICHED' &&
    (p.rag === 'GREEN' || p.rag === 'AMBER') &&
    p.priority >= 7 && !p.actioned
  ).length;

  const processing = list.filter(p =>
    ['QUEUED','SENT','PROCESSING'].includes(p.enrichStatus)
  ).length;

  if (urgent > 0) {
    setBadge(String(urgent), '#C00000', 0);
  } else if (processing > 0) {
    setBadge(String(processing), '#1F4E79', 0);
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

function setBadge(text, color, clearAfterMs) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
  if (clearAfterMs > 0) {
    setTimeout(() => chrome.action.setBadgeText({ text: '' }), clearAfterMs);
  }
}

// ── Icon context ──────────────────────────────────────────────

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, tab => {
    if (tab?.url) updateIconForUrl(tab.url, tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab?.url) {
    updateIconForUrl(tab.url, tab.url);
    if (tab.url.includes('linkedin.com/in/')) {
      setTimeout(pollEnrichmentResults, 3000);
    }
  }
});

async function updateIconForUrl(url) {
  if (!url.includes('linkedin.com')) {
    setBadge('·', '#C00000', 0);
    return;
  }
  if (url.includes('linkedin.com/in/')) {
    const key = (() => {
      const m = url.match(/linkedin\.com\/in\/([^/?#]+)/);
      return m ? `https://www.linkedin.com/in/${m[1]}/` : url;
    })();
    const profiles = await DB.getProfiles();
    const p = profiles[key];
    if (p?.enrichStatus === 'ENRICHED') {
      const colors = { GREEN:'#2d7a2d', AMBER:'#C07000', RED:'#C00000' };
      setBadge('●', colors[p.rag] || '#555', 0);
    } else if (p) {
      setBadge('·', '#1F4E79', 0);
    } else {
      chrome.action.setBadgeText({ text: '' });
    }
  }
}

// ── Scheduled tasks ───────────────────────────────────────────

setInterval(pollEnrichmentResults, 10000);  // every 10s
setInterval(sendQueuedProfiles, 30000);      // retry every 30s
setInterval(refreshFunnel, 300000);          // every 5 minutes
setInterval(updateBadge, 60000);             // badge sync every minute

// Startup
pollEnrichmentResults();
sendQueuedProfiles();
refreshFunnel();
updateBadge();
