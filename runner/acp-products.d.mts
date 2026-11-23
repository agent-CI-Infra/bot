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
export {
  icodeProductId,
  icodeTestedVersion,
  icodeReleases,
  workswarmProductId,
  workswarmRelease,
  workswarmLaunch,
  type ICodeRelease,
  type WorkSwarmRelease,
} from './agent-products.mjs';
export function acpProductExecutable(id: string): string;
export function requiresAcpRunHome(id: unknown): boolean;
