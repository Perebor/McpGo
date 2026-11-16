/**
 * McpGo's side-effect-free browser session state and on-demand reconnection
 * policy. This module NEVER connects to Chrome during a status/health check.
 *
 * An MCP initialize/tools/list proves server readiness, not browser readiness.
 * A real browser tool result is the only evidence of an attached Chrome.
 * No URLs, titles, tokens, client identifiers, or tab contents are recorded.
 */
export const SHARED_CLIENT = 'MCPGO';

const BROWSER_LOST = /extension (?:did not connect|disconnected|connection|not found)|browser (?:has been )?closed|browser is not connected|chrome (?:connection|extension) (?:closed|disconnected|timed out)|failed to connect to (?:browser|chrome)|target page, context or browser has been closed/i;

export function browserTransportFailed(response) {
  if (!response || response.status === 404) return true;
  if (response.status !== 200) return false;
  let decoded;
  const raw = Buffer.isBuffer(response.body) ? response.body.toString('utf8') : String(response.body || '');
  try {
    const event = raw.trimStart().startsWith('{') ? raw : raw.split(/\r?\n/).find(line=>line.startsWith('data: '))?.slice(6);
    if (!event) return false;
    decoded = JSON.parse(event);
  } catch { return false; }
  if (decoded?.error) return BROWSER_LOST.test(decoded.error.message || '');
  if (decoded?.result?.isError) {
    const message = (decoded.result.content || []).filter(c=>c.type === 'text').map(c=>c.text || '').join(' ').slice(0,2000);
    return BROWSER_LOST.test(message);
  }
  return false;
}

export class BrowserReconnectError extends Error {
  constructor(retryAfterMs) {
    super('Browser connection is in cooldown; retry after '+Math.ceil(retryAfterMs / 1000)+' seconds');
    this.code = 'BROWSER_RECONNECT_COOLDOWN';
    this.retryAfterMs = retryAfterMs;
  }
}

export class BrowserSessionManager {
  constructor({now=()=>Date.now(),minDelayMs=3000,maxDelayMs=60000}={}) {
    this.now = now;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.browserState = 'unknown';
    this.mcpState = 'unknown';
    this.sessionGeneration = 0;
    this.connectAttempts = 0;
    this.failedConnections = 0;
    this.consecutiveFailures = 0;
    this.retryAt = 0;
    this.lastBrowserConnectedAt = null;
    this.lastFailureCode = null;
    this.pending = false;
  }
  markMcpReady() { this.mcpState = 'ready'; }
  markMcpUnavailable() {
    this.mcpState = 'unavailable';
    this.browserState = 'unknown';
    this.sessionGeneration++;
    this.pending = false;
    // A newly initialized backend is a distinct generation. Never apply a
    // stale Chrome connection cooldown from the previous MCP session.
    this.retryAt = 0;
    this.consecutiveFailures = 0;
  }
  beforeBrowserCall() {
    const wait = this.retryAt - this.now();
    if (wait > 0) throw new BrowserReconnectError(wait);
    if (this.browserState !== 'connected' && !this.pending) {
      this.pending = true;
      this.browserState = this.consecutiveFailures ? 'recovering' : 'connecting';
      this.connectAttempts++;
    }
  }
  recordBrowserResult(response) {
    if (browserTransportFailed(response)) {
      this.pending = false;
      this.failedConnections++;
      this.consecutiveFailures++;
      this.browserState = 'degraded';
      this.lastFailureCode = response?.status === 404 ? 'MCP_SESSION_EXPIRED' : 'BROWSER_CONNECTION_FAILED';
      this.retryAt = this.now() + Math.min(this.maxDelayMs,this.minDelayMs * Math.pow(2,Math.min(6,this.consecutiveFailures - 1)));
      return;
    }
    if (response?.status === 200) {
      this.pending = false;
      this.browserState = 'connected';
      this.mcpState = 'ready';
      this.retryAt = 0;
      this.consecutiveFailures = 0;
      this.lastFailureCode = null;
      this.lastBrowserConnectedAt = new Date(this.now()).toISOString();
    } else {
      // A policy/validation failure does not prove the browser disconnected.
      this.pending = false;
      if (this.browserState === 'connecting' || this.browserState === 'recovering')
        this.browserState = 'unknown';
    }
  }
  status() {
    return {
      mcp: this.mcpState,
      browser: this.browserState,
      shared: true,
      sessionName: SHARED_CLIENT,
      generation: this.sessionGeneration,
      attempts: this.connectAttempts,
      failures: this.failedConnections,
      cooldownMs: Math.max(0,this.retryAt - this.now()),
      lastConnectedAt: this.lastBrowserConnectedAt,
      lastFailureCode: this.lastFailureCode,
    };
  }
}
