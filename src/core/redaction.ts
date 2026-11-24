import type { Store } from '../storage/database.js';
import { Redactor } from '../../runner/credential-redaction.mjs';

export { githubTokenSource, publicText, publicContent } from '../../runner/credential-redaction.mjs';

const fields: Record<string, string[]> = {
  account: ['token', 'private_key', 'webhook_secret', 'oauth_client_secret'],
  model: ['value'], endpoint: ['value'],
  'channel-credential': ['app_secret', 'verification_token', 'encrypt_key', 'app_ticket']
};
const cache = new WeakMap<Store, { revision: string; redactor: Redactor }>();

// Rotations, deletions and rolled-back updates must take effect immediately. Reuse the compiled
// literals while the sealed rows are unchanged, including on the trace and message-history paths.
export function configuredRedactor(store: Store): Pick<Redactor, 'clean' | 'text' | 'values' | 'publicationPattern'> {
  const rows = store.all(`SELECT 'account' AS kind,id,credentials AS sealed FROM accounts WHERE credentials!='{}'
    UNION ALL SELECT 'model',id,api_key FROM models WHERE api_key IS NOT NULL
    UNION ALL SELECT 'endpoint',id,secret FROM endpoints
    UNION ALL SELECT 'channel-credential',id,sealed FROM channel_credentials`);
  const revision = JSON.stringify(rows), current = cache.get(store);
  if (current?.revision === revision) return current.redactor;
  const redactor = new Redactor();
  for (const row of rows) {
    const credential = store.secrets.open(row.sealed, row.kind + ':' + row.id);
    for (const field of fields[row.kind]!) redactor.add(credential[field]);
  }
  cache.set(store,{revision,redactor});
  return redactor;
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
  for (const value of configuredRedactor(store).values) redactor.add(value);
  return redactor;
}
