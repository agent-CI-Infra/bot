export const githubTokenSource: string;
export function githubTokens(): RegExp;
export function redactCredentials<T>(value: T): T;
export function hasCredentials(value: unknown): boolean;
export function redactCredentialShapes<T>(value: T): T;
export function credentialShapeStream(write: (text: string) => void, holdLimit?: number): { data(text: string): void; end(): void };
