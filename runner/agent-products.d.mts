import type { AcpProductLaunch } from './acp-products.mjs';

export type AgentToolCli = 'claude_code' | 'codex';
export type AgentToolAcpProduct = 'icode' | 'workswarm';
export type AgentToolProduct = AgentToolCli | AgentToolAcpProduct;
export type AgentToolArch = 'x64' | 'arm64';

export interface CliCompatibilityRange {
  readonly cli: AgentToolCli;
  readonly min: string;
  readonly maxExclusive: string;
  readonly range: string;
  readonly tested: string;
}

export interface ICodeRelease {
  readonly version: string;
  readonly repo: string;
  readonly tag: string;
  readonly commit: string;
  readonly assets: Readonly<Partial<Record<AgentToolArch, string>>>;
  readonly sha256: Readonly<Partial<Record<string, string>>>;
}

export interface WorkSwarmRelease {
  readonly version: string;
  readonly repo: string;
  readonly tag: string;
  readonly commit: string;
  readonly python: string;
  readonly wheel: string;
  readonly pyprojectSha256: string;
  readonly wheelSha256: string;
  readonly lockSha256: string;
  readonly sourceSha256: string;
}

export interface AgentProductEntry {
  readonly id: AgentToolProduct;
  readonly name: string;
  readonly kind: 'cli' | 'acp';
  readonly installKind: 'npm_claude_code' | 'github_codex' | 'github_icode_offline' | 'github_workswarm_uv';
  readonly defaultVersion: string;
  readonly allowCustomVersion: boolean;
  readonly supportsLocalModelConfig: boolean;
  readonly compatibility: CliCompatibilityRange | null;
  readonly runtimes: Readonly<{ node?: string; uv?: string; python?: string }>;
}

export const BUNDLED_NODE_VERSION: string;
export const BUNDLED_UV_RELEASE: Readonly<{
  version: string;
  repo: string;
  assets: Readonly<Record<AgentToolArch, Readonly<{ name: string; entry: string; sha256: string }>>>;
}>;

export const icodeProductId: 'icode';
export const icodeTestedVersion: string;
export const icodeLaunch: Readonly<AcpProductLaunch>;
export const icodeReleases: ReadonlyMap<string, ICodeRelease>;

export const workswarmProductId: 'workswarm';
export const workswarmRelease: Readonly<WorkSwarmRelease>;
export const workswarmReleases: ReadonlyMap<string, Readonly<WorkSwarmRelease>>;
export const workswarmLaunch: AcpProductLaunch;

export const AGENT_PRODUCT_REGISTRY: readonly AgentProductEntry[];
export const AGENT_PRODUCT_MAP: ReadonlyMap<string, AgentProductEntry>;
export const AGENT_TOOL_PRODUCTS: readonly AgentToolProduct[];
export const AGENT_TOOL_CLIS: readonly AgentToolCli[];
export const AGENT_TOOL_ACP_PRODUCTS: readonly AgentToolAcpProduct[];
export const COMPATIBLE_CLI_RANGES: Readonly<Record<AgentToolCli, CliCompatibilityRange>>;

export function supportedProductVersions(id: string, arch?: string): string[];
