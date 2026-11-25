import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { RUNNER_PROTOCOL_VERSION } from './command-policy.mjs';

export { RUNNER_PROTOCOL_VERSION };
export const DEFAULT_RUNNER_SOCKET_DIR = '/run/bot-runner';
export const DEFAULT_RUNNER_SOCKET_PATH = '/run/bot-runner/runner.sock';
export const DEFAULT_RUNNER_TOKEN_FILE = '/run/bot-runner/.token';
export const DEFAULT_MAX_WS_MESSAGE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_COMMAND_HEARTBEAT_MS = 5_000;
export const DEFAULT_LONG_POLL_WAIT_MS = 25_000;

export const WS_OPCODES = Object.freeze({
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
});

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function wsAcceptKey(key) {
  return createHash('sha1').update(String(key || '') + WS_GUID).digest('base64');
}

export function bearerTokenMatches(authorizationHeader, expectedToken) {
  if (typeof expectedToken !== 'string' || !expectedToken) return false;
  if (typeof authorizationHeader !== 'string' || !authorizationHeader.startsWith('Bearer ')) return false;
  const presented = authorizationHeader.slice(7);
  if (!presented) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(a, b);
}

export async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maxBytes) {
      throw Object.assign(new Error('runner_request_too_large'), {
        status: 413,
        code: 'runner_request_too_large',
        limit: maxBytes,
        length,
      });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400, code: 'invalid_json' });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('invalid_input'), { status: 400, code: 'invalid_input' });
  }
  return parsed;
}

export function encodeWsFrame(opcode, payload = Buffer.alloc(0), { mask = false, fin = true } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let headerLen = 2;
  if (len >= 126 && len <= 0xffff) headerLen += 2;
  else if (len > 0xffff) headerLen += 8;
  if (mask) headerLen += 4;

  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  let offset = 2;
  if (len < 126) {
    frame[1] = (mask ? 0x80 : 0x00) | len;
  } else if (len <= 0xffff) {
    frame[1] = (mask ? 0x80 : 0x00) | 126;
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    frame[1] = (mask ? 0x80 : 0x00) | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    offset = 10;
  }
  if (mask) {
    const maskKey = randomBytes(4);
    maskKey.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      frame[offset + i] = body[i] ^ maskKey[i & 3];
    }
  } else {
    body.copy(frame, offset);
  }
  return frame;
}

/**
 * Zero-dependency RFC 6455 WebSocket connection over an upgraded net.Socket (UDS or TCP).
 * Handles arbitrary chunk splits, fragmented frames, masking/unmasking, ping/pong keepalives,
 * message size bounds, and graceful close handshakes.
 */
export class WsConnection extends EventEmitter {
  constructor(socket, { isServer = false, maxMessageBytes = DEFAULT_MAX_WS_MESSAGE_BYTES, initialData = null } = {}) {
    super();
    this.socket = socket;
    this.isServer = isServer;
    this.maxMessageBytes = maxMessageBytes;
    this.closed = false;
    this.closeSent = false;
    this._buffer = Buffer.alloc(0);
    this._fragOpcode = null;
    this._fragChunks = [];
    this._fragBytes = 0;

    socket.on('data', chunk => this._onData(chunk));
    socket.on('error', err => {
      if (!this.closed) this.emit('error', err);
    });
    socket.on('close', () => {
      if (!this.closed) {
        this.closed = true;
        this.emit('close', { code: 1006, reason: '' });
      }
    });
    if (initialData && initialData.length) {
      queueMicrotask(() => {
        if (!this.closed) this._onData(initialData);
      });
    }
  }

  get open() {
    return !this.closed && !this.socket.destroyed && this.socket.writable;
  }

  _sendFrame(opcode, payload = Buffer.alloc(0)) {
    if (!this.open) return false;
    const frame = encodeWsFrame(opcode, payload, { mask: !this.isServer, fin: true });
    try {
      this.socket.write(frame);
      return true;
    } catch {
      return false;
    }
  }

  sendText(text) {
    return this._sendFrame(WS_OPCODES.TEXT, Buffer.from(String(text), 'utf8'));
  }

  sendJson(value) {
    return this.sendText(JSON.stringify(value));
  }

  sendBinary(buffer) {
    return this._sendFrame(WS_OPCODES.BINARY, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  }

  ping(payload = Buffer.alloc(0)) {
    return this._sendFrame(WS_OPCODES.PING, payload);
  }

  pong(payload = Buffer.alloc(0)) {
    return this._sendFrame(WS_OPCODES.PONG, payload);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    if (!this.closeSent && this.open) {
      this.closeSent = true;
      const reasonBuf = Buffer.from(String(reason || '').slice(0, 120), 'utf8');
      const payload = Buffer.allocUnsafe(2 + reasonBuf.length);
      payload.writeUInt16BE(code, 0);
      reasonBuf.copy(payload, 2);
      this._sendFrame(WS_OPCODES.CLOSE, payload);
      try { this.socket.end(); } catch {}
    } else if (!this.socket.destroyed) {
      this.socket.destroy();
    }
  }

  destroy() {
    if (!this.closed) {
      this.closed = true;
      this.emit('close', { code: 1006, reason: '' });
    }
    if (!this.socket.destroyed) this.socket.destroy();
  }

  _failProtocol(code, reason) {
    this.close(code, reason);
    this.socket.destroy();
  }

  _onData(chunk) {
    if (this.closed || !chunk?.length) return;
    this._buffer = this._buffer.length ? Buffer.concat([this._buffer, chunk]) : Buffer.from(chunk);
    while (!this.closed && this._buffer.length >= 2) {
      const b0 = this._buffer[0];
      const b1 = this._buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const rsv = b0 & 0x70;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (rsv !== 0) { this._failProtocol(1002, 'rsv_unsupported'); return; }
      if (this.isServer && !masked) { this._failProtocol(1002, 'client_mask_required'); return; }
      if (!this.isServer && masked) { this._failProtocol(1002, 'server_frame_masked'); return; }

      if (payloadLen === 126) {
        if (this._buffer.length < 4) return;
        payloadLen = this._buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this._buffer.length < 10) return;
        const big = this._buffer.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessageBytes)) { this._failProtocol(1009, 'message_too_large'); return; }
        payloadLen = Number(big);
        offset = 10;
      }

      const isControl = opcode >= 0x8;
      if (isControl && (!fin || payloadLen > 125)) { this._failProtocol(1002, 'invalid_control_frame'); return; }
      if (!isControl && payloadLen > this.maxMessageBytes) { this._failProtocol(1009, 'message_too_large'); return; }

      const frameTotal = offset + (masked ? 4 : 0) + payloadLen;
      if (this._buffer.length < frameTotal) return;

      let payload;
      if (masked) {
        const maskKey = this._buffer.subarray(offset, offset + 4);
        offset += 4;
        payload = Buffer.allocUnsafe(payloadLen);
        for (let i = 0; i < payloadLen; i++) {
          payload[i] = this._buffer[offset + i] ^ maskKey[i & 3];
        }
      } else {
        payload = Buffer.from(this._buffer.subarray(offset, offset + payloadLen));
      }
      this._buffer = frameTotal === this._buffer.length ? Buffer.alloc(0) : this._buffer.subarray(frameTotal);

      if (opcode === WS_OPCODES.PING) {
        this.pong(payload);
        this.emit('ping', payload);
        continue;
      }
      if (opcode === WS_OPCODES.PONG) {
        this.emit('pong', payload);
        continue;
      }
      if (opcode === WS_OPCODES.CLOSE) {
        const closeCode = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const closeReason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this.closeSent && this.open) {
          this.closeSent = true;
          this._sendFrame(WS_OPCODES.CLOSE, payload.subarray(0, Math.min(payload.length, 125)));
          try { this.socket.end(); } catch {}
        }
        this.closed = true;
        this.emit('close', { code: closeCode, reason: closeReason });
        return;
      }

      if (opcode === WS_OPCODES.CONTINUATION) {
        if (this._fragOpcode === null) { this._failProtocol(1002, 'unexpected_continuation'); return; }
        this._fragBytes += payload.length;
        if (this._fragBytes > this.maxMessageBytes) { this._failProtocol(1009, 'message_too_large'); return; }
        this._fragChunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this._fragChunks);
          const msgOpcode = this._fragOpcode;
          this._fragOpcode = null;
          this._fragChunks = [];
          this._fragBytes = 0;
          this._dispatchMessage(msgOpcode, full);
        }
        continue;
      }

      if (opcode !== WS_OPCODES.TEXT && opcode !== WS_OPCODES.BINARY) {
        this._failProtocol(1002, 'unsupported_opcode');
        return;
      }
      if (this._fragOpcode !== null) {
        this._failProtocol(1002, 'interleaved_data_frame');
        return;
      }
      if (fin) {
        this._dispatchMessage(opcode, payload);
      } else {
        this._fragOpcode = opcode;
        this._fragChunks = [payload];
        this._fragBytes = payload.length;
      }
    }
  }

  _dispatchMessage(opcode, payload) {
    if (opcode === WS_OPCODES.TEXT) {
      this.emit('text', payload.toString('utf8'));
    } else {
      this.emit('binary', payload);
    }
  }
}

export function upgradeHttpToWs(req, socket, head, options = {}) {
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const version = String(req.headers['sec-websocket-version'] || '');
  const key = req.headers['sec-websocket-key'];
  if (upgrade !== 'websocket' || version !== '13' || typeof key !== 'string' || !key.trim()) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = wsAcceptKey(key.trim());
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n`
    + '\r\n',
  );
  try { socket.setNoDelay?.(true); } catch {}
  return new WsConnection(socket, {
    isServer: true,
    maxMessageBytes: options.maxMessageBytes ?? DEFAULT_MAX_WS_MESSAGE_BYTES,
    initialData: head,
  });
}

export function connectWs({ socketPath, baseUrl, path = '/v1/ws', token = null, timeoutMs = 10_000, maxMessageBytes = DEFAULT_MAX_WS_MESSAGE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString('base64');
    const expectedAccept = wsAcceptKey(key);
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    };

    let req;
    if (socketPath) {
      req = http.request({ socketPath, path, method: 'GET', headers });
    } else if (baseUrl) {
      const target = new URL(path, baseUrl);
      const transport = target.protocol === 'https:' ? https : http;
      req = transport.request(target, { method: 'GET', headers });
    } else {
      reject(Object.assign(new Error('ws_target_missing'), { code: 'ws_target_missing' }));
      return;
    }

    let settled = false;
    const finish = (err, conn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(conn);
    };
    const timer = timeoutMs > 0 ? setTimeout(() => {
      req.destroy(Object.assign(new Error('ws_connect_timeout'), { code: 'ETIMEDOUT' }));
    }, timeoutMs) : null;
    timer?.unref?.();

    req.on('upgrade', (res, socket, head) => {
      const accept = String(res.headers['sec-websocket-accept'] || '');
      if (accept !== expectedAccept) {
        socket.destroy();
        finish(Object.assign(new Error('ws_invalid_accept'), { code: 'ws_invalid_accept' }));
        return;
      }
      try { socket.setNoDelay?.(true); } catch {}
      finish(null, new WsConnection(socket, { isServer: false, maxMessageBytes, initialData: head }));
    });
    req.on('response', res => {
      res.resume();
      finish(Object.assign(new Error(`ws_upgrade_rejected_${res.statusCode}`), {
        code: res.statusCode === 401 ? 'unauthorized' : 'ws_upgrade_rejected',
        status: res.statusCode,
      }));
    });
    req.on('error', err => finish(err));
    req.end();
  });
}
