import { fail } from '../core/security.js';
import { memoryAudience } from './access.js';

export function knowledgePath(path: unknown): void {
  if (typeof path !== 'string' || !path || path.length > 500 || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(p => p === '..' || p === '.')) return fail(400, 'invalid_memory_path');
  if (/(^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.ssh|\.aws|credentials(?:\.[^/]*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key))(?:\/|$)/i.test(path)) fail(400, 'memory_sensitive_path');
}
export function memoryCatalog(data: any, key: string): any {
  return { title:key, tags:[], aliases:[], path:data.document?.path ?? null, module:data.scope?.module ?? null,
    owner:data.owner ?? null, category:data.kind, audience:memoryAudience(data), reviewed_at:null, review_due_at:null, ...data.catalog };
}
/** Only directory fields are client editable; review time comes from the evidence-backed review operation. */
export function validateCatalog(catalog: any, patch: any): void {
  const editable = ['title','tags','aliases','path','module','owner','audience','category','review_due_at'];
  if (patch !== undefined && (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !editable.includes(k)))) fail(400, 'invalid_memory_catalog');
  if (typeof catalog.title !== 'string' || !catalog.title.trim() || catalog.title.length > 200 || catalog.title.includes('\0') ||
      catalog.audience !== 'project' && !/^role:[a-z][a-z0-9_-]{0,63}$/.test(catalog.audience) ||
      ['tags','aliases'].some(k => !Array.isArray(catalog[k]) || catalog[k].length > 30 || catalog[k].some((v:any) => typeof v !== 'string' || !v.trim() || v.length > 120 || v.includes('\0'))) ||
      ['path','module','owner','category'].some(k => catalog[k] !== null && (typeof catalog[k] !== 'string' || catalog[k].length > 500)) ||
      catalog.review_due_at !== null && (typeof catalog.review_due_at !== 'string' || !Number.isFinite(Date.parse(catalog.review_due_at)))) fail(400, 'invalid_memory_catalog');
  if (catalog.path !== null) knowledgePath(catalog.path);
}
