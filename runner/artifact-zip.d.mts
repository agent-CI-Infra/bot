export const MAX_ARTIFACT_COMPRESSED_BYTES: number;
export const MAX_ARTIFACT_UNCOMPRESSED_BYTES: number;
export const MAX_ARTIFACT_ENTRIES: number;

export class ArtifactArchiveError extends Error {
  code: string;
  detail: string;
  constructor(code: string, detail?: string);
}

export interface ParsedArtifactEntry {
  path: string;
  parts: string[];
  data: Buffer;
  size: number;
  mode: number;
}

export interface ArtifactExtractOptions {
  maxCompressedBytes?: number;
  maxUncompressedBytes?: number;
  maxEntries?: number;
}

export function parseArtifactZip(
  buffer: Buffer,
  options?: ArtifactExtractOptions,
): { files: ParsedArtifactEntry[]; directories: string[]; totalBytes: number };

export function extractArtifactZip(
  buffer: Buffer,
  destinationDir: string,
  options?: ArtifactExtractOptions,
): { total_files: number; total_bytes: number; files: { path: string; size: number }[] };
