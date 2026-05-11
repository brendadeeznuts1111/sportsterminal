import { logger } from './logger.js';

export class TerminalWebSocketClient {
  constructor(dependencies = {}) {
    this.ws = null;
    this.getDefaultWsUrl = dependencies.getDefaultWsUrl;
    this.updateWSStatus = dependencies.updateWSStatus;
    this.updateConnectionStatus = dependencies.updateConnectionStatus;
    this.showToast = dependencies.showToast;
    this.updateFromBackend = dependencies.updateFromBackend;
    this.loadPersistedWagers = dependencies.loadPersistedWagers;
    this.url = localStorage.getItem('wsUrl') || this.getDefaultWsUrl();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 3000;
    this.isAuthenticated = false;
    this.agentId = localStorage.getItem('agentId') || '';
    this.messageHandlers = {};
  }

  get isConnected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect() {
    logger.info('WS', 'Connecting to', this.url);
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      logger.info('WS', 'Connected to', this.url);
      this.reconnectAttempts = 0;
      this.updateWSStatus(true);
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        logger.debug('WS', `Message: ${msg.type}`);
        this.handleMessage(msg);
      } catch {
        logger.error('WS', 'Failed to parse message', event.data);
      }
    };

    this.ws.onerror = (error) => {
      logger.error('WS', `Connection error to ${this.url}`, error);
      this.updateWSStatus(false);
    };

    this.ws.onclose = (event) => {
      logger.info('WS', `Closed ${event.code} ${event.reason}`);
      this.updateWSStatus(false);
      this.updateConnectionStatus('disconnected');
      this.isAuthenticated = false;
      this.attemptReconnect();
    };
  }

  authenticate(agentId, username, password, cfCookie) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error('WS', 'Not connected');
      return;
    }
    logger.info('WS', 'Authenticating...');
    this.send({
      type: 'auth',
      agentId,
      username,
      password,
      cfCookie,
    });
  }

  authenticateWithToken(agentId, token, cfCookie) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error('WS', 'Not connected');
      return;
    }
    logger.info('WS', 'Resuming session with token...');
    this.send({
      type: 'auth',
      agentId,
      token,
      cfCookie,
    });
  }

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

  handleMessage(msg) {
    switch (msg.type) {
      case 'auth_response':
        if (msg.success) {
          this.isAuthenticated = true;
          this.showToast('Authenticated - live polling started', 'success');
          logger.info('WS', 'Auth successful');
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

  on(type, handler) {
    this.messageHandlers[type] = handler;
  }

  attemptReconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      logger.warn('WS', `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
      setTimeout(() => this.connect(), delay);
    } else {
      logger.error('WS', 'Max reconnection attempts reached');
    }
  }
}
