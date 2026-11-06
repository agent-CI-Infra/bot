import { type Row } from '../storage/database.js';
import { fail } from '../core/security.js';

// Apply presentation filters after authorization, before grouping the current page in the console.
// Calls without pagination parameters retain the complete list used by other console views.
export function projectListPage<T extends Row>(rows: T[], url: URL): T[] {
  for (const [key, column] of [['repository_id', 'id'], ['account_id', 'account_id'], ['owner_id', 'owner_id']] as const) {
    const value = url.searchParams.get(key);
    if (value) rows = rows.filter(row => String(row[column]) === value);
  }
  if (!url.searchParams.has('limit') && !url.searchParams.has('offset')) return rows;
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
  if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset)) fail(400, 'invalid_pagination');
  return rows.slice(offset, offset + limit);
}
