import { advancePrReviewCiWaits } from '../dist/review/ci-gate.js';

/** Release waiting automatic PR reviews as if CI had reached `result`. */
export function releasePrCi(store, result = { state: 'ready', checks: ['unit'] }, now = Date.now()) {
  return advancePrReviewCiWaits(store, () => result, now);
}
