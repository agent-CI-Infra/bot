import { createPrivateKey, createPublicKey, randomBytes, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';

export const NODE_AGENT_PROTOCOL_VERSION = 1;
export const NODE_AGENT_MIN_PROTOCOL_VERSION = 1;
export const NODE_AGENT_MAX_PROTOCOL_VERSION = 1;

export const NODE_PAIRING_TOKEN_PREFIX = 'bnode_';
export const NODE_SESSION_TOKEN_PREFIX = 'bnsess_';

export const DEFAULT_NODE_LONG_POLL_MS = 25_000;
export const MAX_NODE_LONG_POLL_MS = 25_000;
export const DEFAULT_NODE_HEARTBEAT_MS = 10_000;
export const DEFAULT_NODE_OFFLINE_AFTER_MS = 35_000;
export const DEFAULT_NODE_SESSION_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_NODE_PAIRING_TTL_MS = 60 * 60 * 1000;
export const MAX_NODE_CONTROL_FRAME_BYTES = 16 * 1024 * 1024;
export const NODE_RESULT_CHUNK_BYTES = 512 * 1024;

export const NODE_DRIVERS = Object.freeze(['docker', 'host']);
export const NODE_STATUSES = Object.freeze(['pending', 'online', 'draining', 'offline', 'revoked']);
export const BINDING_STATES = Object.freeze(['bound', 'active', 'draining', 'offline', 'rebinding']);

const NODE_ID_RE = /^(?:local|[a-z0-9][a-z0-9._-]{1,63})$/;
const LABEL_KEY_RE = /^[a-z0-9][a-z0-9._/-]{0,62}$/i;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function normalizeNodeArch(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'x64' || value === 'x86_64' || value === 'amd64') return 'amd64';
  if (value === 'arm64' || value === 'aarch64') return 'arm64';
  if (/^[a-z0-9._-]{1,32}$/.test(value)) return value;
  return 'unknown';
}

export function normalizeNodeOs(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'linux' || value === 'darwin' || value === 'win32' || value === 'windows') {
    return value === 'win32' ? 'windows' : value;
  }
  if (/^[a-z0-9._-]{1,32}$/.test(value)) return value;
  return 'linux';
}

export function isValidNodeId(id) {
  return typeof id === 'string' && NODE_ID_RE.test(id);
}

export function isValidNodeDriver(driver) {
  return typeof driver === 'string' && NODE_DRIVERS.includes(driver);
}

export function normalizeNodeLabels(input) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('invalid_node_labels'), { status: 400, code: 'invalid_node_labels' });
  }
  const entries = Object.entries(input);
  if (entries.length > 32) {
    throw Object.assign(new Error('invalid_node_labels'), { status: 400, code: 'invalid_node_labels' });
  }
  const out = {};
  for (const [rawKey, rawVal] of entries) {
    const key = String(rawKey).trim();
    const val = String(rawVal ?? '').trim();
    if (!LABEL_KEY_RE.test(key) || !val || val.length > 128 || CONTROL_CHAR_RE.test(val)) {
      throw Object.assign(new Error('invalid_node_labels'), { status: 400, code: 'invalid_node_labels' });
    }
    out[key] = val;
  }
  return out;
}

export function parseLabelsText(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  const out = {};
  for (const part of text.split(/[\s,]+/).filter(Boolean)) {
    const idx = part.indexOf('=');
    if (idx <= 0 || idx === part.length - 1) {
      throw Object.assign(new Error('invalid_node_labels'), { status: 400, code: 'invalid_node_labels' });
    }
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = val;
  }
  return normalizeNodeLabels(out);
}

/**
 * Negotiates protocol compatibility between control plane and a remote node-agent.
 * Returns a clear human-readable incompatibility message on version skew so rolling upgrades fail loudly.
 */
export function checkProtocolCompatibility(
  agentVersion,
  agentMinVersion = agentVersion,
  {
    centerVersion = NODE_AGENT_PROTOCOL_VERSION,
    centerMin = NODE_AGENT_MIN_PROTOCOL_VERSION,
    centerMax = NODE_AGENT_MAX_PROTOCOL_VERSION,
  } = {},
) {
  const v = Number(agentVersion);
  const minV = Number(agentMinVersion ?? v);
  if (!Number.isSafeInteger(v) || v < 1 || !Number.isSafeInteger(minV) || minV < 1 || minV > v) {
    return {
      compatible: false,
      code: 'node_protocol_incompatible',
      detail: `Invalid node-agent protocol version (${String(agentVersion)}). Control plane supports protocol v${centerMin}..v${centerMax}.`,
      center_protocol_version: centerVersion,
      supported_range: [centerMin, centerMax],
      agent_protocol_version: Number.isSafeInteger(v) ? v : null,
    };
  }
  if (v < centerMin) {
    return {
      compatible: false,
      code: 'node_protocol_incompatible',
      detail: `Node agent protocol v${v} is too old for control plane protocol v${centerVersion} (supported v${centerMin}..v${centerMax}). Upgrade the node-agent image (BOT_IMAGE_TAG) to match the control plane.`,
      center_protocol_version: centerVersion,
      supported_range: [centerMin, centerMax],
      agent_protocol_version: v,
    };
  }
  if (minV > centerMax || v > centerMax) {
    return {
      compatible: false,
      code: 'node_protocol_incompatible',
      detail: `Node agent protocol v${v} (min v${minV}) is newer than control plane protocol v${centerVersion} (supported v${centerMin}..v${centerMax}). Upgrade the control plane before upgrading node-agent.`,
      center_protocol_version: centerVersion,
      supported_range: [centerMin, centerMax],
      agent_protocol_version: v,
    };
  }
  return {
    compatible: true,
    negotiated_version: Math.min(v, centerVersion),
    center_protocol_version: centerVersion,
    supported_range: [centerMin, centerMax],
    agent_protocol_version: v,
  };
}

export function validateEd25519PublicKey(pem) {
  if (typeof pem !== 'string' || !pem.trim().startsWith('-----BEGIN PUBLIC KEY-----') || pem.includes('PRIVATE KEY') || pem.length > 4096) {
    throw Object.assign(new Error('invalid_node_public_key'), { status: 400, code: 'invalid_node_public_key' });
  }
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'ed25519') {
      throw Object.assign(new Error('invalid_node_public_key'), { status: 400, code: 'invalid_node_public_key' });
    }
    return key.export({ type: 'spki', format: 'pem' }).toString();
  } catch (err) {
    if (err?.code === 'invalid_node_public_key') throw err;
    throw Object.assign(new Error('invalid_node_public_key'), { status: 400, code: 'invalid_node_public_key' });
  }
}

export function signNodeAssertion(nodeId, privateKeyPem, { timestampMs = Date.now(), nonce = randomBytes(18).toString('base64url') } = {}) {
  const payload = `bot.node-auth/1\n${nodeId}\n${timestampMs}\n${nonce}`;
  const key = createPrivateKey(privateKeyPem);
  const sig = cryptoSign(null, Buffer.from(payload, 'utf8'), key).toString('base64url');
  return {
    node_id: nodeId,
    timestamp_ms: timestampMs,
    nonce,
    signature: sig,
  };
}

export function verifyNodeAssertion(nodeId, publicKeyPem, assertion, { nowMs = Date.now(), maxSkewMs = 120_000 } = {}) {
  if (!assertion || typeof assertion !== 'object') return false;
  if (assertion.node_id !== nodeId) return false;
  const ts = Number(assertion.timestamp_ms);
  const nonce = String(assertion.nonce || '');
  const sig = String(assertion.signature || '');
  if (!Number.isSafeInteger(ts) || Math.abs(nowMs - ts) > maxSkewMs) return false;
  if (!NONCE_RE.test(nonce) || !sig || sig.length > 512) return false;
  try {
    const payload = `bot.node-auth/1\n${nodeId}\n${ts}\n${nonce}`;
    const key = createPublicKey(publicKeyPem);
    return cryptoVerify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(sig, 'base64url'));
  } catch {
    return false;
  }
}
