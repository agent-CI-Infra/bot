export const githubTokenSource: string;
export class Redactor {
  readonly values: Set<string>;
  readonly publicationPattern: RegExp | undefined;
  add(value: unknown): void;
  addExact(value: unknown): void;
  text(value: string): string;
  clean<T>(value: T): T;
  contains(bytes: Buffer): boolean;
}
export function publicText(value: string, redactor: Pick<Redactor, 'publicationPattern'>): string;
export function publicContent<T>(value: T, redactor: Pick<Redactor, 'publicationPattern'>): T;
