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
}
export function harnessAccess(permissions: RolePermissions, network: boolean, repository: string | null, ceiling?:{read:boolean;write:boolean;commands:boolean}): HarnessAccess {
  const tools = new Set(permissionTools(permissions));
  const fileTools=tools.has('write_file') && ceiling?.write!==false ? 'write' : tools.has('read_file') && ceiling?.read!==false ? 'read' : 'none';
  const commands=tools.has('run_command') && ceiling?.commands!==false;
  return {
    workspace: commands ? 'write' : fileTools, fileTools, commands, network,
    github: { repository, scopes: githubReadScopes(permissions) },
  };
}

/** Pi/Claude tool switches alone cannot make an arbitrary shell read-only. Refuse this unsupported combination explicitly. */
export function checkHarnessAccess(backend:string,access:HarnessAccess|undefined):void {
  if(access && ['pi','claude_code'].includes(backend) && access.commands && access.workspace!=='write')
    stop('harness_permission_mismatch','waiting_configuration',`${backend}: this runner cannot enforce read-only files with arbitrary shell commands. Use a read-only execution environment or disable commands; no session was started.`);
}
