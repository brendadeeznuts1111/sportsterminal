// @ts-check
/** @typedef {import('../../../shared/messages.ts').ClientSocketMessage} ClientSocketMessage */
/** @typedef {import('../../../shared/messages.ts').ServerMessage} ServerMessage */
/** @typedef {import('../../../shared/domain.ts').AgentDataResponse} AgentDataResponse */

/**
 * @typedef {Object} WsClientDependencies
 * @property {() => string} getDefaultWsUrl
 * @property {(connected: boolean) => void} updateWSStatus
 * @property {(status: string) => void} updateConnectionStatus
 * @property {(message: string, level: string) => void} showToast
 * @property {(data: AgentDataResponse) => void} updateFromBackend
 * @property {(force?: boolean) => void} loadPersistedWagers
 */

export class TerminalWebSocketClient {
  /** @type {WebSocket | null} */
  ws = null;

  /** @type {() => string} */
  getDefaultWsUrl;

  /** @type {(connected: boolean) => void} */
  updateWSStatus;

  /** @type {(status: string) => void} */
  updateConnectionStatus;

  /** @type {(message: string, level: string) => void} */
  showToast;

  /** @type {(data: AgentDataResponse) => void} */
  updateFromBackend;

  /** @type {(force?: boolean) => void} */
  loadPersistedWagers;

  /** @type {string} */
  url;

  /** @type {number} */
  reconnectAttempts = 0;

  /** @type {number} */
  maxReconnectAttempts = 5;

  /** @type {number} */
  reconnectDelay = 3000;

  /** @type {boolean} */
  isAuthenticated = false;

  /** @type {string} */
  agentId = localStorage.getItem('agentId') || '';

  /** @type {Record<string, (msg: ServerMessage) => void>} */
  messageHandlers = {};

  /** @param {Partial<WsClientDependencies>} [dependencies] */
  constructor(dependencies = {}) {
    this.getDefaultWsUrl = /** @type {() => string} */ (dependencies.getDefaultWsUrl);
    this.updateWSStatus = /** @type {(connected: boolean) => void} */ (dependencies.updateWSStatus);
    this.updateConnectionStatus = /** @type {(status: string) => void} */ (dependencies.updateConnectionStatus);
    this.showToast = /** @type {(message: string, level: string) => void} */ (dependencies.showToast);
    this.updateFromBackend = /** @type {(data: AgentDataResponse) => void} */ (dependencies.updateFromBackend);
    this.loadPersistedWagers = /** @type {(force?: boolean) => void} */ (dependencies.loadPersistedWagers);
    this.url = localStorage.getItem('wsUrl') || this.getDefaultWsUrl();
  }

  get isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    console.log('[WS] Connecting to', this.url);
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log('[WS] Connected to', this.url);
      this.reconnectAttempts = 0;
      this.updateWSStatus(true);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = /** @type {ServerMessage} */ (JSON.parse(event.data));
        console.log('[WS] Message:', msg.type);
        this.handleMessage(msg);
      } catch {
        console.error('[WS] Failed to parse message:', event.data);
      }
    };

    this.ws.onerror = (error) => {
      console.error('[WS] Connection error to', this.url, error);
      this.updateWSStatus(false);
    };

    this.ws.onclose = (event) => {
      console.log('[WS] Closed', event.code, event.reason);
      this.updateWSStatus(false);
      this.updateConnectionStatus('disconnected');
      this.isAuthenticated = false;
      this.attemptReconnect();
    };
  }

  /**
   * @param {string} agentId
   * @param {string} username
   * @param {string} password
   * @param {string} cfCookie
   */
  authenticate(agentId, username, password, cfCookie) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[WS] Not connected');
      return;
    }
    console.log('[WS] Authenticating...');
    this.send({
      type: 'auth',
      agentId,
      username,
      password,
      cfCookie,
    });
  }

  /**
   * @param {string} agentId
   * @param {string} token
   * @param {string} cfCookie
   */
  authenticateWithToken(agentId, token, cfCookie) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[WS] Not connected');
      return;
    }
    console.log('[WS] Resuming session with token...');
    this.send({
      type: 'auth',
      agentId,
      token,
      cfCookie,
    });
  }

  /** @param {ClientSocketMessage} msg */
  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  requestData() {
    if (this.isAuthenticated) {
      this.send({
        type: 'request_data',
        agentId: this.agentId,
      });
    }
  }

  /** @param {ServerMessage} msg */
  handleMessage(msg) {
    switch (msg.type) {
      case 'auth_response':
        if (msg.success) {
          this.isAuthenticated = true;
          this.showToast('Authenticated - live polling started', 'success');
          console.log('[WS] Auth successful');
          this.updateConnectionStatus('connected');
          setTimeout(() => this.requestData(), 500);
        } else {
          this.showToast(`Authentication failed: ${msg.message || 'Unknown error'}`, 'error');
          this.updateConnectionStatus('disconnected');
        }
        break;
      case 'data_response':
        if (msg.data) {
          this.updateFromBackend(msg.data);
          this.loadPersistedWagers(true);
        }
        break;
      case 'error':
        this.showToast(`Backend error: ${msg.message}`, 'error');
        break;
      default:
        if (this.messageHandlers[msg.type]) {
          this.messageHandlers[msg.type](msg);
        }
    }
  }

  /**
   * @param {string} type
   * @param {(msg: ServerMessage) => void} handler
   */
  on(type, handler) {
    this.messageHandlers[type] = handler;
  }

  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      console.log(`[WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      setTimeout(() => this.connect(), delay);
    } else {
      console.error('[WS] Max reconnection attempts reached');
    }
  }
}
