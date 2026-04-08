// LinkedIn Scout — Background Service Worker v15.3
// Single message pump. All logic delegated to EventBus handlers.
// Imports: event_bus.js, api_client.js, db.js (via importScripts)

importScripts('event_bus.js', 'api_client.js', 'db.js');

// ── Message pump ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  sendResponse({ status: 'queued', action: message.action });
  EventBus.dispatch(message, sender);
  return false;
});

// ── Checksum ──────────────────────────────────────────────────
// Simple hash of rawText to detect meaningful content changes.
// We hash the full rawText — any change (new post, updated headline)
// will produce a different checksum and trigger re-enrichment.

function simpleChecksum(str) {
  if (!str) return '0';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

// ── Re-enrich decision ────────────────────────────────────────
// Returns: 'skip' | 'partial' | 'full'
// - skip:    already enriched, within time window, content unchanged
// - partial: already enriched, content changed — skip analysis steps
// - full:    not yet enriched

async function shouldReEnrich(existing, newRawText, profileUrl) {
  if (!existing) {
    return 'full'; // Never seen before
  }

  // Don't interfere with in-flight jobs
  if (['QUEUED','SENT','PROCESSING'].includes(existing.enrichStatus)) {
    return 'skip'; // Already in pipeline
  }

  if (existing.enrichStatus !== 'ENRICHED') {
    return 'full'; // CAPTURED, FAILED — try again
  }

  const settings      = await DB.getSettings();
  const intervalHours = settings.reEnrichIntervalHours || 24;
  const intervalMs    = intervalHours * 60 * 60 * 1000;

  // Component-level change detection
  // Each component has its own checksum and timestamp
  // This lets us detect precisely what changed

  // 1. Check profile text component (name, headline, about)
  // Extract just the first ~500 chars which contains static profile info
  const profileTextSample = (newRawText || '').substring(0, 500);
  const profileTextChecksum = simpleChecksum(profileTextSample);
  const profileTextChanged = await DB.checksumChanged(profileUrl, 'profile_text', profileTextChecksum);

  // 2. Check posts list component (visible post excerpts)
  // Extract post excerpts by looking for repeated short-line patterns
  // that appear in the activity section (after the main profile block)
  const postsSample = (newRawText || '').substring(500);
  const postsChecksum = simpleChecksum(postsSample);
  const postsChanged = await DB.checksumChanged(profileUrl, 'posts_list', postsChecksum);

  // Within time window AND nothing changed — skip
  const lastEnrichedAt = existing.enrichedAt ? new Date(existing.enrichedAt).getTime() : 0;
  const ageMs          = Date.now() - lastEnrichedAt;

  if (ageMs < intervalMs && !profileTextChanged && !postsChanged) {
    return 'skip';
  }

  // Store new checksums
  await DB.setChecksum(profileUrl, 'profile_text', profileTextChecksum);
  await DB.setChecksum(profileUrl, 'posts_list', postsChecksum);

  // Profile text changed → full re-enrich (structural data may have changed)
  if (profileTextChanged && existing.enrichStatus === 'ENRICHED') {
    return 'full';
  }

  // Only posts changed or time window expired → partial re-enrich
  // Keeps existing profile_structured and business_context
  return 'partial';
}

// ── Register event handlers ───────────────────────────────────

// Profile captured by content script
EventBus.register('autoCapture', async (event) => {
  const profile = event.profile;
  if (!profile?.url) return;

  const existing = await DB.getProfile(profile.url);
  const hasText  = profile.rawText && profile.rawText.length > 200;
  const decision = await shouldReEnrich(existing, profile.rawText || '', profile.url);

  if (decision === 'skip') {
    // Content unchanged within time window — just update lastVisited
    await DB.saveProfile(profile.url, { lastVisited: new Date().toISOString() });
    updateBadge();
    return;
  }

  if (decision === 'partial') {
    // Content changed — queue for partial re-enrichment
    // Store new rawText and checksum, preserve existing enrichment fields
    const checksum = simpleChecksum(profile.rawText || '');
    await DB.saveProfile(profile.url, {
      rawText:         profile.rawText || '',
      rawTextChecksum: checksum,
      lastVisited:     new Date().toISOString(),
      enrichStatus:    'QUEUED',
      reEnrichMode:    'partial', // Signal to pipeline to skip analysis steps
      // Preserve existing enrichment data until re-enrichment completes
      _previousEnrichment: {
        type:               existing.type,
        rag:                existing.rag,
        priority:           existing.priority,
        profile_structured: existing.profile_structured,
        business_context:   existing.business_context,
      },
    });
    updateBadge();
    if (hasText) scheduleSend();
    return;
  }

  // Full enrichment — new profile
  const checksum = simpleChecksum(profile.rawText || '');
  await DB.saveProfile(profile.url, {
    name:            profile.name || '',
    rawText:         profile.rawText || '',
    rawTextChecksum: checksum,
    websiteUrls:     profile.websiteUrls || [],
    captureSource:   profile.captureSource || 'AUTO_BROWSE',
    enrichStatus:    hasText ? 'QUEUED' : 'CAPTURED',
    reEnrichMode:    'full',
  });

  updateBadge();
  if (hasText) scheduleSend();
});

// Manual re-enrich — triggered from overlay or list card
EventBus.register('reEnrich', async (event) => {
  const { url } = event;
  if (!url) return;

  const existing = await DB.getProfile(url);
  if (!existing) return;

  // Force re-enrich regardless of time window or checksum
  await DB.saveProfile(url, {
    enrichStatus: 'QUEUED',
    reEnrichMode: 'partial', // Always partial — preserve structural analysis
    _previousEnrichment: {
      type:               existing.type,
      rag:                existing.rag,
      priority:           existing.priority,
      profile_structured: existing.profile_structured,
      business_context:   existing.business_context,
    },
  });

  updateBadge();
  scheduleSend();
  EventBus._notifyPopup('profile_updated', { url });
});

// Complete an action from the task list
EventBus.register('completeAction', async (event) => {
  const { actionId, actionType } = event;
  if (!actionId) return;

  await DB.completeAction(actionId);

  // Increment relevant counter
  const counterMap = {
    COMMENT:   'commentsLeft',
    MESSAGE:   'messagesSent',
    CONNECT:   'connectionsAdded',
    VIEW_POST: 'postsViewed',
    FOLLOW:    'commentsLeft',
  };
  const counter = counterMap[actionType];
  if (counter) await DB.incrementCounter(counter);
  await DB.incrementCounter('actionsCompleted');

  EventBus._notifyPopup('actions_updated', {});
  updateBadge();
});

// Skip an action
EventBus.register('skipAction', async (event) => {
  const { actionId } = event;
  if (!actionId) return;
  await DB.skipAction(actionId);
  EventBus._notifyPopup('actions_updated', {});
});

// Get actions for popup
EventBus.register('getActions', async () => {
  const actions  = await DB.getActions();
  const counters = await DB.getCounters();
  EventBus._notifyPopup('actions_data', { actions, counters });
});

// Log an interaction (comment, message, connected, called)
EventBus.register('logInteraction', async (event) => {
  const { url, type, text, postUrl } = event;
  if (!url) return;

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

  await ApiClient.logInteraction(url, type, text || '', postUrl || '');
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

// Save setting
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
  const stats  = await DB.getStats();
  const funnel = await DB.getFunnel();
  EventBus._notifyPopup('stats_data', { stats, funnel });
});

// Follow button clicked
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
      url:          p.url,
      name:         p.name || '',
      rawText:      (p.rawText || '').substring(0, 2500),
      reEnrichMode: p.reEnrichMode || 'full',
      // Pass existing structural data forward for partial re-enrichment
      // so the pipeline can skip analysis and lead_enrichment steps
      existingContext: p.reEnrichMode === 'partial' && p._previousEnrichment
        ? {
            profile_structured: p._previousEnrichment.profile_structured,
            business_context:   p._previousEnrichment.business_context,
          }
        : null,
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
  const sent    = await DB.getProfilesByStatus('SENT');
  const proc    = await DB.getProfilesByStatus('PROCESSING');
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
        type:               r.type               || 'UNKNOWN',
        rag:                r.rag                || 'RED',
        priority:           r.priority           ?? 0,
        icpScore:           r.icpScore           ?? null,
        painSignal:         r.painSignal         || null,
        painUrgency:        r.painUrgency        || 'NONE',
        isFounder:          r.isFounder          ?? false,
        isB2bService:       r.isB2bService       ?? false,
        leaderOfIcp:        r.leaderOfIcp        ?? false,
        leaderNiche:        r.leaderNiche        || '',
        lever:              r.lever              || '',
        positioningProblem: r.positioningProblem || '',
        keySignal:          r.keySignal          || '',
        action:             r.action             || 'WATCH',
        actionReason:       r.actionReason       || '',
        isCompetitor:       r.isCompetitor       ?? false,
        thoughtBait:        r.thoughtBait        || '',
        nextSteps:          r.nextSteps          || [],
        jobId:              null,
        error:              null,
        enrichedAt:         r.enrichedAt         || new Date().toISOString(),
        reEnrichMode:       null, // Clear after successful enrichment
        _previousEnrichment: null, // Clear after successful enrichment
      });
      changed = true;
      // Create task list entries from nextSteps
      if (r.nextSteps && r.nextSteps.length > 0) {
        const enrichedProfile = await DB.getProfile(profile.url);
        await DB.addActions(profile.url, enrichedProfile?.name || '', r.nextSteps);
        EventBus._notifyPopup('actions_updated', {});
      }

      // Increment profiles viewed counter
      await DB.incrementCounter('profilesViewed');

      EventBus._notifyPopup('profile_enriched', { url: profile.url, result: r });
    } else if (data.status === 'retrying') {
      // Infrastructure or quality failure — job is retrying on server side
      // Keep profile in PROCESSING state so Scout keeps polling
      await DB.setEnrichStatus(profile.url, 'PROCESSING');
      changed = true;
    } else if (data.status === 'failed') {
      // Check if result contains infrastructure_unavailable
      // If so, requeue rather than mark permanently failed
      const results = data.result || [];
      const isInfraFailure = results.some(r =>
        r.status === 'infrastructure_unavailable' || r.status === 'quality_failure'
      );
      if (isInfraFailure) {
        // Keep as QUEUED so it gets retried on next sendQueuedProfiles cycle
        await DB.setEnrichStatus(profile.url, 'QUEUED', {
          jobId: null,
          error: data.error || 'Temporary failure — will retry',
        });
      } else {
        await DB.setEnrichStatus(profile.url, 'FAILED', {
          error: data.error || 'Unknown', jobId: null,
        });
      }
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
    if (tab?.url) updateIconForUrl(tab.url);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab?.url) {
    updateIconForUrl(tab.url);
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
    const m   = url.match(/linkedin\.com\/in\/([^/?#]+)/);
    const key = m ? `https://www.linkedin.com/in/${m[1]}/` : url;
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