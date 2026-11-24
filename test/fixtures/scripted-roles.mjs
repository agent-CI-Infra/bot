import { scriptedHarness } from './scripted-driver.mjs';
import { rolePool } from '../../dist/roles/pool.js';

// Since #1068 a project without a configuration of its own runs every role on Pi, which needs a project computer. Tests
// of role and task mechanics that drive a fake model in process store a legacy configuration that names the test-only
// scripted driver for every built-in role (#1256; scripted-driver.mjs); a legacy configuration's unnamed roles run Pi
// (#1255). An instance keeps the backend it was first bound to, and the review and Actions entries run their dev
// assignment on Pi. Stored after start-up, it is not migrated (the start-up migrations have already run).
export const scriptedHarnesses = () => Object.fromEntries(rolePool.map(role => [role.id, scriptedHarness]));
export function scriptedRoles(store, repositoryId) {
  store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'roles:' + repositoryId, JSON.stringify({ enabled: false, harnesses: scriptedHarnesses() }));
}

// Service assistants on the scripted driver (#1256). Their turns run through serviceHarnessTurn like those on Pi, which
// opens a session workspace on the owner's assistant computer. The scripted driver runs in the test process and uses no
// workspace, so the turn's computer lends an empty one instead; the computer tools themselves are unchanged (unavailable
// without assistant computers, as before). Tests of Pi service turns install computers of their own.
export function scriptedServiceAssistants(store) {
  store.run("UPDATE service_roles SET harness=? WHERE id='management-assistant'", scriptedHarness);
}
/** Puts the group bound in chat `chatId` (a channel_chats id) on the scripted driver. Only a test registers it, so the
 * binding API, which offers the production backends, does not take it: a test saves the binding, then switches it here. */
export function scriptedGroup(store, chatId) {
  store.run('UPDATE channel_service_bindings SET harness=? WHERE chat_id=?', scriptedHarness, chatId);
}
export function lendSessionWorkspaces(assistants) {
  const turn = assistants.turn.bind(assistants);
  assistants.turn = options => {
    const computer = turn(options);
    computer.sessionWorkspace = async () => ({ manager: undefined, async release() {}, async call() { throw new Error('computer_not_configured'); } });
    return computer;
  };
}
/** Control-plane options (an object or a function of the store) with the lending above, keeping the caller's onChannels. */
export const withLentSessionWorkspaces = options => store => {
  const extra = typeof options === 'function' ? options(store) : options;
  return { ...extra, onChannels: service => { lendSessionWorkspaces(service.management.service.assistants); extra.onChannels?.(service); } };
};
