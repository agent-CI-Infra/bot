import type { RolePermissions } from './permissions.js';

/**
 * Built-in role defaults that earlier versions shipped (#1068). A project that adopted the recommended configuration saved
 * the defaults of its day, so the one-time move to "follow the built-in defaults" must recognise those as unchanged too.
 *
 * Templates: sha256 (first 16 hex) of every built-in role template main has shipped since templates became editable
 * (51e22200) up to 886442b5, after retireLegacyRoleGuidance, the form a saved prompt is read in. They were computed by
 * evaluating src/roles/pool.ts at each of those commits. Nothing needs adding later: an unchanged project follows the
 * current defaults from now on, and the list only serves the migration.
 */
export const earlierTemplates: Record<string, readonly string[]> = {
  coordinator: ['91b2d351d6f7e111', '6574306eaea75460'],
  manager: ['94ac7f8c52c1cdba', '6f99e38ca94e5973', '8c6ead431f6b19b1', '667b585053ce1015', '85e9a35552dbf0e8', '6ce47803abb2548f', 'bde408bb999ba69b'],
  dev: ['9147d0d01a14e5ae', 'b597c306ffaf6638'],
  test: ['b8b51c1cec64e139', 'aca4aff03a4e6b83'],
  reviewer: ['c1ae792f7fd67fa9', 'b1ea141f88613a65'],
  ux: ['cf36d72ec5ee24cd', '9753ca40d90640f8'],
  qa: ['81b872dde03f64d3', 'b1550f15a6304eeb', '24275e8117dcd47b'],
};

/**
 * Permissions: #381 reset every saved built-in role to the defaults of that day. Since then the defaults changed three
 * times: #908 added the task browser (reading an older row already fills it in), c0d04aa0 let the controllers use the
 * computer, and #1072 gave Actions write to the roles that write Issues (migration:1072 brings saved roles to it before
 * migration:1068 compares). Each entry is the difference of an earlier default from today's.
 */
export const earlierPermissions: Record<string, readonly RolePermissions[]> = {
  coordinator: [{ computer: 'deny' }],
  manager: [{ computer: 'deny' }],
};
