import {stop} from '../agent/common.js';
import type { RolePermissions } from '../roles/permissions.js';
import { githubReadScopes, permissionTools } from '../roles/permissions.js';

/** Effective execution access, prepared once by the trusted caller. MCP authorization stays at its own endpoints. */
export interface HarnessAccess {
  workspace: 'none' | 'read' | 'write';
  /** File-tool switches are distinct from filesystem writes already possible through an allowed shell. */
  fileTools?: 'none' | 'read' | 'write';
  commands: boolean;
  network: boolean;
  github: { repository: string | null; scopes: string[] };
  /** Whether the workspace checkout commit is the repository's trusted base branch (never an external PR head or untrusted ref). */
  trustedCheckout?: boolean;
  /** Trusted base-branch root `AGENTS.md` content supplied when `trustedCheckout` is false so untrusted checkout `AGENTS.md` is ignored. */
  trustedAgentsMd?: string | null;
  /** Trusted base-branch root `CLAUDE.md` content supplied when `trustedCheckout` is false so untrusted checkout `CLAUDE.md` is ignored. */
  trustedClaudeMd?: string | null;
}
export function harnessAccess(
  permissions: RolePermissions,
  network: boolean,
  repository: string | null,
  ceiling?: { read: boolean; write: boolean; commands: boolean; trustedCheckout?: boolean; trustedAgentsMd?: string | null; trustedClaudeMd?: string | null },
): HarnessAccess {
  const tools = new Set(permissionTools(permissions));
  const fileTools=tools.has('write_file') && ceiling?.write!==false ? 'write' : tools.has('read_file') && ceiling?.read!==false ? 'read' : 'none';
  const commands=tools.has('run_command') && ceiling?.commands!==false;
  return {
    workspace: commands ? 'write' : fileTools, fileTools, commands, network,
    github: { repository, scopes: githubReadScopes(permissions) },
    ...(ceiling?.trustedCheckout !== undefined ? { trustedCheckout: ceiling.trustedCheckout } : {}),
    ...(ceiling?.trustedAgentsMd ? { trustedAgentsMd: ceiling.trustedAgentsMd } : {}),
    ...(ceiling?.trustedClaudeMd ? { trustedClaudeMd: ceiling.trustedClaudeMd } : {}),
  };
}

/** Pi/Claude tool switches alone cannot make an arbitrary shell read-only. Refuse this unsupported combination explicitly. */
export function checkHarnessAccess(backend:string,access:HarnessAccess|undefined):void {
  if(access && ['pi','claude_code'].includes(backend) && access.commands && access.workspace!=='write')
    stop('harness_permission_mismatch','waiting_configuration',`${backend}: this runner cannot enforce read-only files with arbitrary shell commands. Use a read-only execution environment or disable commands; no session was started.`);
}
