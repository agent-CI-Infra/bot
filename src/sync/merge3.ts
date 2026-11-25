import { isUtf8 } from 'node:buffer';
import type { MergeConflictHunk } from './types.js';

export interface LineEdit {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

export interface Merge3TextResult {
  merged: string;
  conflict: boolean;
  hunks: MergeConflictHunk[];
  conflictMarkers: string | null;
}

export interface Merge3BufferResult {
  merged: Buffer | null;
  conflict: boolean;
  binary: boolean;
  reason: string | null;
  hunks: MergeConflictHunk[];
  conflictMarkers: string | null;
}

export function isBinaryBuffer(buf: Buffer): boolean {
  return !isUtf8(buf) || buf.includes(0);
}

/**
 * Splits UTF-8 text into lines while preserving each line's exact terminator (`\n`, `\r\n`, or none on EOF).
 * `splitLines(text).join('') === text` always holds.
 */
export function splitLinesPreserve(text: string): string[] {
  if (!text) return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Myers O((N+M)D) shortest edit script on line arrays, producing contiguous edit hunks
 * anchored to ranges `[baseStart, baseEnd)` of `base`.
 */
export function diffLines(base: readonly string[], target: readonly string[]): LineEdit[] {
  // Trim common prefix & suffix first so large files with localized edits execute in microseconds.
  let prefix = 0;
  const minLen = Math.min(base.length, target.length);
  while (prefix < minLen && base[prefix] === target[prefix]) prefix++;

  let baseEnd = base.length;
  let targetEnd = target.length;
  while (baseEnd > prefix && targetEnd > prefix && base[baseEnd - 1] === target[targetEnd - 1]) {
    baseEnd--;
    targetEnd--;
  }

  const a = base.slice(prefix, baseEnd);
  const b = target.slice(prefix, targetEnd);
  const n = a.length;
  const m = b.length;

  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ baseStart: prefix, baseEnd: prefix, lines: b }];
  if (m === 0) return [{ baseStart: prefix, baseEnd: baseEnd, lines: [] }];

  const max = n + m;
  // Bound trace memory for pathological completely-rewritten giant files by falling back to a single replacement hunk.
  if (max > 16_000) {
    return [{ baseStart: prefix, baseEnd, lines: b }];
  }

  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];
  let foundD = -1;

  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) {
        x = v[offset + k + 1]!;
      } else {
        x = v[offset + k - 1]! + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        foundD = d;
        break;
      }
    }
    if (foundD >= 0) break;
  }

  // Backtrack edit operations: 'eq' | 'del' | 'ins'
  const ops: ('eq' | 'del' | 'ins')[] = [];
  let x = n;
  let y = m;
  for (let d = foundD; d > 0; d--) {
    const prevV = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && prevV[offset + k - 1]! < prevV[offset + k + 1]!)) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = prevV[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('eq');
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push('ins');
      y--;
    } else {
      ops.push('del');
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push('eq');
    x--;
    y--;
  }
  ops.reverse();

  const edits: LineEdit[] = [];
  let ai = 0;
  let bi = 0;
  let curStart = -1;
  let curLines: string[] = [];

  for (const op of ops) {
    if (op === 'eq') {
      if (curStart >= 0) {
        edits.push({ baseStart: prefix + curStart, baseEnd: prefix + ai, lines: curLines });
        curStart = -1;
        curLines = [];
      }
      ai++;
      bi++;
    } else {
      if (curStart < 0) curStart = ai;
      if (op === 'del') {
        ai++;
      } else {
        curLines.push(b[bi]!);
        bi++;
      }
    }
  }
  if (curStart >= 0) {
    edits.push({ baseStart: prefix + curStart, baseEnd: prefix + ai, lines: curLines });
  }
  return edits;
}

function editsConflict(a: LineEdit, b: LineEdit): boolean {
  const aIns = a.baseStart === a.baseEnd;
  const bIns = b.baseStart === b.baseEnd;
  if (aIns && bIns) return a.baseStart === b.baseStart;
  if (aIns) return b.baseStart < a.baseStart && a.baseStart < b.baseEnd;
  if (bIns) return a.baseStart < b.baseStart && b.baseStart < a.baseEnd;
  return Math.max(a.baseStart, b.baseStart) < Math.min(a.baseEnd, b.baseEnd);
}

function applyEditsToSpan(
  base: readonly string[],
  spanStart: number,
  spanEnd: number,
  edits: readonly LineEdit[],
): string[] {
  const out: string[] = [];
  let cursor = spanStart;
  for (const edit of edits) {
    if (edit.baseStart > cursor) {
      out.push(...base.slice(cursor, edit.baseStart));
    }
    out.push(...edit.lines);
    cursor = edit.baseEnd;
  }
  if (cursor < spanEnd) {
    out.push(...base.slice(cursor, spanEnd));
  }
  return out;
}

function ensureTrailingNewline(text: string): string {
  return text && !text.endsWith('\n') ? `${text}\n` : text;
}

/**
 * Pure-text line-level three-way merge (base + current + local).
 * - Disjoint line edits merge cleanly without conflict.
 * - Identical edits on the same span converge cleanly.
 * - True same-line / overlapping / same-point insertion conflicts return conflict hunks and diff3 markers.
 */
export function merge3WayText(base: string, current: string, local: string): Merge3TextResult {
  if (current === local) {
    return { merged: current, conflict: false, hunks: [], conflictMarkers: null };
  }
  if (base === current) {
    return { merged: local, conflict: false, hunks: [], conflictMarkers: null };
  }
  if (base === local) {
    return { merged: current, conflict: false, hunks: [], conflictMarkers: null };
  }

  const baseLines = splitLinesPreserve(base);
  const currentLines = splitLinesPreserve(current);
  const localLines = splitLinesPreserve(local);

  const editsCurrent = diffLines(baseLines, currentLines);
  const editsLocal = diffLines(baseLines, localLines);

  let ic = 0;
  let il = 0;
  let baseCursor = 0;
  const output: string[] = [];
  const hunks: MergeConflictHunk[] = [];

  while (ic < editsCurrent.length || il < editsLocal.length) {
    const ec = editsCurrent[ic];
    const el = editsLocal[il];

    if (!el || (ec && !editsConflict(ec, el) && (ec.baseEnd < el.baseStart || (ec.baseEnd === el.baseStart && (ec.baseStart < el.baseStart || ec.baseStart === ec.baseEnd))))) {
      if (ec!.baseStart > baseCursor) {
        output.push(...baseLines.slice(baseCursor, ec!.baseStart));
      }
      output.push(...ec!.lines);
      baseCursor = ec!.baseEnd;
      ic++;
      continue;
    }

    if (!ec || (!editsConflict(ec, el) && (el.baseEnd < ec.baseStart || (el.baseEnd === ec.baseStart && (el.baseStart < ec.baseStart || el.baseStart === el.baseEnd))))) {
      if (el.baseStart > baseCursor) {
        output.push(...baseLines.slice(baseCursor, el.baseStart));
      }
      output.push(...el.lines);
      baseCursor = el.baseEnd;
      il++;
      continue;
    }

    // Collect the full transitive closure of conflicting edits across both sides.
    const groupCurrent: LineEdit[] = [ec];
    const groupLocal: LineEdit[] = [el];
    ic++;
    il++;
    let spanStart = Math.min(ec.baseStart, el.baseStart);
    let spanEnd = Math.max(ec.baseEnd, el.baseEnd);

    let expanded = true;
    while (expanded) {
      expanded = false;
      const probe: LineEdit = { baseStart: spanStart, baseEnd: spanEnd, lines: [] };
      while (ic < editsCurrent.length && editsConflict(probe, editsCurrent[ic]!)) {
        const next = editsCurrent[ic++]!;
        groupCurrent.push(next);
        spanStart = Math.min(spanStart, next.baseStart);
        spanEnd = Math.max(spanEnd, next.baseEnd);
        probe.baseStart = spanStart;
        probe.baseEnd = spanEnd;
        expanded = true;
      }
      while (il < editsLocal.length && editsConflict(probe, editsLocal[il]!)) {
        const next = editsLocal[il++]!;
        groupLocal.push(next);
        spanStart = Math.min(spanStart, next.baseStart);
        spanEnd = Math.max(spanEnd, next.baseEnd);
        probe.baseStart = spanStart;
        probe.baseEnd = spanEnd;
        expanded = true;
      }
    }

    if (spanStart > baseCursor) {
      output.push(...baseLines.slice(baseCursor, spanStart));
    }

    const baseSeg = baseLines.slice(spanStart, spanEnd);
    const currentSeg = applyEditsToSpan(baseLines, spanStart, spanEnd, groupCurrent);
    const localSeg = applyEditsToSpan(baseLines, spanStart, spanEnd, groupLocal);

    if (arraysEqual(currentSeg, localSeg)) {
      // Convergent edit: both sides produced identical lines.
      output.push(...currentSeg);
    } else {
      // Trim identical prefix/suffix lines agreed upon by both sides, and resolve when one side
      // left the remaining base slice untouched (zealous diff3 refinement).
      let p = 0;
      const minSeg = Math.min(currentSeg.length, localSeg.length);
      while (p < minSeg && currentSeg[p] === localSeg[p]) p++;
      let s = 0;
      while (
        s < currentSeg.length - p &&
        s < localSeg.length - p &&
        currentSeg[currentSeg.length - 1 - s] === localSeg[localSeg.length - 1 - s]
      ) {
        s++;
      }

      const agreedPrefix = currentSeg.slice(0, p);
      const agreedSuffix = s > 0 ? currentSeg.slice(currentSeg.length - s) : [];
      const cMid = currentSeg.slice(p, currentSeg.length - s);
      const lMid = localSeg.slice(p, localSeg.length - s);

      const curMaxEnd = groupCurrent.reduce((m, e) => Math.max(m, e.baseEnd), spanStart);
      const locMaxEnd = groupLocal.reduce((m, e) => Math.max(m, e.baseEnd), spanStart);
      const curMinStart = groupCurrent.reduce((m, e) => Math.min(m, e.baseStart), spanEnd);
      const locMinStart = groupLocal.reduce((m, e) => Math.min(m, e.baseStart), spanEnd);

      const localUntouchedTail =
        p > 0 && s === 0 && locMaxEnd < spanEnd && arraysEqual(lMid, baseLines.slice(locMaxEnd, spanEnd));
      const currentUntouchedTail =
        p > 0 && s === 0 && curMaxEnd < spanEnd && arraysEqual(cMid, baseLines.slice(curMaxEnd, spanEnd));
      const localUntouchedHead =
        s > 0 && p === 0 && locMinStart > spanStart && arraysEqual(lMid, baseLines.slice(spanStart, locMinStart));
      const currentUntouchedHead =
        s > 0 && p === 0 && curMinStart > spanStart && arraysEqual(cMid, baseLines.slice(spanStart, curMinStart));

      if (localUntouchedTail || localUntouchedHead) {
        output.push(...agreedPrefix, ...cMid, ...agreedSuffix);
      } else if (currentUntouchedTail || currentUntouchedHead) {
        output.push(...agreedPrefix, ...lMid, ...agreedSuffix);
      } else {
        const baseText = baseSeg.join('');
        const currentText = currentSeg.join('');
        const localText = localSeg.join('');
        hunks.push({
          base_start_line: spanStart + 1,
          base_end_line: Math.max(spanStart + 1, spanEnd),
          base: baseText,
          current: currentText,
          local: localText,
        });
        output.push(
          `<<<<<<< current\n${ensureTrailingNewline(currentText)}||||||| base\n${ensureTrailingNewline(baseText)}=======\n${ensureTrailingNewline(localText)}>>>>>>> local\n`,
        );
      }
    }
    baseCursor = spanEnd;
  }

  if (baseCursor < baseLines.length) {
    output.push(...baseLines.slice(baseCursor));
  }

  const combined = output.join('');
  return {
    merged: combined,
    conflict: hunks.length > 0,
    hunks,
    conflictMarkers: hunks.length > 0 ? combined : null,
  };
}

export function merge3WayBuffers(base: Buffer, current: Buffer, local: Buffer): Merge3BufferResult {
  if (current.equals(local)) {
    return { merged: Buffer.from(current), conflict: false, binary: isBinaryBuffer(current), reason: null, hunks: [], conflictMarkers: null };
  }
  if (base.equals(current)) {
    return { merged: Buffer.from(local), conflict: false, binary: isBinaryBuffer(local), reason: null, hunks: [], conflictMarkers: null };
  }
  if (base.equals(local)) {
    return { merged: Buffer.from(current), conflict: false, binary: isBinaryBuffer(current), reason: null, hunks: [], conflictMarkers: null };
  }
  if (isBinaryBuffer(base) || isBinaryBuffer(current) || isBinaryBuffer(local)) {
    return {
      merged: null,
      conflict: true,
      binary: true,
      reason: 'binary_conflict',
      hunks: [],
      conflictMarkers: null,
    };
  }
  const textResult = merge3WayText(base.toString('utf8'), current.toString('utf8'), local.toString('utf8'));
  return {
    merged: textResult.conflict ? null : Buffer.from(textResult.merged, 'utf8'),
    conflict: textResult.conflict,
    binary: false,
    reason: textResult.conflict ? 'content_conflict' : null,
    hunks: textResult.hunks,
    conflictMarkers: textResult.conflictMarkers,
  };
}
