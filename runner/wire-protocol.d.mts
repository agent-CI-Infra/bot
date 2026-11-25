import type { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export const RUNNER_PROTOCOL_VERSION: number;
export const DEFAULT_RUNNER_SOCKET_DIR: string;
export const DEFAULT_RUNNER_SOCKET_PATH: string;
export const DEFAULT_RUNNER_TOKEN_FILE: string;
export const DEFAULT_MAX_WS_MESSAGE_BYTES: number;
export const DEFAULT_COMMAND_HEARTBEAT_MS: number;
export const DEFAULT_LONG_POLL_WAIT_MS: number;

export const WS_OPCODES: Readonly<{
  CONTINUATION: number;
  TEXT: number;
  BINARY: number;
  CLOSE: number;
  PING: number;
  PONG: number;
}>;

export function wsAcceptKey(key: string): string;
export function bearerTokenMatches(authorizationHeader: string | undefined, expectedToken: string): boolean;
export function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<Record<string, any>>;
export function encodeWsFrame(
  opcode: number,
  payload?: Buffer | string,
  options?: { mask?: boolean; fin?: boolean },
): Buffer;

export class WsConnection extends EventEmitter {
  socket: Duplex;
  isServer: boolean;
  maxMessageBytes: number;
  closed: boolean;
  closeSent: boolean;
  constructor(
    socket: Duplex,
    options?: { isServer?: boolean; maxMessageBytes?: number; initialData?: Buffer | null },
  );
  readonly open: boolean;
  sendText(text: string): boolean;
  sendJson(value: unknown): boolean;
  sendBinary(buffer: Buffer | Uint8Array): boolean;
  ping(payload?: Buffer): boolean;
  pong(payload?: Buffer): boolean;
  close(code?: number, reason?: string): void;
  destroy(): void;
}

export function upgradeHttpToWs(
  req: IncomingMessage,
  socket: Duplex,
  head?: Buffer,
  options?: { maxMessageBytes?: number },
): WsConnection | null;

export function connectWs(options?: {
  socketPath?: string | null;
  baseUrl?: string | null;
  path?: string;
  token?: string | null;
  timeoutMs?: number;
  maxMessageBytes?: number;
}): Promise<WsConnection>;
