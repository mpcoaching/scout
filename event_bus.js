/**
 * event_bus.js
 *
 * Single event bus. All actions from popup and content script
 * flow through here. Background.js imports and uses this.
 *
 * Responsibilities:
 *   - Receive events from any source
 *   - Queue them immediately
 *   - Acknowledge immediately (non-blocking)
 *   - Process queue asynchronously
 *   - Log every event
 *   - Notify popup of state changes
 *
 * Popup and content script never wait for results.
 * Results arrive via storage changes or direct messages.
 */

const EventBus = {

  queue:      [],
  processing: false,
  log:        [],
  MAX_LOG:    200,

  // ── Public API ──────────────────────────────────────────

  /**
   * Dispatch an event. Returns immediately.
   * Processing happens asynchronously.
   */
  dispatch(event, sender) {
    const entry = {
      id:        this._uid(),
      action:    event.action,
      data:      event,
      sender:    sender?.url || 'popup',
      timestamp: Date.now(),
      status:    'QUEUED',
    };

    this.queue.push(entry);
    this._log(entry);

    // Notify popup immediately — "I got that"
    this._notifyPopup('event_queued', {
      action: event.action,
      id:     entry.id,
    });

    // Start processing if not already running
    this._processNext();

    return entry.id;
  },

  /**
   * Register a handler for an action type.
   * Called by background.js to wire up handlers.
   */
  handlers: {},

  register(action, handler) {
    this.handlers[action] = handler;
  },

  // ── Internal ────────────────────────────────────────────

  async _processNext() {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const entry = this.queue[0];
      entry.status = 'PROCESSING';

      try {
        const handler = this.handlers[entry.action];
        if (handler) {
          const result = await handler(entry.data);
          entry.status = 'DONE';
          entry.result = result;
          this._notifyPopup('event_done', {
            action: entry.action,
            id:     entry.id,
            result,
          });
        } else {
          entry.status = 'UNHANDLED';
        }
      } catch(e) {
        entry.status = 'FAILED';
        entry.error  = e.message;
        this._notifyPopup('event_failed', {
          action: entry.action,
          id:     entry.id,
          error:  e.message,
        });
      }

      this.queue.shift();
      this._log(entry);
    }

    this.processing = false;
  },

  _notifyPopup(type, data) {
    // Send message to popup if it's open
    // Fails silently if popup is closed — that's correct
    chrome.runtime.sendMessage({ type, ...data })
      .catch(() => {});
  },

  _log(entry) {
    this.log.unshift({
      id:        entry.id,
      action:    entry.action,
      status:    entry.status,
      timestamp: entry.timestamp,
      error:     entry.error,
    });
    if (this.log.length > this.MAX_LOG) {
      this.log = this.log.slice(0, this.MAX_LOG);
    }
  },

  _uid() {
    return Math.random().toString(36).substring(2, 10);
  },

  getLog() {
    return this.log;
  },

  getQueueDepth() {
    return this.queue.length;
  },
};
