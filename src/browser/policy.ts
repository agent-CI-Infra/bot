import type { Row } from '../storage/database.js';
import { normalizePolicy } from '../../runner/browser-policy.mjs';

export {
  allowedOrigin,
  destructiveAllowed,
  destructivePattern,
  isBrowserPassthroughUrl,
  networkRequestAllowed,
  normalizePolicy,
  originOf,
  redactArgs,
  redactBrowserValue,
  redactRecordedUrl,
  sanitizeBrowserTrajectory,
  tighterDestructive
} from '../../runner/browser-policy.mjs';

export type BrowserPolicy = NonNullable<ReturnType<typeof normalizePolicy>>;

/** Task input.browser, or null when the task did not list any allowed http(s) origin. */
export function browserPolicyOf(task: { input?: unknown } | Row): BrowserPolicy | null {
  let input: any;
  try { input = JSON.parse(String(task.input || '{}')); } catch { return null; }
  return normalizePolicy(input?.browser);
}
