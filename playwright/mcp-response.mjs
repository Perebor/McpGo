/** The single JSON-RPC decoder/transformer for JSON and MCP SSE responses.
 * Only a complete, matching JSON-RPC result/error may finish an action.
 * SSE notifications and keepalives are never mistaken for action receipts.
 */
const asString = input => Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '');
export const isSse = contentType => /\btext\/event-stream\b/i.test(String(contentType || ''));
const eventBoundary = /\r\n\r\n|\n\n|\r\r/;
function frameMessage(frame) {
  const fields = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:'));
  if (!fields.length) return null;
  const payload = fields.map(line => line.slice(5).replace(/^ /, '')).join('\n');
  try { return JSON.parse(payload); } catch { return null; }
}
export function parseMcpMessages(raw, contentType='application/json') {
  const source = asString(raw);
  if (!isSse(contentType) && source.trimStart().startsWith('{')) return [JSON.parse(source)];
  const events = [];
  let rest = source, match;
  while ((match = eventBoundary.exec(rest))) {
    const frame = rest.slice(0, match.index);
    const message = frameMessage(frame);
    if (message !== null) events.push(message);
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest.trim()) throw new Error('MCP_SSE_INCOMPLETE_EVENT');
  return events;
}
export function responseMessage(raw, contentType='application/json', requestId=null) {
  const messages = parseMcpMessages(raw, contentType);
  const match = messages.find(msg => msg && typeof msg === 'object' &&
    (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error')) &&
    (requestId === null || String(msg.id) === String(requestId)));
  if (!match) throw new Error('MCP_RESPONSE_MISSING_MATCHING_RESULT');
  return match;
}
export function transformMcpResponse(raw, contentType, transform) {
  const source = asString(raw);
  if (!isSse(contentType) && source.trimStart().startsWith('{'))
    return Buffer.from(JSON.stringify(transform(JSON.parse(source))));
  let rest = source, output = '', match;
  while ((match = eventBoundary.exec(rest))) {
    const frame = rest.slice(0, match.index);
    const message = frameMessage(frame);
    output += message === null ? frame + match[0] :
      'event: message\ndata: ' + JSON.stringify(transform(message)) + '\n\n';
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest.trim()) throw new Error('MCP_SSE_INCOMPLETE_EVENT');
  return Buffer.from(output);
}
export class McpSseResultReader {
  constructor(requestId) { this.requestId = requestId; this.decoder = new TextDecoder(); this.buffer = ''; }
  push(bytes) {
    this.buffer += this.decoder.decode(bytes, {stream:true});
    let match;
    while ((match = eventBoundary.exec(this.buffer))) {
      const frame = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const message = frameMessage(frame);
      if (message && String(message.id) === String(this.requestId) &&
          (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')))
        return {message, body:Buffer.from('event: message\ndata: '+JSON.stringify(message)+'\n\n')};
    }
    return null;
  }
}
