/**
 * Browser EventSource client for /api/odds/stream.
 *
 * Follows the EventSource lifecycle: onopen, named events, and onerror
 * branched on readyState. A CLOSED stream is not retried by the browser
 * after an HTTP error, so reconnect is manual with exponential backoff.
 * disconnect() always calls close() so the connection does not outlive the page.
 */

import { MARKET_DRIFT_CONFIG } from './fair-price.js';

export class OddsStreamClient {
  /**
   * @param {string} url
   * @param {{
   *   onStatus?: (status: 'connecting' | 'open' | 'closed' | 'error') => void,
   *   onOdds?: (data: string, lastEventId: string) => void,
   *   onSnapshot?: (data: string, lastEventId: string) => void,
   *   onHeartbeat?: (data: string, lastEventId: string) => void,
   * }} handlers
   */
  constructor(url, handlers = {}) {
    this.url = url;
    this.handlers = handlers;
    this.eventSource = null;
    this.status = 'closed';
    this.manualRetryCount = 0;
    this.retryTimer = null;
    this.lastEventId = null;
    this.closedByUser = false;
  }

  connect() {
    this.closedByUser = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    this.setStatus('connecting');
    const eventSource = new EventSource(this.streamUrl());
    this.eventSource = eventSource;

    eventSource.onopen = () => {
      this.setStatus('open');
      this.manualRetryCount = 0;
    };

    eventSource.addEventListener('odds', (event) => {
      this.noteId(event);
      this.handlers.onOdds?.(event.data, event.lastEventId || '');
    });

    eventSource.addEventListener('snapshot', (event) => {
      this.noteId(event);
      this.handlers.onSnapshot?.(event.data, event.lastEventId || '');
    });

    eventSource.addEventListener('heartbeat', (event) => {
      this.noteId(event);
      this.handlers.onHeartbeat?.(event.data, event.lastEventId || '');
    });

    eventSource.onerror = () => {
      if (eventSource.readyState === EventSource.CLOSED) {
        this.eventSource = null;
        this.setStatus('closed');
        this.attemptManualReconnect();
      } else if (eventSource.readyState === EventSource.CONNECTING) {
        this.setStatus('error');
      }
    };
  }

  /** Close the stream and cancel any pending manual reconnect. */
  disconnect() {
    this.closedByUser = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.eventSource?.close();
    this.eventSource = null;
    this.setStatus('closed');
  }

  streamUrl() {
    const base = this.url.split('?')[0];
    if (!this.lastEventId) return base;
    return `${base}?lastEventId=${encodeURIComponent(this.lastEventId)}`;
  }

  noteId(event) {
    const id = Number(event.lastEventId);
    if (!Number.isFinite(id)) return;
    if (this.lastEventId == null || id > Number(this.lastEventId)) {
      this.lastEventId = String(id);
    }
  }

  attemptManualReconnect() {
    if (this.closedByUser) return;
    this.manualRetryCount += 1;
    const exponent = Math.min(this.manualRetryCount - 1, 5);
    const delay = Math.min(
      MARKET_DRIFT_CONFIG.reconnectMaxMs,
      MARKET_DRIFT_CONFIG.reconnectBaseMs * (2 ** exponent),
    );
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  setStatus(status) {
    this.status = status;
    this.handlers.onStatus?.(status);
  }
}
