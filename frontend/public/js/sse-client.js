import { COMMAND_CENTER_MAP } from './command-center-map.js';

const LIVE_SSE_URL = COMMAND_CENTER_MAP.endpoints.liveWagersStream;

class LiveSseClient {
  constructor(url = LIVE_SSE_URL) {
    this.url = url;
    this.source = null;
    this.reconnectTimer = null;
  }

  connect() {
    if (!('EventSource' in window) || this.source) return;
    this.source = new EventSource(this.withToken(this.url));

    for (const eventName of COMMAND_CENTER_MAP.sse.events) {
      this.source.addEventListener(eventName, (event) => {
        this.emit(eventName, this.parse(event.data));
      });
    }

    this.source.onerror = () => {
      this.close();
      this.reconnectTimer = window.setTimeout(() => this.connect(), 5000);
    };
  }

  close() {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.source) {
      this.source.close();
      this.source = null;
    }
  }

  parse(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  emit(type, detail) {
    window.dispatchEvent(new CustomEvent(COMMAND_CENTER_MAP.sse.browserEventPrefix, { detail: { type, payload: detail } }));
    window.dispatchEvent(new CustomEvent(`${COMMAND_CENTER_MAP.sse.browserEventPrefix}:${type}`, { detail }));
  }

  withToken(url) {
    const token = COMMAND_CENTER_MAP.auth.tokenStorageKeys
      .map((key) => localStorage.getItem(key))
      .find(Boolean);
    if (!token) return url;
    const next = new URL(url, window.location.origin);
    next.searchParams.set(COMMAND_CENTER_MAP.auth.queryTokenParam, token);
    return next.pathname + next.search;
  }
}

window.liveSseClient = window.liveSseClient || new LiveSseClient();
window.liveSseClient.connect();
