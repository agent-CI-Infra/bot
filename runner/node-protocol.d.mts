export const NODE_AGENT_PROTOCOL_VERSION: number;
export const NODE_AGENT_MIN_PROTOCOL_VERSION: number;
export const NODE_AGENT_MAX_PROTOCOL_VERSION: number;

export const NODE_PAIRING_TOKEN_PREFIX: 'bnode_';
export const NODE_SESSION_TOKEN_PREFIX: 'bnsess_';

export const DEFAULT_NODE_LONG_POLL_MS: number;
export const MAX_NODE_LONG_POLL_MS: number;
export const DEFAULT_NODE_HEARTBEAT_MS: number;
export const DEFAULT_NODE_OFFLINE_AFTER_MS: number;
export const DEFAULT_NODE_SESSION_TTL_MS: number;
export const DEFAULT_NODE_PAIRING_TTL_MS: number;
export const MAX_NODE_CONTROL_FRAME_BYTES: number;
export const NODE_RESULT_CHUNK_BYTES: number;

export type NodeDriver = 'docker' | 'host';
export type NodeStatus = 'pending' | 'online' | 'draining' | 'offline' | 'revoked';
export type BindingState = 'bound' | 'active' | 'draining' | 'offline' | 'rebinding';

export const NODE_DRIVERS: readonly NodeDriver[];
export const NODE_STATUSES: readonly NodeStatus[];
export const BINDING_STATES: readonly BindingState[];

export function normalizeNodeArch(raw: unknown): string;
export function normalizeNodeOs(raw: unknown): string;
export function isValidNodeId(id: unknown): id is string;
export function isValidNodeDriver(driver: unknown): driver is NodeDriver;
export function normalizeNodeLabels(input: unknown): Record<string, string>;
export function parseLabelsText(raw: unknown): Record<string, string>;

export interface ProtocolCheckResult {
  compatible: boolean;
  code?: 'node_protocol_incompatible';
  detail?: string;
  negotiated_version?: number;
  center_protocol_version: number;
  supported_range: [number, number];
  agent_protocol_version: number | null;
}

export function checkProtocolCompatibility(
  agentVersion: unknown,
  agentMinVersion?: unknown,
  options?: {
    centerVersion?: number;
    centerMin?: number;
    centerMax?: number;
  },
): ProtocolCheckResult;

export function validateEd25519PublicKey(pem: unknown): string;

export interface NodeAuthAssertion {
  node_id: string;
  timestamp_ms: number;
  nonce: string;
  signature: string;
}

export function signNodeAssertion(
  nodeId: string,
  privateKeyPem: string,
  options?: { timestampMs?: number; nonce?: string },
): NodeAuthAssertion;

export function verifyNodeAssertion(
  nodeId: string,
  publicKeyPem: string,
  assertion: unknown,
  options?: { nowMs?: number; maxSkewMs?: number },
): boolean;
