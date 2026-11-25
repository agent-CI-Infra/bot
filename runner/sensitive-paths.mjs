import { posix } from 'node:path';

export const SENSITIVE_BASENAMES = new Set([
  '.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_xmss',
  '.netrc',
  'netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.my.cnf',
  '.git-credentials',
  '.dockerconfigjson',
  'master.key',
  'manager.token',
  'credentials.json',
  '.credentials.json',
  'auth.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'service-account.json',
  'kubeconfig',
  'shadow',
  'gshadow',
  '.htpasswd',
]);

export const SENSITIVE_EXTENSIONS = /\.(?:pem|key|p12|pfx|jks|keystore|ppk|kdbx|ovpn|pkcs12)$/i;

export const SENSITIVE_PATH_PATTERNS = [
  /(?:^|\/)\.aws\/(?:credentials|config)$/i,
  /(?:^|\/)\.ssh\/id_[^/]+$/i,
  /(?:^|\/)\.kube\/config$/i,
  /(?:^|\/)\.docker\/config\.json$/i,
  /(?:^|\/)\.claude\/\.credentials\.json$/i,
  /(?:^|\/)\.codex\/auth\.json$/i,
];

export const SENSITIVE_MEMORY_PATH_RE =
  /(^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.ssh|\.aws|credentials(?:\.(?!ts$|tsx$|js$|mjs$|cjs$|jsx$|py$|md$|mdx$|html$|css$|scss$|vue$|svelte$|rs$|go$|java$|kt$|rb$|php$|sh$)[^/]*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key))(?:\/|$)/i;

/**
 * Fail-closed filename/path check for common credential and key files in project tool archives.
 * Benign template suffixes (`.env.example`, `.env.sample`, `.env.template`) and SSH public keys (`id_*.pub`)
 * are allowlisted ONLY as exact suffixes for tool archives.
 */
export function isSensitiveToolPath(relPath) {
  if (typeof relPath !== 'string') return null;
  const lower = relPath.toLowerCase();
  const base = posix.basename(lower);
  if (SENSITIVE_BASENAMES.has(base)) return `sensitive_filename:${base}`;
  if (/^\.env\./.test(base) && !/^\.env\.(?:example|sample|template)$/.test(base)) return `sensitive_filename:${base}`;
  if (/^id_(?:rsa|dsa|ecdsa|ed25519|xmss)\./.test(base) && !/^id_(?:rsa|dsa|ecdsa|ed25519|xmss)\.pub$/.test(base)) {
    return `sensitive_filename:${base}`;
  }
  if (SENSITIVE_EXTENSIONS.test(base)) return `sensitive_extension:${base}`;
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(lower)) return `sensitive_path:${relPath}`;
  }
  return null;
}

/**
 * Single authoritative sensitive-path predicate shared by both control-plane `FileSyncEngine`
 * (`src/sync/paths.ts`) and pure-Node `SyncClient` (`runner/sync-client.mjs`).
 */
export function isSensitiveSyncPath(relPath) {
  if (typeof relPath !== 'string') return false;
  return isSensitiveToolPath(relPath) !== null || SENSITIVE_MEMORY_PATH_RE.test(relPath);
}
