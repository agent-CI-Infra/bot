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

/** A publication can also register its freshly issued tokens. Its deployment-wide set stays in the control plane. */
export function registeredRedactor(store: Store, redactor = new Redactor()) {
  for (const value of configuredRedactor(store).values) redactor.add(value);
  return redactor;
}
