// Since #1068 a project without a configuration runs the recommended one: every role on Pi, which needs a project
// computer. Tests of role and task mechanics that drive a fake model in process store what such a project ran before:
// the legacy configuration with no backend chosen. Every role runs Native, an instance keeps the backend it was first
// bound to, and the review and Actions entries run their dev assignment on Pi. Stored after start-up, it is not
// migrated (migration:1068 has already run).
export function nativeRoles(store, repositoryId) {
  store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'roles:' + repositoryId, JSON.stringify({ enabled: false, harnesses: {} }));
}
