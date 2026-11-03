/** Classification rules and metric computation shared by the collector. */

/**
 * @param {string} login
 * @param {string|undefined} userType GitHub user `type` (e.g. "Bot")
 * @param {import('./config.mjs').MonitorConfig} config
 */
export function isBot(login, userType, config) {
  if (!login) return false
  if (userType === 'Bot') return true
  if (login.endsWith('[bot]')) return true
  return config.bots.includes(login)
}

/**
 * Internal contributors are the logins listed for the repository in
 * `config/internal-contributors.json`; everyone else counts as external.
 * Bots are neither, and are reported as "unknown".
 *
 * @param {string} login
 * @param {string[]} internalContributors logins treated as internal for this repo
 * @param {import('./config.mjs').MonitorConfig} config
 * @param {string|undefined} userType GitHub user `type` (e.g. "Bot")
 */
export function classify(login, internalContributors, config, userType) {
  if (isBot(login, userType, config)) return 'unknown'
  if (login && internalContributors.includes(login)) return 'internal'
  return 'external'
}

export function hoursBetween(fromIso, toIso) {
  const from = new Date(fromIso).getTime()
  const to = new Date(toIso).getTime()
  if (Number.isNaN(from) || Number.isNaN(to)) return null
  return Math.max(0, (to - from) / 3_600_000)
}

export function toComposition(records) {
  const out = { internal: 0, external: 0, unknown: 0 }
  for (const r of records) out[r.contributionType] += 1
  return out
}

export function round1(v) {
  return v === null || v === undefined ? null : Math.round(v * 10) / 10
}