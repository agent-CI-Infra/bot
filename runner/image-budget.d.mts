export const TEXT_REQUEST_LIMIT: number;
export const IMAGE_REQUEST_LIMIT: number;
export const MAX_IMAGES_IN_CONTEXT: number;
export const IMAGE_TOKEN_ESTIMATE: number;

export interface ImageRef {
  resource_id?: string;
  path?: string;
  name?: string;
  mime?: string;
  size?: number;
}

export function sanitizeImageEvents<T>(value: T, depth?: number): T;
export function sanitizeAgentPollTrajectory<T>(result: T): T;
export function analyzeModelPayload(parsed: unknown, rawBytes?: number): {
  totalBytes: number;
  textBytes: number;
  imageCount: number;
  imageBytes: number;
  strippedJson: string | null;
};
export function extractImageRef(content: unknown): ImageRef | null;
export function formatPiImageRecoveryNotice(reason: string, ref?: ImageRef | null): string;
export function imageBlockKey(msg: unknown, msgIndex: number, blockIndex: number, block: unknown): string;
export function enforceSessionImageBudget(
  messages: unknown[],
  options?: {
    maxTotalBytes?: number;
    maxImages?: number;
    rejected?: Map<string, string>;
  },
): {
  messages: unknown[];
  activeImages: string[];
  strippedCount: number;
};
export function isImageOrPayloadRejection(errorMessage: unknown): boolean;
export function extractToolContentBlocks(reply: unknown): {
  observation: unknown;
  images: Array<{ type: 'image'; data: string; mimeType: string }>;
  isError: boolean;
};
