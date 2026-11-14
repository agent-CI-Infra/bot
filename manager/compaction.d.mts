import type { DatabaseSync } from 'node:sqlite';
export interface DatabasePages { page_size: number; pages: number; free_pages: number; bytes: number; free_bytes: number; live_bytes: number; auto_vacuum: number }
export interface CompactionResult { action: 'compacted' | 'skipped' | 'not_needed' | 'failed'; at: string; duration_ms: number; reason?: string; detail?: string;
  before?: DatabasePages; after_bytes?: number; freed_bytes?: number; disk_free_bytes?: number; required_bytes?: number }
export const compactionDefaults: { minFreeRatio: number; minFreeBytes: number; progressMs: number };
export function databasePages(db: DatabaseSync): DatabasePages;
export function requiredBytes(live: number): number;
export function compactDatabase(path: string, options?: { minFreeRatio?: number; minFreeBytes?: number; progressMs?: number; log?: (line: string) => void; diskFree?: (directory: string) => Promise<number> }): Promise<CompactionResult>;
export class IncrementalVacuum {
  constructor(db: DatabaseSync, options?: { step?: number; minPages?: number; pauseMs?: number; intervalMs?: number });
  start(): void;
  stop(): Promise<void>;
  run(): Promise<number>;
  state(): { auto_vacuum: number; last: { started_at: string; finished_at: string; pages: number; bytes: number } | null };
}
