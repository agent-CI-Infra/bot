import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { copyFile, link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { Redactor, publicContent } from '../../runner/credential-redaction.mjs';

// Retired outputs from the removed gate and E2E views (#938) are dropped when inheriting an older snapshot.
export const RETIRED_PREV_PATHS = ['gate.json', 'board/e2e', 'board/data/e2e'] as const;

export interface FinalizeBoardStagingInput {
  stagingDir: string;
  prevDir?: string;
  /** In-process registered credential values (never written to disk or logged). */
  redactorValues: string[];
  /** True on first collection or whenever the deployment credential fingerprint changed. */
  fullRedaction: boolean;
  skipPrevPaths?: readonly string[];
}

export interface FinalizeBoardStagingResult {
  snapshotRepoName: string | null;
  redactedFiles: number;
  reusedFiles: number;
  rewrittenFiles: number;
}

const linkFallbackCodes = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'ENOSYS', 'EMLINK']);

async function linkOrCopy(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  try {
    await link(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code && linkFallbackCodes.has(code)) await copyFile(source, target);
    else throw error;
  }
}

async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Math.random().toString(16).slice(2, 10)}.tmp`;
  try {
    await writeFile(temp, content, 'utf8');
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

function isSkipped(rel: string, skipSet: Set<string>): boolean {
  return skipSet.has(rel);
}

/**
 * Redacts newly written JSON files in `stagingDir`, merges unchanged files from `prevDir` via hard links
 * (re-redacting historical JSON files only when `fullRedaction` is true), and extracts the repository name
 * from `board/data/snapshot.json` without touching the control-plane main event loop.
 */
export async function finalizeBoardStaging(input: FinalizeBoardStagingInput): Promise<FinalizeBoardStagingResult> {
  const redactor = new Redactor();
  for (const value of input.redactorValues) redactor.addExact(value);
  const written = new Set<string>();
  let snapshotRepoName: string | null | undefined;
  let redactedFiles = 0, reusedFiles = 0, rewrittenFiles = 0;

  async function redactJson(sourcePath: string, targetPath: string, rel: string, sameFile: boolean): Promise<void> {
    const raw = await readFile(sourcePath, 'utf8');
    // JSON escaping on disk must not hide newlines or quotes inside a registered value.
    const original = JSON.parse(raw);
    const cleaned = publicContent(original, redactor);
    const safe = JSON.stringify(cleaned);
    const changed = safe !== JSON.stringify(original);
    redactedFiles++;
    if (rel === 'board/data/snapshot.json') {
      snapshotRepoName = cleaned?.repository?.name != null ? String(cleaned.repository.name) : null;
    }
    if (changed) {
      await writeAtomic(targetPath, safe);
      rewrittenFiles++;
    } else if (!sameFile) {
      await linkOrCopy(sourcePath, targetPath);
      reusedFiles++;
    }
  }

  async function walkStaging(dir: string, prefix: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkStaging(fullPath, rel);
      } else if (entry.isFile()) {
        written.add(rel);
        if (entry.name.endsWith('.json')) await redactJson(fullPath, fullPath, rel, true);
      }
    }
  }

  await walkStaging(input.stagingDir, '');

  if (input.prevDir) {
    const skipSet = new Set(input.skipPrevPaths ?? RETIRED_PREV_PATHS);
    const walkPrev = async (dir: string, prefix: string): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
        if (isSkipped(rel, skipSet)) continue;
        const prevPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walkPrev(prevPath, rel);
        } else if (entry.isFile()) {
          if (written.has(rel)) continue;
          const targetPath = join(input.stagingDir, ...rel.split('/'));
          if (input.fullRedaction && entry.name.endsWith('.json')) {
            await redactJson(prevPath, targetPath, rel, false);
          } else {
            await linkOrCopy(prevPath, targetPath);
            reusedFiles++;
          }
        }
      }
    };
    await walkPrev(input.prevDir, '');
  }

  if (snapshotRepoName === undefined) {
    const snapshot = JSON.parse(await readFile(join(input.stagingDir, 'board/data/snapshot.json'), 'utf8'));
    snapshotRepoName = snapshot?.repository?.name != null ? String(snapshot.repository.name) : null;
  }

  return { snapshotRepoName, redactedFiles, reusedFiles, rewrittenFiles };
}

export function runFinalizeBoardStagingWorker(input: FinalizeBoardStagingInput): Promise<FinalizeBoardStagingResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = new Worker(new URL('./redaction-worker.js', import.meta.url), { workerData: input });
    let settled = false;
    worker.once('message', (message: { ok: true; result: FinalizeBoardStagingResult } | { ok: false; error: string }) => {
      settled = true;
      if (message.ok) resolvePromise(message.result);
      else rejectPromise(new Error(message.error || 'board_redaction_failed'));
    });
    worker.once('error', error => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    });
    worker.once('exit', code => {
      if (settled) return;
      settled = true;
      rejectPromise(new Error(`board redaction worker exited with code ${code}`));
    });
  });
}

if (!isMainThread && parentPort && workerData && typeof workerData === 'object' && 'stagingDir' in workerData) {
  finalizeBoardStaging(workerData as FinalizeBoardStagingInput).then(
    result => parentPort!.postMessage({ ok: true, result }),
    error => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : 'board_redaction_failed' }),
  );
}
