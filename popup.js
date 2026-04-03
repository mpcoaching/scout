/**
 * popup.js v15.3
 *
 * UI layer only. Three responsibilities:
 *   1. Render UI from chrome.storage data
 *   2. Send user actions to background via messages
 *   3. Listen for messages from background + storage changes
 *
 * Rules:
 *   - Never calls fetch directly
 *   - Never writes to storage directly
 *   - Never processes data
 *   - All actions → chrome.runtime.sendMessage → background
 *   - All updates → storage.onChanged → re-render
 */
'use strict';

// ── State ─────────────────────────────────────────────────────
let _currentUrl    = null;
let _currentTab    = null;
let _currentFilter = 'PRIORITY';

// ── Message pump — incoming from background ───────────────────
chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'profile_data':
      if (message.url === _currentUrl) {
        renderProfilePanel(message.profile, message.funnel);
      }
      break;
    case 'profile_updated':
    case 'profile_enriched':
      if (message.url === _currentUrl) {
        sendToBackground('getProfileData', { url: _currentUrl });
      }
      if (_currentTab === 'list') renderListTab();
      break;
    case 'stats_data':
      renderIntelligenceStats(message.stats, message.funnel);
      break;
    case 'funnel_updated':
      renderFunnelTarget(message.funnel);
      break;
    case 'event_queued':
      showPendingIndicator(message.action);
      break;
    case 'event_done':
      hidePendingIndicator(message.action);
      break;
    case 'follow_result':
      const btn = document.getElementById('btnAutoFollow');
      if (btn) {
        btn.textContent = message.success ? '✓ Followed' : '⚠ Not found';
        if (message.success) sendToBackground('getProfileData', { url: _currentUrl });
      }
      break;
    case 'list_updated':
      if (_currentTab === 'list') renderListTab();
      break;
  }
});

// ── Storage listener ──────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.scout_profiles && _currentUrl) {
    const profiles = changes.scout_profiles.newValue || {};
    const key      = normaliseUrl(_currentUrl);
    if (profiles[key]) {
      renderEnrichmentStatus(profiles[key]);
      renderSeenBadge(profiles[key]);
    }
  }
  if (changes.scout_profiles && _currentTab === 'list') {
    renderListTab();
  }
  if (changes.scout_funnel) {
    renderFunnelTarget(changes.scout_funnel.newValue);
  }
  if (changes.scout_settings) {
    applySettings(changes.scout_settings.newValue);
  }
});

// ── Send to background ────────────────────────────────────────
function sendToBackground(action, data = {}) {
  chrome.runtime.sendMessage({ action, ...data }).catch(() => {});
}

// ── Initialise ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  _currentTab = 'main';
  _currentUrl = tab?.url || null;

  chrome.storage.local.get([
    'scout_profiles', 'scout_funnel', 'scout_settings',
    'scout_profile_list', 'scout_api_key',
  ], (data) => {
    applySettings(data.scout_settings || {});
    renderFunnelTarget(data.scout_funnel || null);
    if (_currentUrl) {
      checkTab(_currentUrl);
      const key     = normaliseUrl(_currentUrl);
      const profile = (data.scout_profiles || {})[key];
      if (profile) {
        renderEnrichmentStatus(profile);
        renderSeenBadge(profile);
      }
    }
  });

  if (_currentUrl) sendToBackground('getProfileData', { url: _currentUrl });
  wireButtons();
});

// ── Tab switching ─────────────────────────────────────────────
function switchTab(tab) {
  _currentTab = tab;
  ['main','list','settings'].forEach(t => {
    document.getElementById('panel' + cap(t))?.classList.toggle('active', t === tab);
    document.getElementById('tab'   + cap(t))?.classList.toggle('active', t === tab);
  });
  if (tab === 'list')     renderListTab();
  if (tab === 'settings') sendToBackground('getStats');
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ── Context detection ─────────────────────────────────────────
function checkTab(url) {
  const isProfile = url.includes('linkedin.com/in/');
  const isSubPage = ['/recent-activity','/posts/','/detail/','/overlay/'].some(s => url.includes(s));
  const isPost    = url.includes('linkedin.com/posts/') || url.includes('linkedin.com/feed/update/');
  const isGoogle  = url.includes('google.com/search');
  const subtitle  = document.getElementById('contextSubtitle');

  hide('searchSection','buttonsSection','googleSection','notLinkedIn','postSection');

  if (isPost) {
    setSubtitle(subtitle, 'LinkedIn Post');
    show('postSection');
    renderPostMeta(url);
  } else if (isProfile && !isSubPage) {
    setSubtitle(subtitle, 'LinkedIn Profile');
    show('buttonsSection','searchSection');
  } else if (isSubPage) {
    setSubtitle(subtitle, 'Go to main profile');
    show('notLinkedIn','searchSection');
  } else if (isGoogle) {
    setSubtitle(subtitle, 'Google Results');
    show('googleSection','searchSection');
  } else {
    setSubtitle(subtitle, 'LinkedIn Scout');
    show('searchSection');
  }
}

function show(...ids) { ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'block'; }); }
function hide(...ids) { ids.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; }); }
function setSubtitle(el, text) { if (el) el.textContent = text; }
function renderPostMeta(url) {
  const el = document.getElementById('postMeta');
  const slug = url.split('/posts/')[1]?.split('?')[0] || '';
  if (el) el.textContent = slug.substring(0, 60);
}

// ── Profile panel render ──────────────────────────────────────
function renderProfilePanel(profile, funnel) {
  renderEnrichmentStatus(profile);
  renderSeenBadge(profile);
  renderLeadPanel(profile, funnel);
}

function renderEnrichmentStatus(profile) {
  const el = document.getElementById('enrichmentStatus');
  if (!el || !profile) return;

  if (profile.enrichStatus === 'ENRICHED') {
    const ragColors = { GREEN:'#2d7a2d', AMBER:'#C07000', RED:'#C00000' };
    const ragBgs    = { GREEN:'#0d2b0d', AMBER:'#2b1a00', RED:'#2b0000' };
    const rc  = ragColors[profile.rag] || '#555';
    const rbc = ragBgs[profile.rag]    || '#111';
    const typeColors = { LEADER:'#C07000', ICP_LEADER:'#C07000', ICP:'#2d7a2d', ADJACENT:'#555', UNKNOWN:'#444' };

    el.innerHTML = `
      <div style="background:${rbc};border:1px solid ${rc};border-radius:4px;padding:6px 8px;margin-bottom:4px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="color:${rc};font-size:12px;font-weight:bold">● ${profile.rag || '—'}</span>
          <span style="color:#fff;font-size:14px;font-weight:bold">P${profile.priority || 0}</span>
          <span style="color:${typeColors[profile.type]||'#444'};font-size:10px">${profile.type || '—'}</span>
          ${profile.icpScore != null ? `<span style="color:#888;font-size:10px">ICP ${profile.icpScore}/10</span>` : ''}
        </div>
        ${profile.action ? `
          <div style="margin-top:4px;font-size:10px;color:#2E75B6;font-weight:bold">
            → ${profile.action}
            ${profile.actionReason ? `<span style="color:#666;font-weight:normal"> — ${profile.actionReason.substring(0,80)}</span>` : ''}
          </div>` : ''}
      </div>
      ${profile.thoughtBait ? `
        <div style="background:#0d1020;border:1px solid #2E75B6;border-radius:4px;padding:6px 8px;margin-bottom:4px">
          <div style="font-size:9px;color:#2E75B6;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">💬 Comment starter</div>
          <div style="font-size:10px;color:#ccc;line-height:1.5">${profile.thoughtBait.substring(0,150)}</div>
          <button class="copy-thought-bait" style="margin-top:4px;background:#1F4E79;color:white;border:none;border-radius:3px;padding:3px 8px;font-size:9px;cursor:pointer">Copy</button>
        </div>` : ''}
      ${profile.painSignal ? `
        <div style="font-size:10px;color:#888;margin-bottom:3px">
          Signal: ${profile.painSignal}
          ${profile.painUrgency && profile.painUrgency !== 'NONE' ? `<span style="color:${profile.painUrgency==='HIGH'?'#C00000':'#C07000'}"> · ${profile.painUrgency}</span>` : ''}
          ${profile.isFounder ? ' · 👤 Founder' : ''}
        </div>` : ''}
      ${profile.keySignal ? `<div style="font-size:9px;color:#555;font-style:italic;margin-bottom:3px">"${profile.keySignal.substring(0,100)}"</div>` : ''}
      ${profile.lever ? `<div style="font-size:9px;color:#666;margin-bottom:3px">⚙ ${profile.lever.substring(0,100)}</div>` : ''}
      ${profile.action === 'FOLLOW' ? `
        <button id="btnAutoFollow" style="width:100%;background:#1F4E79;color:white;border:none;border-radius:4px;padding:5px;font-size:10px;cursor:pointer;margin-top:4px">
          Follow this profile
        </button>` : ''}`;

    el.querySelector('.copy-thought-bait')?.addEventListener('click', (e) => {
      navigator.clipboard.writeText(profile.thoughtBait || '');
      e.target.textContent = '✓ Copied';
      setTimeout(() => { e.target.textContent = 'Copy'; }, 2000);
    });

    document.getElementById('btnAutoFollow')?.addEventListener('click', () => {
      sendToBackground('requestFollow', { url: _currentUrl });
    });
  } else {
    const icons  = { CAPTURED:'○', QUEUED:'○', SENT:'⏳', PROCESSING:'⏳', FAILED:'✗' };
    const colors = { CAPTURED:'#444', QUEUED:'#555', SENT:'#1F4E79', PROCESSING:'#2E75B6', FAILED:'#C00000' };
    const s = profile.enrichStatus || 'CAPTURED';
    el.innerHTML = `
      <span style="color:${colors[s]||'#444'};font-size:10px">
        ${icons[s]||'○'} ${s}
        ${profile.error ? `<span style="color:#C00000"> — ${profile.error}</span>` : ''}
      </span>`;
  }
}

function renderSeenBadge(profile) {
  const badge = document.getElementById('seenBadge');
  if (!badge || !profile) return;
  badge.style.display = 'block';
  if (profile.enrichStatus === 'ENRICHED') {
    const ragColors = { GREEN:'#2d7a2d', AMBER:'#C07000', RED:'#C00000' };
    const ragBgs    = { GREEN:'#0d2b0d', AMBER:'#2b1a00', RED:'#2b0000' };
    const rag = profile.rag || 'RED';
    badge.style.borderColor = ragColors[rag];
    badge.style.color       = ragColors[rag];
    badge.style.background  = ragBgs[rag];
    badge.textContent       = `● ${rag}`;
  } else {
    badge.style.borderColor = '#1F4E79';
    badge.style.color       = '#2E75B6';
    badge.style.background  = '#0d1a2b';
    badge.textContent       = '· seen';
  }
}

function renderLeadPanel(profile, funnel) {
  const panel = document.getElementById('leadPanel');
  if (!panel) return;
  panel.style.display = 'block';
  const parts = [];

  if (funnel && !funnel.error) {
    const cpd      = funnel?.backwards?.comments_per_day || 3;
    const gap      = funnel?.progress?.gap || 1;
    const daysLeft = funnel?.progress?.days_left || 10;
    const fwdRev   = funnel?.forwards?.proj_rev_annual || 0;
    const annTgt   = funnel?.goal?.annual_target || 250000;
    const urgency  = daysLeft <= 2 ? '#C00000' : daysLeft <= 5 ? '#C07000' : '#2E75B6';
    const fwdColor = fwdRev >= annTgt ? '#2d7a2d' : fwdRev >= annTgt * 0.5 ? '#C07000' : '#555';
    if (gap > 0) {
      parts.push(`
        <div style="background:#0d1a2b;border:1px solid #1F4E79;border-radius:4px;padding:6px 8px;margin-bottom:4px">
          <div style="display:flex;justify-content:space-between">
            <span style="color:${urgency};font-size:11px;font-weight:bold">Today: ${cpd} comment${cpd!==1?'s':''}</span>
            <span style="color:#555;font-size:9px">${daysLeft}d left</span>
          </div>
          <div style="color:${fwdColor};font-size:9px;margin-top:2px">Forecast: $${Math.round(fwdRev).toLocaleString()}/yr</div>
        </div>`);
    }
  }

  if (profile && profile.enrichStatus === 'ENRICHED') {
    const interactions = profile.interactions?.length || 0;
    const stage        = profile.nurtureStage || 'new';
    parts.push(`
      <div style="background:#1a1a1a;border:1px solid #2a2a2a;border-radius:4px;padding:6px 8px;margin-bottom:4px">
        ${profile.lever ? `<div style="font-size:9px;color:#666;margin-bottom:3px">⚙ ${profile.lever.substring(0,80)}</div>` : ''}
        ${profile.keySignal ? `<div style="font-size:9px;color:#555;font-style:italic;margin-bottom:3px">"${profile.keySignal.substring(0,80)}"</div>` : ''}
        <div style="display:flex;justify-content:space-between;font-size:9px;color:#444;margin-top:4px">
          <span>${stage}</span>
          <span>${interactions} interactions</span>
        </div>
      </div>
      <div style="display:flex;gap:4px;margin-bottom:4px">
        <button class="log-btn" data-type="COMMENT" style="flex:1;background:#1F4E79;color:white;border:none;border-radius:4px;padding:5px;font-size:10px;cursor:pointer">💬 Comment</button>
        <button class="log-btn" data-type="MESSAGE" style="flex:1;background:#2d5a2d;color:white;border:none;border-radius:4px;padding:5px;font-size:10px;cursor:pointer">✉ Message</button>
        <button class="log-btn" data-type="CONNECTED" style="flex:1;background:#333;color:white;border:none;border-radius:4px;padding:5px;font-size:10px;cursor:pointer">🔗 Connected</button>
      </div>`);
  }

  panel.innerHTML = parts.join('') || '';

  panel.querySelectorAll('.log-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      if (type === 'COMMENT' || type === 'MESSAGE') {
        const text = prompt(`${type} (optional — for tracking):`);
        if (text === null) return;
        sendToBackground('logInteraction', { url: _currentUrl, type, text });
      } else {
        sendToBackground('logInteraction', { url: _currentUrl, type, text: '' });
      }
      btn.textContent = '⏳';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = type === 'COMMENT' ? '💬 Comment' : type === 'MESSAGE' ? '✉ Message' : '🔗 Connected';
        btn.disabled = false;
      }, 2000);
    });
  });
}

function renderFunnelTarget(funnel) {
  if (!funnel || funnel.error) return;
  const cpd      = funnel?.backwards?.comments_per_day || 0;
  const gap      = funnel?.progress?.gap || 1;
  const daysLeft = funnel?.progress?.days_left || 10;
  const subtitle = document.getElementById('contextSubtitle');
  if (subtitle && cpd > 0 && gap > 0) {
    const urgency = daysLeft <= 2 ? '#C00000' : daysLeft <= 5 ? '#C07000' : '#2E75B6';
    subtitle.innerHTML = `<span style="color:${urgency}">Today: ${cpd} comment${cpd!==1?'s':''}</span> <span style="color:#333">· ${daysLeft}d left</span>`;
  } else if (subtitle && gap <= 0) {
    subtitle.innerHTML = '<span style="color:#2d7a2d">Month goal met 🎉</span>';
  }
}

function showPendingIndicator(action) {
  const el = document.getElementById('pendingIndicator');
  if (el) { el.style.display = 'block'; el.textContent = `⏳ ${action}`; }
}
function hidePendingIndicator() {
  const el = document.getElementById('pendingIndicator');
  if (el) el.style.display = 'none';
}

// ── List tab ──────────────────────────────────────────────────
function renderListTab() {
  chrome.storage.local.get(['scout_profiles', 'scout_settings'], (data) => {
    const profiles    = data.scout_profiles || {};
    const settings    = data.scout_settings || {};
    const maxLeaders  = settings.maxLeaders  || 50;
    const maxIcp      = settings.maxIcp      || 50;
    const profileList = Object.values(profiles);

    const enriched = profileList.filter(p => p.enrichStatus === 'ENRICHED');
    const pending  = profileList.filter(p => ['CAPTURED','QUEUED','SENT','PROCESSING'].includes(p.enrichStatus));

    const leaders = enriched
      .filter(p => ['LEADER','ICP_LEADER','OTHER_LEADER'].includes(p.type))
      .sort((a,b) => (b.priority||0) - (a.priority||0))
      .slice(0, maxLeaders);

    const icps = enriched
      .filter(p => p.type === 'ICP')
      .sort((a,b) => (b.priority||0) - (a.priority||0))
      .slice(0, maxIcp);

    const meta    = document.getElementById('listTabMeta');
    const listEl  = document.getElementById('listTabProfiles');
    const empty   = document.getElementById('listTabEmpty');

    if (meta) {
      meta.innerHTML = `
        <div style="display:flex;gap:4px;margin-bottom:8px;flex-wrap:wrap">
          ${[
            ['PRIORITY', `⚡ Priority`],
            ['ICP',      `ICP (${icps.length})`],
            ['LEADER',   `👑 Leaders (${leaders.length})`],
            ['PENDING',  `⏳ Pending (${pending.length})`],
          ].map(([f, label]) => `
            <button class="list-filter-btn${_currentFilter===f?' active':''}" data-filter="${f}"
              style="background:${_currentFilter===f?'#2E75B6':'#1a1a1a'};
                     color:${_currentFilter===f?'white':'#888'};
                     border:1px solid ${_currentFilter===f?'#2E75B6':'#333'};
                     border-radius:4px;padding:3px 8px;font-size:10px;cursor:pointer">
              ${label}
            </button>`).join('')}
        </div>`;
      meta.querySelectorAll('.list-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => { _currentFilter = btn.dataset.filter; renderListTab(); });
      });
    }

    let filtered = [];
    if (_currentFilter === 'PRIORITY') {
      // Mix top ICPs and leaders by priority, deduplicated
      const combined = [...icps, ...leaders]
        .filter((p, i, arr) => arr.findIndex(x => x.url === p.url) === i)
        .sort((a,b) => (b.priority||0) - (a.priority||0))
        .slice(0, 20);
      filtered = combined;
    } else if (_currentFilter === 'ICP') {
      filtered = icps;
    } else if (_currentFilter === 'LEADER') {
      filtered = leaders;
    } else if (_currentFilter === 'PENDING') {
      filtered = pending.sort((a,b) => (b.lastVisited||'').localeCompare(a.lastVisited||''));
    }

    if (!filtered.length) {
      if (listEl) listEl.innerHTML = '';
      if (empty) {
        empty.style.display = 'block';
        empty.textContent   = _currentFilter === 'PENDING' ? 'No profiles pending enrichment' : `No ${_currentFilter} profiles yet — browse LinkedIn profiles to populate`;
      }
      return;
    }

    if (empty) empty.style.display = 'none';
    if (!listEl) return;
    listEl.innerHTML = '';

    filtered.forEach(p => {
      const item = document.createElement('div');
      item.className = 'profile-item';

      const name = (p.name||'').replace(' | LinkedIn','').trim() || p.url.split('/in/')[1]?.replace('/','') || p.url;
      const ragColors = { GREEN:'#2d7a2d', AMBER:'#C07000', RED:'#C00000' };
      const ragBgs    = { GREEN:'#0d2b0d', AMBER:'#2b1a00', RED:'#2b0000' };
      const rc  = ragColors[p.rag] || '#333';
      const rbc = ragBgs[p.rag]    || '#111';

      const typeColors = { LEADER:'#C07000', ICP_LEADER:'#C07000', OTHER_LEADER:'#C07000', ICP:'#2d7a2d', ADJACENT:'#555', UNKNOWN:'#444' };
      const typeLabel  = { LEADER:'👑', ICP_LEADER:'👑 ICP Leader', OTHER_LEADER:'👑 Leader', ICP:'✓ ICP', ADJACENT:'~', UNKNOWN:'?' };

      if (p.enrichStatus === 'ENRICHED') {
        item.innerHTML = `
          <div style="border-left:3px solid ${rc};padding-left:8px;margin-bottom:2px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <div class="p-name" style="cursor:pointer;color:white;font-weight:bold;font-size:12px">${name}</div>
              <div style="display:flex;gap:4px;align-items:center">
                <span style="background:${rbc};color:${rc};border:1px solid ${rc};border-radius:3px;padding:1px 5px;font-size:9px;font-weight:bold">${p.rag||'—'}</span>
                <span style="color:#555;font-size:9px">P${p.priority||0}</span>
              </div>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:4px">
              <span style="color:${typeColors[p.type]||'#444'};font-size:9px">${typeLabel[p.type]||p.type||'—'}</span>
              ${p.icpScore != null ? `<span style="color:#555;font-size:9px">ICP ${p.icpScore}/10</span>` : ''}
            </div>
            ${p.action ? `
              <div style="background:#0d1a2b;border-radius:3px;padding:3px 6px;margin-bottom:4px;font-size:9px">
                <span style="color:#2E75B6;font-weight:bold">→ ${p.action}</span>
                ${p.actionReason ? `<span style="color:#555"> — ${p.actionReason.substring(0,70)}</span>` : ''}
              </div>` : ''}
            ${p.thoughtBait ? `
              <div style="background:#0a0a14;border:1px solid #1a1a2e;border-radius:3px;padding:4px 6px;margin-bottom:4px">
                <div style="font-size:9px;color:#2E75B6;margin-bottom:2px">💬 Comment starter</div>
                <div style="font-size:9px;color:#999;line-height:1.4">${p.thoughtBait.substring(0,120)}${p.thoughtBait.length > 120 ? '…' : ''}</div>
                <div style="display:flex;gap:4px;margin-top:4px">
                  <button class="copy-bait-btn" data-text="${p.thoughtBait.replace(/"/g,'&quot;')}"
                    style="background:#1F4E79;color:white;border:none;border-radius:3px;padding:2px 6px;font-size:9px;cursor:pointer">Copy</button>
                  <button class="open-profile-btn" data-url="${p.url}"
                    style="background:#1a1a1a;color:#888;border:1px solid #333;border-radius:3px;padding:2px 6px;font-size:9px;cursor:pointer">Open →</button>
                </div>
              </div>` : ''}
            ${p.lever ? `<div style="font-size:9px;color:#555;margin-bottom:2px">⚙ ${p.lever.substring(0,80)}</div>` : ''}
            <div style="font-size:9px;color:#444;margin-top:2px">${p.nurtureStage||'new'} · ${p.url.split('/in/')[1]?.replace('/','') || ''}</div>
          </div>
          <input class="p-notes-input" data-url="${p.url}" placeholder="Add note..." value="${(p.notes||'').replace(/"/g,'&quot;')}"
            style="width:100%;background:#111;border:none;border-top:1px solid #1a1a1a;padding:4px 6px;font-size:10px;color:#888;margin-top:6px;outline:none" />`;
      } else {
        // Pending card — minimal
        const statusColors = { CAPTURED:'#333', QUEUED:'#444', SENT:'#1F4E79', PROCESSING:'#2E75B6' };
        const sc = statusColors[p.enrichStatus] || '#333';
        item.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div class="p-name" style="cursor:pointer;color:#888;font-size:11px">${name}</div>
            <span style="color:${sc};font-size:9px">${p.enrichStatus}</span>
          </div>`;
      }

      item.querySelector('.p-name')?.addEventListener('click', () => chrome.tabs.create({ url: p.url }));
      item.querySelector('.copy-bait-btn')?.addEventListener('click', (e) => {
        const text = e.target.dataset.text;
        navigator.clipboard.writeText(text);
        e.target.textContent = '✓';
        setTimeout(() => { e.target.textContent = 'Copy'; }, 2000);
      });
      item.querySelector('.open-profile-btn')?.addEventListener('click', (e) => {
        chrome.tabs.create({ url: e.target.dataset.url });
      });
      item.querySelector('.p-notes-input')?.addEventListener('blur', e => {
        sendToBackground('updateLeadStatus', { url: p.url, notes: e.target.value });
      });

      listEl.appendChild(item);
    });
  });
}

// ── Settings tab ──────────────────────────────────────────────
function renderIntelligenceStats(stats, funnel) {
  const el = document.getElementById('intelStats');
  if (!el || !stats) return;
  el.innerHTML = `
    <div style="font-size:10px;color:#2E75B6;text-transform:uppercase;letter-spacing:0.8px;font-weight:bold;margin-bottom:8px">Intelligence Database</div>
    <div style="margin-bottom:6px">
      <div style="font-size:10px;color:#666;margin-bottom:4px">Pipeline</div>
      <div style="display:flex;flex-wrap:wrap;gap:3px">
        <span class="post-stat">Captured <span>${stats.captured}</span></span>
        <span class="post-stat">Queued <span style="color:#C07000">${stats.queued}</span></span>
        <span class="post-stat">Sent <span style="color:#1F4E79">${stats.sent}</span></span>
        <span class="post-stat">Enriched <span style="color:#2d7a2d">${stats.enriched}</span></span>
        ${stats.failed > 0 ? `<span class="post-stat">Failed <span style="color:#C00000">${stats.failed}</span></span>` : ''}
      </div>
    </div>
    <div style="margin-bottom:6px">
      <div style="font-size:10px;color:#666;margin-bottom:4px">Classifications</div>
      <div style="display:flex;flex-wrap:wrap;gap:3px">
        <span class="post-stat" style="border-color:#C07000">👑 Leaders <span style="color:#C07000">${stats.leaders}</span></span>
        <span class="post-stat" style="border-color:#2d7a2d">ICP <span style="color:#2d7a2d">${stats.icp}</span></span>
        <span class="post-stat">Total <span>${stats.total}</span></span>
      </div>
    </div>
    ${stats.queued > 0 ? `<div style="background:#1a1a1a;border:1px solid #C07000;border-radius:4px;padding:6px 8px;font-size:10px;color:#C07000;margin-bottom:6px">${stats.queued} profiles waiting — click Flush Queue</div>` : ''}
    <button id="btnExportIntel" style="width:100%;background:#1a1a1a;color:#ccc;border:1px solid #333;border-radius:4px;padding:6px;font-size:10px;cursor:pointer;margin-bottom:4px">📤 Export (${stats.total} profiles)</button>`;
  document.getElementById('btnExportIntel')?.addEventListener('click', exportIntelligenceDb);
}

// ── Button wiring ─────────────────────────────────────────────
function wireButtons() {
  document.getElementById('tabMain')    ?.addEventListener('click', () => switchTab('main'));
  document.getElementById('tabList')    ?.addEventListener('click', () => switchTab('list'));
  document.getElementById('tabSettings')?.addEventListener('click', () => switchTab('settings'));

  document.getElementById('btnSaveApiKey')?.addEventListener('click', () => {
    const key = document.getElementById('apiKeyInput')?.value.trim() || '';
    chrome.storage.local.set({ scout_api_key: key }, () => {
      showApiStatus(key ? '✓ API key saved' : '✓ Local mode');
    });
  });

  document.getElementById('btnTestApi')?.addEventListener('click', async () => {
    showApiStatus('Testing...');
    try {
      const r = await fetch('http://localhost:5001/health');
      const d = await r.json();
      showApiStatus(d.gateway === 'ok' ? `✓ Gateway ok · Agent ${d.agentic}` : '⚠ Gateway responded, status unknown');
    } catch(e) {
      showApiStatus('✗ Gateway not running — type: make up-gateway');
    }
  });

  document.getElementById('btnFlushQueue')?.addEventListener('click', async () => {
    showApiStatus('Flushing...');
    sendToBackground('flushQueue');
    setTimeout(() => sendToBackground('getStats'), 2000);
  });

  document.getElementById('settingNumResults')?.addEventListener('change', e => {
    sendToBackground('saveSetting', { key: 'numResults', value: parseInt(e.target.value) });
  });
  document.getElementById('settingMaxProfiles')?.addEventListener('change', e => {
    sendToBackground('saveSetting', { key: 'maxProfiles', value: parseInt(e.target.value) });
  });

  document.getElementById('btnGoToList')?.addEventListener('click', () => switchTab('list'));
  document.getElementById('btnTimerStart')?.addEventListener('click', startTimer);
  document.getElementById('btnTimerStop') ?.addEventListener('click', stopTimer);

  chrome.storage.local.get(['scout_api_key'], r => {
    const input = document.getElementById('apiKeyInput');
    if (input && r.scout_api_key) input.value = r.scout_api_key;
  });

  chrome.storage.local.get(['scout_profiles'], r => {
    const profiles = Object.values(r.scout_profiles || {});
    const queued   = profiles.filter(p => p.enrichStatus === 'QUEUED').length;
    const btn      = document.getElementById('btnFlushQueue');
    if (btn && queued > 0) btn.textContent = `⚡ Flush Queue (${queued})`;
  });

  document.getElementById('btnPatternAnalysis')?.addEventListener('click', generatePatternAnalysis);
  document.getElementById('btnExportList')     ?.addEventListener('click', exportIntelligenceDb);
  document.getElementById('btnClearAll')        ?.addEventListener('click', () => {
    if (confirm('Clear all Scout data? This cannot be undone.')) {
      chrome.storage.local.remove(['scout_profiles','scout_posts','scout_comments','scout_funnel'], () => {
        renderListTab();
        sendToBackground('getStats');
      });
    }
  });
}

function showApiStatus(msg) {
  const el = document.getElementById('apiStatus');
  if (el) el.textContent = msg;
}

function applySettings(settings) {
  if (!settings) return;
  const numResults = document.getElementById('settingNumResults');
  const maxProf    = document.getElementById('settingMaxProfiles');
  if (numResults) numResults.value = settings.numResults  || 10;
  if (maxProf)    maxProf.value    = settings.maxProfiles || 50;
}

// ── Pattern analysis prompt ───────────────────────────────────
function generatePatternAnalysis() {
  chrome.storage.local.get(['scout_profiles'], (data) => {
    const profiles = Object.values(data.scout_profiles || {})
      .filter(p => p.enrichStatus === 'ENRICHED')
      .slice(-20);
    const prompt = `Analyse these ${profiles.length} LinkedIn profiles I've enriched and identify patterns:

${profiles.map(p => `- ${p.name}: type=${p.type}, rag=${p.rag}, action=${p.action}, lever=${p.lever||'—'}`).join('\n')}

Tell me:
1. What false positives am I capturing (not really ICP)?
2. What patterns emerge in the highest priority profiles?
3. How should I refine my ICP definition?`;
    chrome.tabs.create({ url: `https://claude.ai/new?q=${encodeURIComponent(prompt)}` });
  });
}

// ── Export ────────────────────────────────────────────────────
function exportIntelligenceDb() {
  chrome.storage.local.get(['scout_profiles'], (data) => {
    const profiles = Object.values(data.scout_profiles || {});
    const clean    = s => (s||'').replace(/,/g,' ').replace(/\n/g,' ');
    const csv = ['Name,URL,Type,RAG,Priority,ICP Score,Action,Lever,Nurture Stage,Enrich Status,Last Visited,Notes']
      .concat(profiles.map(p => [
        clean(p.name), clean(p.url), clean(p.type), clean(p.rag),
        p.priority||'', p.icpScore||'', clean(p.action), clean(p.lever),
        clean(p.nurtureStage), clean(p.enrichStatus),
        (p.lastVisited||'').slice(0,10), clean(p.notes),
      ].map(v => `"${v}"`).join(','))).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    chrome.downloads.download({ url: URL.createObjectURL(blob), filename: `scout-intelligence-${Date.now()}.csv` });
  });
}

// ── Timer ─────────────────────────────────────────────────────
let _timerInterval = null;
let _timerSeconds  = 0;

function startTimer() {
  if (_timerInterval) return;
  _timerSeconds  = 0;
  _timerInterval = setInterval(() => {
    _timerSeconds++;
    const m = Math.floor(_timerSeconds / 60);
    const s = _timerSeconds % 60;
    const el = document.getElementById('sessionTimer');
    if (el) el.textContent = `${m}:${String(s).padStart(2,'0')}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(_timerInterval);
  _timerInterval = null;
}

// ── Helpers ───────────────────────────────────────────────────
function normaliseUrl(url) {
  const m = url?.match(/linkedin\.com\/in\/([^/?#]+)/);
  return m ? `https://www.linkedin.com/in/${m[1]}/` : url;
}