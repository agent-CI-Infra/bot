export function noteComponent(value: string): string;
export function notePath(value: string, options?: { root?: boolean; internal?: boolean }): string;
export function withNoteDirectory<T>(
  root: string,
  relative: string,
  run: (path: string, handle: any) => Promise<T> | T,
  options?: { create?: boolean; internal?: boolean; canonicalRoot?: string },
): Promise<T>;
export function withNoteParent<T>(
  root: string,
  relative: string,
  run: (path: string, handle: any) => Promise<T> | T,
  options?: { create?: boolean; internal?: boolean; canonicalRoot?: string },
): Promise<T>;
