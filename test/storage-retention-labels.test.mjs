import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConsole } from './console-page.mjs';

// #882: axe reports `label` (critical) on the per-project retention inputs. The project name sits in a sibling <td>, and a
// sibling is not a name, so each input has to carry its own: `<project> 轨迹正文保留天数`. The five global fields keep
// their wrapped <label> and must not be renamed.
const retention = () => ({
  settings: { trajectory_days: 30, trajectory_days_by_project: { '101': 7 }, manager_payload_days: 14, workspace_finished_days: 14, workspace_failed_days: 30, webhook_payload_days: 14 },
  defaults: { manager_payload_days: 14, workspace_finished_days: 14, workspace_failed_days: 30 },
  bounds: { trajectory_days: [1, 365], manager_payload_days: [1, 365], workspace_finished_days: [1, 365], workspace_failed_days: [1, 365], webhook_payload_days: [1, 365] },
  projects: [{ id: '101', name: 'fixture-project' }],
  last_cleanup: null,
});
// static/settings/page.js is one file of the settings bundle and calls settingsCard(), which static/settings/nav.js defines.
const page = () => loadConsole(['static/app.js', 'static/views/widgets.js', 'static/project/fields.js', 'static/costs.js', 'static/settings/nav.js', 'static/settings/page.js'],
  (method, path) => path === '/api/storage/retention' ? [200, retention()] : [200, {}]);

test('each per-project retention input carries its project name', async () => {
  const ui = page();
  const section = await ui.run('retentionCard(String, String, String)');
  const inputs = section.querySelectorAll('input');
  const perProject = inputs.filter(input => input.name.startsWith('trajectory_days_'));
  assert.equal(perProject.length, 1, 'one input per project in the retention table');
  assert.equal(perProject[0].getAttribute('aria-label'), 'fixture-project 轨迹正文保留天数');
  // The five global windows are named by their visible <label>; they are not the defect.
  const globals = ['trajectory_days', 'manager_payload_days', 'workspace_finished_days', 'workspace_failed_days', 'webhook_payload_days'];
  const named = inputs.filter(input => globals.includes(input.name));
  assert.equal(named.length, 5);
  for (const control of named) assert.equal(control.getAttribute('aria-label'), null, `${control.name} keeps its <label>`);
});
