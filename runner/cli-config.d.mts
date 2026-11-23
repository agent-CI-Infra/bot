export const MAX_CLI_CONFIG_BYTES: number;

export interface CliConfigFileDef {
  readonly name: string;
  readonly relPath: string;
  readonly format: 'json' | 'toml';
  readonly description: string;
}

export const CLI_CONFIG_FILES: Readonly<Record<'claude_code' | 'codex', readonly CliConfigFileDef[]>>;

export function localConfigMissingCode(cli: string): string;
export function inspectCliConfigs(workspaceRoot: string): Promise<Record<string, {
  configured: boolean;
  files: Record<string, { path: string; exists: boolean; bytes: number | null; updated_at: string | null }>;
}>>;
export function writeCliConfig(workspaceRoot: string, cli: string, file: string, content: string): Promise<{
  cli: string;
  file: string;
  path: string;
  exists: boolean;
  bytes: number | null;
  updated_at: string | null;
}>;
export function deleteCliConfig(workspaceRoot: string, cli: string, file: string): Promise<{
  cli: string;
  file: string;
  path: string;
  exists: false;
  bytes: null;
  updated_at: null;
}>;
export function stageLocalCliConfig(workspaceRoot: string, cli: string, targetDir: string, addSecret?: (secret: string) => void): Promise<string[]>;
export function cleanupStagedCliConfig(stagedPaths: readonly string[] | undefined): Promise<void>;
