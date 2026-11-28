import { createHash } from 'node:crypto';
import type { Store } from '../storage/database.js';
import { Redactor } from '../../runner/credential-redaction.mjs';

export { githubTokenSource, publicText, publicContent } from '../../runner/credential-redaction.mjs';

const fields: Record<string, string[]> = {
  account: ['token', 'private_key', 'webhook_secret', 'oauth_client_secret'],
  model: ['value'], endpoint: ['value'],
  'ssh-target': ['password', 'private_key'],
  'channel-credential': ['app_secret', 'verification_token', 'encrypt_key', 'app_ticket']
};
// One entry per project (and '' for deployment-wide callers): a project's SSH secrets make its row set differ, and
// callers with and without a project alternate on the trace path, so one shared entry would be rebuilt every time.
const cache = new WeakMap<Store, Map<string, { revision: string; redactor: Redactor; fingerprint: string }>>();
const cachedProjects = 256;
// Bump if built-in public-board redaction rules change so unchanged historical shards re-redact once.
const redactionFingerprintVersion = 'public-board-redaction:v1';

function loadConfiguredRedactor(store: Store, project: string | null = null) {
  const rows = store.all(`SELECT 'account' AS kind,id,credentials AS sealed FROM accounts WHERE credentials!='{}'
    UNION ALL SELECT 'model',id,api_key FROM models WHERE api_key IS NOT NULL
    UNION ALL SELECT 'endpoint',id,secret FROM endpoints
    UNION ALL SELECT 'ssh-target',id,sealed FROM ssh_targets WHERE owner_project=? OR id IN
        (SELECT target_id FROM ssh_target_projects WHERE repository_id=?)
    UNION ALL SELECT 'channel-credential',id,sealed FROM channel_credentials`,project,project);
  const revision = JSON.stringify(rows), entries = cache.get(store) ?? new Map(), key = project ?? '', current = entries.get(key);
  if (!cache.has(store)) cache.set(store, entries);
  if (current?.revision === revision) return current;
  const redactor = new Redactor();
  for (const row of rows) {
    const credential = store.secrets.open(row.sealed, row.kind + ':' + row.id);
    for (const field of fields[row.kind]!) {
      if (row.kind === 'ssh-target') redactor.addExact(credential[field]);
      else redactor.add(credential[field]);
    }
  }
  const hash = createHash('sha256').update(redactionFingerprintVersion);
  for (const value of [...redactor.values].sort()) hash.update('\0').update(value);
  const entry = { revision, redactor, fingerprint: hash.digest('hex') };
  entries.delete(key); entries.set(key, entry);
  if (entries.size > cachedProjects) entries.delete(entries.keys().next().value!);
  return entry;
}

// Rotations, deletions and rolled-back updates must take effect immediately. Reuse the compiled
// literals while the sealed rows are unchanged, including on the trace and message-history paths.
export function configuredRedactor(store: Store, project: string | null = null): Pick<Redactor, 'clean' | 'text' | 'values' | 'publicationPattern'> {
  return loadConfiguredRedactor(store, project).redactor;
}

/** One-way SHA-256 digest of the active registered credential set; changes whenever any credential is added, rotated or removed. */
export function configuredRedactorFingerprint(store: Store, project: string | null = null): string {
  return loadConfiguredRedactor(store, project).fingerprint;
}

// A delivery body and a management receipt reach the console, and the same accepted body leaves the control plane
// towards an external subscriber. A credential in either copy must not leave the server, so every exit shares one rule.
// A key whose name is exactly one of these loses its value at every depth, in objects and in array elements; nothing is
// inferred from a value's shape, so a field this list does not name is returned exactly as it was stored.
export const credentialKey = /^(?:token|secret|password|authorization|cookie|private_key)$/i;
export function redactEgress(value: any): any {
  if (Array.isArray(value)) return value.map(redactEgress);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, credentialKey.test(key) ? '[redacted]' : redactEgress(item)]));
  return value;
}

/** A publication can also register its freshly issued tokens. Its deployment-wide set stays in the control plane. */
export function registeredRedactor(store: Store, redactor = new Redactor()) {
  for (const value of configuredRedactor(store).values) redactor.addExact(value);
  return redactor;
}
