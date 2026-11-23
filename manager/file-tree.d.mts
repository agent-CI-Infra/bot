export interface FileTreeListOptions {
  directory?: string;
  query?: string;
  includeDeleted?: boolean;
  deletedOnly?: boolean;
  recursive?: boolean;
  preview?: boolean;
}

export interface FileTreeCreateOptions {
  createParents?: boolean;
}

export class FileTree {
  readonly root: string;
  constructor(root: string);
  list(options?: FileTreeListOptions): Promise<Record<string, any>>;
  createDirectory(path: string): Promise<{ directory: string; revision: number }>;
  deleteDirectory(path: string): Promise<{ deleted: true; directory: string; revision: number }>;
  create(path: string, content: string, actor?: string, options?: FileTreeCreateOptions): Promise<Record<string, any>>;
  read(id: string, revision?: number): Promise<Record<string, any>>;
  versions(id: string): Promise<Record<string, any>>;
  save(id: string, content: string, expectedRevision: number, actor?: string): Promise<Record<string, any>>;
  delete(id: string, expectedRevision: number, actor?: string): Promise<Record<string, any>>;
  restore(id: string, revision: number, expectedRevision: number, actor?: string): Promise<Record<string, any>>;
  move(id: string, path: string, expectedRevision: number, actor?: string): Promise<Record<string, any>>;
}
