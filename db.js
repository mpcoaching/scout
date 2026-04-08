/**
 * db.js
 *
 * Chrome storage data layer.
 * Read/write operations for all Scout data.
 * Used by background.js only.
 *
 * Storage keys:
 *   scout_profiles     enriched profile records
 *   scout_posts        tracked post records
 *   scout_comments     comment records per post
 *   scout_funnel       funnel cache from API
 *   scout_settings     user settings
 *   scout_api_key      API key
 *   scout_profile_list legacy list (Google X-Ray scrape)
 *   scout_excluded     excluded/archived profiles
 */

const DB = {

  // ── Profiles ─────────────────────────────────────────────

  async getProfiles() {
    return new Promise(resolve => {
      chrome.storage.local.get(['scout_profiles'], r => {
        resolve(r['scout_profiles'] || {});
      });
    });
  },

  async getProfile(url) {
    const profiles = await this.getProfiles();
    return profiles[this._key(url)] || null;
  },

  async saveProfile(url, data) {
    const profiles = await this.getProfiles();
    const key      = this._key(url);
    const existing = profiles[key] || {};
    const now      = new Date().toISOString();

    profiles[key] = {
      id:            key,
      url:           key,
      name:          '',
      enrichStatus:  'CAPTURED',
      type:          'UNKNOWN',
      rag:           null,
      priority:      null,
      captureSource: 'AUTO_BROWSE',
      icpScore:      null,
      lever:         '',
      action:        null,
      thoughtBait:   '',
      isCompetitor:  false,
      painSignal:    null,
      painUrgency:   'NONE',
      isFounder:     false,
      nurtureStage:  'new',
      notes:         '',
      rawText:       '',
      websiteUrls:   [],
      jobId:         null,
      error:         null,
      createdAt:     now,
      ...existing,
      ...data,
      lastVisited:   now,
    };

    await this._set('scout_profiles', profiles);
    return profiles[key];
  },

  async setEnrichStatus(url, status, extra = {}) {
    const profiles = await this.getProfiles();
    const key      = this._key(url);
    if (!profiles[key]) return;
    profiles[key] = { ...profiles[key], enrichStatus: status, ...extra };
    await this._set('scout_profiles', profiles);
    return profiles[key];
  },

  async getProfilesByStatus(status) {
    const profiles = await this.getProfiles();
    return Object.values(profiles)
      .filter(p => p.enrichStatus === status);
  },

  async getStats() {
    const profiles = await this.getProfiles();
    const list     = Object.values(profiles);
    return {
      total:      list.length,
      captured:   list.filter(p => p.enrichStatus === 'CAPTURED').length,
      queued:     list.filter(p => p.enrichStatus === 'QUEUED').length,
      sent:       list.filter(p => p.enrichStatus === 'SENT').length,
      processing: list.filter(p => p.enrichStatus === 'PROCESSING').length,
      enriched:   list.filter(p => p.enrichStatus === 'ENRICHED').length,
      failed:     list.filter(p => p.enrichStatus === 'FAILED').length,
      leaders:    list.filter(p => p.type === 'LEADER').length,
      icp:        list.filter(p => p.type === 'ICP').length,
      adjacent:   list.filter(p => p.type === 'ADJACENT').length,
    };
  },

  // ── Posts ─────────────────────────────────────────────────

  async getPosts() {
    return new Promise(resolve => {
      chrome.storage.local.get(['scout_posts'], r => {
        resolve(r['scout_posts'] || {});
      });
    });
  },

  async savePost(postId, data) {
    const posts    = await this.getPosts();
    const existing = posts[postId] || {};
    const now      = new Date().toISOString();
    posts[postId]  = {
      id: postId, url: '', authorUrl: '', text: '',
      stats: { reactions: 0, comments: 0, reposts: 0 },
      enrichStatus: 'CAPTURED', createdAt: now,
      ...existing, ...data, updatedAt: now,
    };
    const entries = Object.entries(posts)
      .sort((a,b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
      .slice(0, 200);
    await this._set('scout_posts', Object.fromEntries(entries));
    return posts[postId];
  },

  // ── Comments ──────────────────────────────────────────────

  async saveComments(postId, comments) {
    const all = await new Promise(resolve => {
      chrome.storage.local.get(['scout_comments'], r => {
        resolve(r['scout_comments'] || {});
      });
    });
    const now = new Date().toISOString();
    comments.forEach((c, i) => {
      const id = `${postId}_${i}`;
      all[id]  = {
        id, postId,
        commenterUrl:  c.commenterUrl  || '',
        commenterName: c.commenterName || '',
        text:          c.text          || '',
        signalStrength: 'UNKNOWN',
        createdAt:     now,
        ...(all[id] || {}),
        text: c.text || '',
      };
    });
    await this._set('scout_comments', all);
  },

  async getCommentsForPost(postId) {
    const all = await new Promise(resolve => {
      chrome.storage.local.get(['scout_comments'], r => {
        resolve(r['scout_comments'] || {});
      });
    });
    return Object.values(all).filter(c => c.postId === postId);
  },

  // ── Funnel cache ──────────────────────────────────────────

  async getFunnel() {
    return new Promise(resolve => {
      chrome.storage.local.get(['scout_funnel'], r => {
        resolve(r['scout_funnel'] || null);
      });
    });
  },

  async saveFunnel(funnel) {
    await this._set('scout_funnel', funnel);
  },

  // ── Settings ──────────────────────────────────────────────

  async getSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get(['scout_settings'], r => {
        resolve({
          page2:      false,
          numResults: 10,
          maxProfiles: 50,
          patternN:   20,
          ...(r['scout_settings'] || {}),
        });
      });
    });
  },

  async saveSetting(key, value) {
    const settings = await this.getSettings();
    await this._set('scout_settings', { ...settings, [key]: value });
  },

  // ── Legacy list (Google X-Ray) ────────────────────────────

  async getLegacyList() {
    return new Promise(resolve => {
      chrome.storage.local.get(['scout_profile_list'], r => {
        resolve(r['scout_profile_list'] || []);
      });
    });
  },

  async saveLegacyList(list) {
    await this._set('scout_profile_list', list);
  },

  async getExcluded() {
    return new Promise(resolve => {
      chrome.storage.local.get(['scout_excluded_list'], r => {
        resolve(new Set(r['scout_excluded_list'] || []));
      });
    });
  },

  async addExcluded(url) {
    const excluded = await this.getExcluded();
    excluded.add(url);
    await this._set('scout_excluded_list', [...excluded]);
  },

  // ── Component checksums ──────────────────────────────────
  // Each trackable component of a profile has its own checksum
  // so we can detect precisely what changed and only re-process that part
  //
  // Components:
  //   profile_text  → name, headline, about — rarely changes
  //   posts_list    → list of visible post excerpts — new posts appear
  //   post_{id}     → individual post content — stable once created
  //   comments_{id} → comments on a post — grows over time

  async getChecksums(profileUrl) {
    const key = `scout_checksums_${this._key(profileUrl)}`;
    return new Promise(resolve => {
      chrome.storage.local.get([key], r => {
        resolve(r[key] || {});
      });
    });
  },

  async setChecksum(profileUrl, component, checksum) {
    const key      = `scout_checksums_${this._key(profileUrl)}`;
    const existing = await this.getChecksums(profileUrl);
    existing[component] = {
      checksum,
      checkedAt: new Date().toISOString(),
    };
    await this._set(key, existing);
  },

  async checksumChanged(profileUrl, component, newChecksum) {
    const checksums = await this.getChecksums(profileUrl);
    const stored    = checksums[component];
    if (!stored) return true; // Never checked — treat as changed
    return stored.checksum !== newChecksum;
  },

  // ── Actions ───────────────────────────────────────────────
  // Task list populated from nextSteps on enrichment
  // Each action tracks status and completion

  async getActions() {
    return new Promise(resolve => {
      chrome.storage.local.get(['scout_actions'], r => {
        resolve(r['scout_actions'] || []);
      });
    });
  },

  async saveActions(actions) {
    // Keep last 200 actions
    const trimmed = actions.slice(-200);
    await this._set('scout_actions', trimmed);
  },

  async addActions(profileUrl, profileName, nextSteps) {
    if (!nextSteps || !nextSteps.length) return;
    const actions = await this.getActions();
    const now     = new Date().toISOString();

    for (const step of nextSteps) {
      // Avoid duplicates for same profile + type + searchHint
      const exists = actions.some(a =>
        a.profileUrl === profileUrl &&
        a.type === step.type &&
        a.searchHint === (step.searchHint || '') &&
        a.status === 'PENDING'
      );
      if (exists) continue;

      actions.push({
        id:          `${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
        profileUrl,
        profileName: profileName || profileUrl,
        type:        step.type,
        instruction: step.instruction || '',
        searchHint:  step.searchHint || '',
        priority:    step.priority || 1,
        status:      'PENDING',   // PENDING | DONE | SKIPPED
        createdAt:   now,
        completedAt: null,
      });
    }

    await this.saveActions(actions);
  },

  async completeAction(actionId) {
    const actions = await this.getActions();
    const idx     = actions.findIndex(a => a.id === actionId);
    if (idx === -1) return;
    actions[idx].status      = 'DONE';
    actions[idx].completedAt = new Date().toISOString();
    await this.saveActions(actions);
  },

  async skipAction(actionId) {
    const actions = await this.getActions();
    const idx     = actions.findIndex(a => a.id === actionId);
    if (idx === -1) return;
    actions[idx].status      = 'SKIPPED';
    actions[idx].completedAt = new Date().toISOString();
    await this.saveActions(actions);
  },

  // ── Activity counters ─────────────────────────────────────
  // Tracks totals for dashboard: comments, messages, posts viewed etc

  async getCounters() {
    return new Promise(resolve => {
      chrome.storage.local.get(['scout_counters'], r => {
        resolve(r['scout_counters'] || {
          profilesViewed:  0,
          postsViewed:     0,
          commentsLeft:    0,
          messagesSent:    0,
          connectionsAdded: 0,
          actionsCompleted: 0,
          lastReset:       new Date().toISOString(),
        });
      });
    });
  },

  async incrementCounter(key) {
    const counters = await this.getCounters();
    counters[key]  = (counters[key] || 0) + 1;
    await this._set('scout_counters', counters);
    return counters;
  },

  // ── Helpers ───────────────────────────────────────────────

  _key(url) {
    const m = url.match(/linkedin\.com\/in\/([^/?#]+)/);
    return m ? `https://www.linkedin.com/in/${m[1]}/` : url;
  },

  _set(key, value) {
    return new Promise(resolve => {
      chrome.storage.local.set({ [key]: value }, resolve);
    });
  },
};