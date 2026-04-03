/**
 * api_client.js
 *
 * All API calls live here. Only background.js uses this.
 * Never imported by popup.js or content.js.
 *
 * All methods are async. Callers handle results via storage
 * updates — not by waiting on these calls directly.
 */

const ApiClient = {

  BASE: 'http://localhost:5001',

  // ── Key management ──────────────────────────────────────

  async getKey() {
    return new Promise(resolve => {
      chrome.storage.local.get(['scout_api_key'], r => {
        resolve(r['scout_api_key'] || '');
      });
    });
  },

  async headers() {
    const key = await this.getKey();
    const h   = { 'Content-Type': 'application/json' };
    if (key) h['X-API-Key'] = key;
    return h;
  },

  // ── Health ──────────────────────────────────────────────

  async health() {
    try {
      const r = await fetch(`${this.BASE}/health`);
      return r.ok ? await r.json() : null;
    } catch(e) {
      return null;
    }
  },

  // ── Enrichment ──────────────────────────────────────────

  async enrich(profile) {
    try {
      const r = await fetch(`${this.BASE}/enrich`, {
        method:  'POST',
        headers: await this.headers(),
        body:    JSON.stringify({ profile, context: { captureSource: 'SCOUT' } }),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch(e) {
      return null;
    }
  },

  async enrichBatch(profiles) {
    try {
      const r = await fetch(`${this.BASE}/enrich/batch`, {
        method:  'POST',
        headers: await this.headers(),
        body:    JSON.stringify({ profiles }),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch(e) {
      return null;
    }
  },

  async getJobStatus(jobId) {
    try {
      const r = await fetch(`${this.BASE}/status/${jobId}`, {
        headers: await this.headers(),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch(e) {
      return null;
    }
  },

  // ── Leads ───────────────────────────────────────────────

  async getLead(profileUrl) {
    try {
      const slug = profileUrl.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
      if (!slug) return null;
      const r = await fetch(`${this.BASE}/leads/${slug}/`, {
        headers: await this.headers(),
      });
      if (r.status === 404) return null;
      if (!r.ok) return null;
      const data = await r.json();
      return data.found ? data.lead : null;
    } catch(e) {
      return null;
    }
  },

  async updateLead(profileUrl, updates) {
    try {
      const slug = profileUrl.match(/linkedin\.com\/in\/([^/?#]+)/)?.[1];
      if (!slug) return null;
      const r = await fetch(`${this.BASE}/leads/${slug}/`, {
        method:  'PATCH',
        headers: await this.headers(),
        body:    JSON.stringify(updates),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch(e) {
      return null;
    }
  },

  // ── Interactions ─────────────────────────────────────────

  async logInteraction(url, type, text, postUrl) {
    try {
      const r = await fetch(`${this.BASE}/interact`, {
        method:  'POST',
        headers: await this.headers(),
        body:    JSON.stringify({ url, type, text, postUrl }),
      });
      return r.ok;
    } catch(e) {
      return false;
    }
  },

  // ── Funnel ───────────────────────────────────────────────

  async getFunnel() {
    try {
      const r = await fetch(`${this.BASE}/funnel`);
      if (!r.ok) return null;
      return await r.json();
    } catch(e) {
      return null;
    }
  },

  // ── Leads pipeline ───────────────────────────────────────

  async getActivePipeline(limit = 50) {
    try {
      const r = await fetch(`${this.BASE}/leads?limit=${limit}`, {
        headers: await this.headers(),
      });
      if (!r.ok) return null;
      return await r.json();
    } catch(e) {
      return null;
    }
  },
};
