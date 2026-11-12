import { createHash } from 'node:crypto';

// Recreate the exact persisted shape of a pre-retirement binding, using already pinned file bodies.
export function legacySkillBinding(store, repositoryId, configuration, id) {
  const config = structuredClone(configuration), bundle = config.skills.find(b => b.id === id);
  const source = { type: 'builtin', playbooks: ['review'], commit: null };
  const files = JSON.parse(store.get('SELECT files FROM skill_bundle_revisions WHERE repository_id=? AND id=? AND revision=?', repositoryId, id, bundle.revision).files);
  const listing = files.map(({ content, ...file }) => file);
  const content_hash = createHash('sha256').update(JSON.stringify({ source, files: listing })).digest('hex');
  Object.assign(bundle, { source, content_hash });
  for (const role of config.roles) if (role.skill_bundle_ref?.id === id) role.skill_bundle_ref.content_hash = content_hash;
  store.run('UPDATE skill_bundle_revisions SET source=?,content_hash=? WHERE repository_id=? AND id=? AND revision=?', JSON.stringify(source), content_hash, repositoryId, id, bundle.revision);
  store.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify(config), 'roles:' + repositoryId);
  store.run('UPDATE role_config_revisions SET config=? WHERE repository_id=? AND revision=?', JSON.stringify(config), repositoryId, config.revision);
  return config;
}
