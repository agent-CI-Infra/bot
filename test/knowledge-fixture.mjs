import { resolvePrincipalActor } from '../dist/identity/authorization.js';
import { identityProjection } from '../dist/identity/storage.js';

export function knowledgeActor(store, principal = 'owner', repo = 'r', capabilities = ['tasks.read', 'tasks.write', 'knowledge.read', 'knowledge.write']) {
  store.run("INSERT OR IGNORE INTO users(id,username,password_hash,role) VALUES(?,?,?,'project_admin')", principal, principal, 'fixture-unused-password');
  const owner = store.get('SELECT owner_id FROM repositories WHERE id=?', repo).owner_id;
  if (!/^\d+$/.test(owner)) store.run("UPDATE repositories SET owner_id='10' WHERE id=?", repo);
  identityProjection(store);
  const tenant = store.get('SELECT tenant_id FROM identity_projects WHERE project_id=?', repo).tenant_id;
  store.run(`INSERT OR IGNORE INTO scoped_grants(id,principal_id,tenant_id,project_id,scope,role,capabilities,source,policy,evidence,verified_at)
    VALUES(?,?,?,?,'project','project_admin',?,'explicit_delegation','fixture','explicit fixture grant',0)`, principal + ':' + repo, principal, tenant, repo, JSON.stringify(capabilities));
  return resolvePrincipalActor(store, principal, tenant);
}
export function authorizeKnowledgeTask(store, task = 't', principal = 'owner') {
  const repo = store.get('SELECT repository_id FROM tasks WHERE id=?', task).repository_id;
  const actor = knowledgeActor(store, principal, repo);
  store.run("INSERT OR REPLACE INTO task_authorizations VALUES(?,?,?,?,'tasks.write')", task, principal, actor.tenant_id, repo);
  return actor;
}
