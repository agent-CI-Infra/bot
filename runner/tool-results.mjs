import { mkdir } from 'node:fs/promises';

// A local Pi command journals beside its session, then the control plane copies it into the computer's shared results.
// The runner never writes the read-only /results mount or publishes a private journal path to the model.
export async function localCommandResult(id, value, save) {
  if (!value?.truncated || !value.output_file) return value;
  const { output_file, output, ...preview } = value;
  try { return await save({ output_id: id, preview }); }
  catch { return { ...preview, error: 'tool_result_storage_failed', notice: 'The complete output could not be saved; no usable result file was produced.' }; }
}
export async function prepareLocalResults(directory) { await mkdir(directory, { recursive: true, mode: 0o700 }); }
