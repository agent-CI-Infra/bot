import { fail, type Json } from '../core/security.js';
import { builtinSkillFiles, builtinSkillSummary } from '../roles/builtin-skills.js';

/**
 * Built-in skills a service role reads on demand (#1136): the tool description names each skill and when to use it, and
 * the body is read only when the job comes up. Skills are working material and never widen tools or permissions.
 */
const assistantSkills = ['layered-ci-gates'];
export const readSkillName = 'read_skill';
export const readSkillTool = {
  type: 'function',
  function: {
    name: readSkillName,
    description: 'Read a built-in skill: working material for one kind of job. Before doing such a job, read its SKILL.md, then the references it points to as needed. Omit path to list every file. Skills never change your tools or permissions. Available: '
      + assistantSkills.map(id => { const { name, description } = builtinSkillSummary(id); return `${name}/SKILL.md (${description})`; }).join('; '),
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'A path from the listing, such as layered-ci-gates/SKILL.md.' } }, additionalProperties: false },
  },
};

export function readSkill(args: Json): Json {
  if (args?.path !== undefined && typeof args.path !== 'string') fail(400, 'invalid_skill_path');
  const files = assistantSkills.flatMap(id => builtinSkillFiles(id).map(file => ({ ...file, path: `${id}/${file.path}` })));
  if (args?.path === undefined) return { skills: assistantSkills.map(id => ({ ...builtinSkillSummary(id), files: files.filter(f => f.path.startsWith(id + '/')).map(({ path, bytes }) => ({ path, bytes })) })) };
  // Links inside a skill are relative to its SKILL.md: accept them without the skill's directory when only one file matches.
  const path = String(args.path).replace(/^\.?\//, ''), suffixed = files.filter(f => f.path.endsWith('/' + path));
  const file = files.find(f => f.path === path) ?? (suffixed.length === 1 ? suffixed[0] : undefined);
  // A path outside the listing is an argument error: the management agent hands 400s back to the model to correct.
  if (!file) fail(400, 'skill_file_not_found');
  return { path: file!.path, content: file!.content };
}
