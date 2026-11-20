import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Store } from '../storage/database.js';
import { visibleModel } from '../agent/model.js';
import { roleConfiguration, saveConfiguration } from '../roles/definition.js';
import { defaults as ruleDefaults } from '../rules/service.js';
import { defaultManagerPrompt, eventFilters, managerPrompt } from './settings.js';
import { normalizeSavedRule } from './rules.js';

const promptFile = (name: string) => readFileSync(resolve(import.meta.dirname, '../../docs/prompts', name), 'utf8');
const stripHeading = (text: string) => text.trim().replace(/^#[ \t]+[^\n]+\n+/, '').trim();
const hash16 = (text: string) => createHash('sha256').update(text.trim()).digest('hex').slice(0, 16);

// Pre-#1122 built-in manager-dispatch.md hashes (full and H1-stripped) so unmodified legacy revisions are recognized cleanly.
const earlierDispatchHashes = new Set([
  '57b06db8f2d9276d',
  '94f14da27cf23355',
  'c21b41c681765459',
  '00e8a509bb03f722',
]);

// Former built-in Actions analysis text (with and without its heading).
const earlierActionsHashes = new Set(['bafbf10ff1334a5c', '49d266244b5b76df']);

const legacySectionBuiltins: Record<string, () => string> = {
  dispatch: () => defaultManagerPrompt,
  'review.issue': () => ruleDefaults['.bot/rules/issue-review.md'] ?? promptFile('issue-review.md'),
  'review.pr': () => ruleDefaults['.bot/rules/pr-review.md'] ?? promptFile('pr-review.md'),
  development: () => ruleDefaults['.bot/rules/issue-development.md'] ?? promptFile('issue-development.md'),
  labels: () => ruleDefaults['.bot/rules/labels.md'] ?? promptFile('labels.md'),
  guide: () => ruleDefaults['.bot/guide.md'] ?? '',
  reply: () => '',
  'release.observe': () => promptFile('release-observe.md'),
  'release.notes': () => '',
  'actions.failures': () => promptFile('actions-failures.md'),
  schedule: () => '',
};

const isBuiltinSectionBody = (id: string, rawBody: string): boolean => {
  const trimmed = rawBody.trim();
  if (!trimmed) return true;
  const builtin = legacySectionBuiltins[id]?.()?.trim() ?? '';
  if (trimmed === builtin || stripHeading(trimmed) === stripHeading(builtin)) return true;
  const earlier = id === 'dispatch' ? earlierDispatchHashes : id === 'actions.failures' ? earlierActionsHashes : null;
  return !!earlier && (earlier.has(hash16(trimmed)) || earlier.has(hash16(stripHeading(trimmed))));
};

const roleModelPriority: Record<string, readonly string[]> = {
  manager: ['manager'],
  coordinator: ['coordinator'],
  reviewer: ['review.pr', 'review.issue', 'reply', 'release.observe', 'release.notes'],
  dev: ['development.issue', 'development.pr', 'task.development', 'actions.failures', 'task.request'],
  test: ['test'],
  qa: ['qa'],
};

const keyToTargetRole: Record<string, string> = Object.fromEntries(
  Object.entries(roleModelPriority).flatMap(([roleId, keys]) => keys.map(k => [k, roleId])),
);

const rulePathToSection: Record<string, string> = {
  '.bot/rules/issue-review.md': 'review.issue',
  '.bot/rules/pr-review.md': 'review.pr',
  '.bot/rules/issue-development.md': 'development',
  '.bot/rules/labels.md': 'labels',
  '.bot/guide.md': 'guide',
};

const heading = /^##[ \t]+(.*?)[ \t]*`([a-z][a-z0-9._-]*)`[ \t]*$/;

export function parseLegacySections(content: string): { preamble: string; sections: Map<string, { title: string; body: string }> } {
  const found = new Map<string, { title: string; body: string }>(), lines = content.replace(/\r\n/g, '\n').split('\n'), preamble: string[] = [];
  let current: { id: string; title: string; lines: string[] } | null = null, fence = false;
  const close = () => {
    if (current && current.id !== 'gate.onboarding') {
      found.set(current.id, { title: current.title, body: current.lines.join('\n').replace(/^\n+|\s+$/g, '') });
    }
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = !fence && heading.exec(line);
    if (match) {
      close();
      current = { id: match[2]!, title: match[1] || match[2]!, lines: [] };
      continue;
    }
    (current ? current.lines : preamble).push(line);
  }
  close();
  return { preamble: preamble.join('\n').trim(), sections: found };
}

const jsonObj = (raw: unknown): Record<string, any> => {
  try {
    const v = JSON.parse(String(raw ?? '{}'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
};

/**
 * Retires legacy tables/tasks and performs the one-time #1122 migration:
 * - folds custom Manager work-type rule sections into `reviewer`, `dev` and `manager` prompts;
 * - moves `policies.task_models` overrides onto role `model_profile_ref` where unset;
 * - upgrades saved `manager_rules` from `work` to `role` + `writes`;
 * - clears `policies.work_settings` and `policies.task_models` while preserving historical finished tasks' `kind`.
 */
export function migrateRetireWorkTypes(store: Store): void {
  store.transaction(() => {
    store.db.exec('DROP TABLE IF EXISTS gate_onboarding_sessions; DROP TABLE IF EXISTS quickstart_runs; DROP TABLE IF EXISTS workflows;');
    const now = new Date().toISOString();
    store.run(
      "UPDATE tasks SET status='cancelled',error_code='work_removed',claim_token=NULL,next_run_at=0,updated_at=? WHERE kind='gate.onboarding' AND status NOT IN ('succeeded','pr_opened','completed','cancelled','superseded','failed')",
      now,
    );
  });

  store.transaction(() => {
    const now = new Date().toISOString();
    const rulesUpgradedByRepo = new Map<string, number>();
    if (store.hasTable('manager_rules')) {
      for (const row of store.all('SELECT repository_id,revision,rules FROM manager_rules')) {
        try {
          const list = JSON.parse(String(row.rules));
          if (Array.isArray(list) && list.some((r: any) => r?.work !== undefined)) {
            const normalized = list.map(normalizeSavedRule).filter(Boolean);
            store.run('UPDATE manager_rules SET rules=? WHERE repository_id=? AND revision=?', JSON.stringify(normalized), row.repository_id, row.revision);
            const repoKey = String(row.repository_id);
            rulesUpgradedByRepo.set(repoKey, (rulesUpgradedByRepo.get(repoKey) ?? 0) + list.filter((r: any) => r?.work !== undefined).length);
          }
        } catch {
          // ignore malformed historical rule JSON
        }
      }
    }

    for (const policy of store.all('SELECT * FROM policies')) {
      const repoId = String(policy.repository_id);
      const repoMarker = `migration:1122:repo:${repoId}`;
      if (store.get('SELECT 1 FROM settings WHERE key=?', repoMarker)) continue;
      const currentPrompt = managerPrompt(store, repoId);
      const rawRevisionRow = store.get('SELECT * FROM manager_revisions WHERE repository_id=? ORDER BY revision DESC LIMIT 1', repoId);
      const rawContent = rawRevisionRow ? String(rawRevisionRow.content) : '';
      const dispatchRow = store.get('SELECT content FROM manager_dispatch_prompts WHERE repository_id=? ORDER BY revision DESC LIMIT 1', repoId);
      const parsed = parseLegacySections(rawContent);
      const rawWorkSettings = jsonObj(policy.work_settings);
      const overrides = jsonObj(policy.rule_overrides);
      for (const [path, secId] of Object.entries(rulePathToSection)) {
        if (!parsed.sections.has(secId) && typeof overrides[path] === 'string' && overrides[path].trim()) {
          parsed.sections.set(secId, { title: secId, body: overrides[path].trim() });
        }
      }

      const migratedSections: string[] = [];
      const customSection = (id: string): string | null => {
        const entry = parsed.sections.get(id);
        if (!entry || !entry.body.trim()) return null;
        if (isBuiltinSectionBody(id, entry.body)) return null;
        migratedSections.push(id);
        return entry.body.trim();
      };

      const reviewerExtras: string[] = [];
      for (const [id, label] of [['review.pr', 'PR 检视规则'], ['review.issue', 'Issue 检视规则'], ['labels', '标签规则']] as const) {
        const text = customSection(id);
        if (text) reviewerExtras.push(`### ${label}\n\n${text}`);
      }
      const devText = customSection('development');

      const managerParts: string[] = [];
      if (dispatchRow && String(dispatchRow.content).trim()) {
        managerParts.push(String(dispatchRow.content).trim());
      } else {
        if (parsed.preamble) managerParts.push(parsed.preamble);
        const dispatchBody = customSection('dispatch');
        if (dispatchBody) managerParts.push(dispatchBody);
      }
      for (const [id, label] of [
        ['guide', '行为指南'],
        ['reply', '通用回复约定'],
        ['release.observe', 'CI 观察约定'],
        ['release.notes', '发行说明约定'],
        ['actions.failures', 'Actions 失败处理约定'],
        ['schedule', '定时检查约定'],
      ] as const) {
        const text = customSection(id);
        if (text) managerParts.push(`## ${label}\n\n${text}`);
      }

      if (rawRevisionRow && parsed.sections.size > 0) {
        const nextContent = managerParts.length
          ? (managerParts.some(p => p.includes('# Event dispatch') || p === String(dispatchRow?.content ?? '').trim())
              ? managerParts.join('\n\n')
              : [defaultManagerPrompt.trim(), ...managerParts].join('\n\n'))
          : '';
        if (nextContent !== currentPrompt.content) {
          const nextRev = currentPrompt.revision + 1;
          store.run(
            'INSERT INTO manager_revisions VALUES(?,?,?,?,?,?,?,?)',
            repoId,
            nextRev,
            nextContent,
            '{}',
            JSON.stringify(eventFilters(store, repoId, policy)),
            'migration:1122',
            null,
            now,
          );
        }
      }

      // Migrate task_models and custom role prompt sections onto roles, recording conflicts and unmapped entries
      const taskModels = jsonObj(policy.task_models);
      const mappedModels: Record<string, { from: string; model_id: string }> = {};
      const modelConflicts: Array<{ key: string; model_id: string; target_role: string; kept_model_id: string; reason: string }> = [];
      const unmappedModels: Array<{ key: string; model_id: string; reason: string }> = [];
      const warnings: string[] = [];

      const nonEmptyTaskModels = Object.entries(taskModels)
        .filter(([, v]) => typeof v === 'string' && v.trim())
        .map(([k, v]) => [k, String(v).trim()] as const);

      for (const [key, modelId] of nonEmptyTaskModels) {
        if (!keyToTargetRole[key]) {
          unmappedModels.push({ key, model_id: modelId, reason: 'unrecognized_work_key' });
          warnings.push(`未识别的原工作类型模型键 \`${key}\`（模型 \`${modelId}\`）已归档至 manager_migrations，未自动写入角色。`);
        }
      }

      const roleCandidateChoice: Record<string, { key: string; model_id: string }> = {};
      for (const [roleId, priorityKeys] of Object.entries(roleModelPriority)) {
        const candidates = priorityKeys
          .filter(k => typeof taskModels[k] === 'string' && String(taskModels[k]).trim())
          .map(k => ({ key: k, model_id: String(taskModels[k]).trim() }));
        if (!candidates.length) continue;
        const winner = candidates[0]!;
        roleCandidateChoice[roleId] = winner;
        for (const other of candidates.slice(1)) {
          if (other.model_id !== winner.model_id) {
            modelConflicts.push({
              key: other.key,
              model_id: other.model_id,
              target_role: roleId,
              kept_model_id: winner.model_id,
              reason: 'multiple_legacy_work_models',
            });
            warnings.push(`原工作类型 \`${other.key}\` 的模型 \`${other.model_id}\` 与归并到角色 \`${roleId}\` 的 \`${winner.key}\`（\`${winner.model_id}\`）不一致，保留 \`${winner.model_id}\`。`);
          }
        }
      }

      const config = roleConfiguration(store, repoId);
      const roleUpdates: any[] = [];
      for (const role of config.roles) {
        let promptChanged = false;
        let nextPrompt = role.persona_prompt;
        if (role.role_id === 'reviewer' && reviewerExtras.length) {
          const block = `## 项目自定义检视规则（自原工作类型规则迁移）\n\n${reviewerExtras.join('\n\n')}`;
          if (!nextPrompt.includes('项目自定义检视规则（自原工作类型规则迁移）')) {
            nextPrompt = `${nextPrompt.trimEnd()}\n\n${block}`;
            promptChanged = true;
          }
        }
        if (role.role_id === 'dev' && devText) {
          const block = `## 项目自定义开发规则（自原工作类型规则迁移）\n\n${devText}`;
          if (!nextPrompt.includes('项目自定义开发规则（自原工作类型规则迁移）')) {
            nextPrompt = `${nextPrompt.trimEnd()}\n\n${block}`;
            promptChanged = true;
          }
        }
        let nextModelRef: any = role.model_profile_ref;
        let modelChanged = false;
        const choice = roleCandidateChoice[role.role_id];
        if (choice) {
          if (role.model_profile_ref) {
            if (role.model_profile_ref.model_id !== choice.model_id) {
              modelConflicts.push({
                key: choice.key,
                model_id: choice.model_id,
                target_role: role.role_id,
                kept_model_id: role.model_profile_ref.model_id,
                reason: 'role_already_configured',
              });
              warnings.push(`角色 \`${role.role_id}\` 已配置专属模型 \`${role.model_profile_ref.model_id}\`，跳过原 \`${choice.key}\` 模型 \`${choice.model_id}\`。`);
            } else {
              mappedModels[role.role_id] = { from: choice.key, model_id: choice.model_id };
            }
          } else if (choice.model_id === policy.model_id) {
            mappedModels[role.role_id] = { from: choice.key, model_id: choice.model_id };
          } else {
            const modelRow = visibleModel(store, repoId, choice.model_id);
            if (modelRow?.api_key) {
              nextModelRef = { model_id: choice.model_id, api: 'openai-chat-completions', tool_calls: true, structured_output: 'tool_call' };
              modelChanged = true;
              mappedModels[role.role_id] = { from: choice.key, model_id: choice.model_id };
            } else {
              unmappedModels.push({ key: choice.key, model_id: choice.model_id, reason: 'model_unavailable' });
              warnings.push(`原 \`${choice.key}\` 指向的模型 \`${choice.model_id}\` 不可用或无密钥，已归档并回退项目默认模型。`);
            }
          }
        }
        if (promptChanged || modelChanged) {
          roleUpdates.push({
            role_id: role.role_id,
            enabled: role.enabled,
            name: role.name,
            responsibility: role.responsibility,
            persona_prompt: nextPrompt,
            model_profile_ref: nextModelRef
              ? {
                  model_id: nextModelRef.model_id,
                  api: nextModelRef.api || 'openai-chat-completions',
                  tool_calls: nextModelRef.tool_calls !== false,
                  structured_output: nextModelRef.structured_output || 'tool_call',
                }
              : null,
            skill_bundle_ref: role.skill_bundle_ref ? { id: role.skill_bundle_ref.id } : null,
            harness_ref: role.harness_ref.model_source ? { id: role.harness_ref.id, model_source: role.harness_ref.model_source } : { id: role.harness_ref.id },
            permissions: role.permissions,
            environment_profile_ref: { id: role.environment_profile_ref.id },
            budget_policy_ref: Object.fromEntries(Object.entries(role.budget_policy_ref).filter(([k]) => k !== 'version')),
            output_schema_ref: { id: role.output_schema_ref.id },
          });
        }
      }

      if (roleUpdates.length) {
        saveConfiguration(store, repoId, { expected_revision: config.revision, roles: roleUpdates }, 'migration:1122');
      }

      const rulesUpgraded = rulesUpgradedByRepo.get(repoId) ?? 0;
      const hadLegacyState =
        Object.keys(rawWorkSettings).length > 0 ||
        Object.keys(taskModels).length > 0 ||
        Object.keys(overrides).length > 0 ||
        Boolean(rawRevisionRow) ||
        rulesUpgraded > 0;

      if (hadLegacyState && store.hasTable('manager_migrations')) {
        const prev = store.get('SELECT migrated_at,archive,report FROM manager_migrations WHERE repository_id=?', repoId);
        const archive = {
          work_settings: rawWorkSettings,
          task_models: taskModels,
          rule_overrides: overrides,
          manager_revision: rawRevisionRow ? { revision: rawRevisionRow.revision, content: rawRevisionRow.content, work_settings: rawRevisionRow.work_settings } : null,
          ...(prev ? { previous: { migrated_at: prev.migrated_at, archive: jsonObj(prev.archive), report: jsonObj(prev.report) } } : {}),
        };
        const report = {
          issue: 1122,
          migrated_sections: migratedSections,
          mapped_models: mappedModels,
          model_conflicts: modelConflicts,
          unmapped_models: unmappedModels,
          retired_work_settings: Object.keys(rawWorkSettings),
          rules_upgraded: rulesUpgraded,
          warnings,
          ...(prev ? { previous_report: jsonObj(prev.report) } : {}),
        };
        store.run(
          'INSERT INTO manager_migrations(repository_id,migrated_at,archive,report) VALUES(?,?,?,?) ON CONFLICT(repository_id) DO UPDATE SET migrated_at=excluded.migrated_at,archive=excluded.archive,report=excluded.report',
          repoId,
          now,
          JSON.stringify(archive),
          JSON.stringify(report),
        );
        store.audit('system', 'manager.work_types_migrated', repoId, repoId);
      }

      store.run("UPDATE policies SET work_settings='{}',task_models='{}' WHERE repository_id=?", repoId);
      store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING', repoMarker, now);
    }
  });
}
