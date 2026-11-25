export declare const SENSITIVE_BASENAMES: ReadonlySet<string>;
export declare const SENSITIVE_EXTENSIONS: RegExp;
export declare const SENSITIVE_PATH_PATTERNS: readonly RegExp[];
export declare const SENSITIVE_MEMORY_PATH_RE: RegExp;
export declare function isSensitiveToolPath(relPath: string): string | null;
export declare function isSensitiveSyncPath(relPath: string): boolean;
