export interface AcpProductLaunch {
  args: string[];
  mcp: 'http' | 'stdio';
  access: 'full' | 'native';
  untrustedCheckout: boolean;
  env: Record<string, string>;
  answers: Record<string, unknown>;
  sidecars: {name: string; args: string[]; healthPath: string; healthTransport?: 'websocket'}[];
}
export interface AcpProductManifest {
  schema: 'bot.acp-product/1';
  id: string;
  version: string;
  python?: string;
  distribution?: 'linux-offline';
  interpreter?: string;
  source: string;
  sourceSha256: string;
  lockSha256?: string;
  launch: AcpProductLaunch;
}
export const acpProductId: RegExp;
export const acpVersion: RegExp;
export function validateAcpLaunch(launch: unknown): AcpProductLaunch;
export function readAcpProduct(root: string, id: string, version?: string): AcpProductManifest;
export const icodeProductId: 'icode';
export const icodeTestedVersion: string;
export const icodeReleases: ReadonlyMap<string, { commit: string; sha256: Partial<Record<string, string>> }>;
export function acpProductExecutable(id: string): string;
export const workswarmProductId: 'workswarm';
export const workswarmRelease: Readonly<{
  version: string; commit: string; python: string; wheel: string; wheelSha256: string; lockSha256: string; sourceSha256: string;
}>;
export const workswarmLaunch: AcpProductLaunch;
export function requiresAcpRunHome(id: unknown): boolean;
