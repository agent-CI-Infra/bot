export const resourceBounds = { cpus: [0.25, 16], memory_mb: [256, 65536], pids: [64, 16384], tmp_mb: [16, 65536] };
// Unified single-container memory cap: reserve 25% of host RAM for the host OS, Docker, manager, and control plane
// (rounded down to 256 MiB). Applies uniformly to both inherited defaults (including 16 GiB on a 16 GiB host) and
// explicit saves (#1279). When Docker /info transiently errors and no cached host info exists, fall back conservatively.
export const CONSERVATIVE_FALLBACK_MEMORY_MB = 4096;
export const CONSERVATIVE_FALLBACK_CPUS = 2;
export function hostMemoryCap(hostMemoryMb) {
  if (!(typeof hostMemoryMb === 'number' && Number.isFinite(hostMemoryMb) && hostMemoryMb > 0)) return null;
  const reserveSafe = Math.floor((hostMemoryMb * 0.75) / 256) * 256;
  return Math.min(hostMemoryMb, Math.max(resourceBounds.memory_mb[0], reserveSafe || Math.floor(hostMemoryMb)));
}
export function clampMemoryToHost(memoryMb, hostOrMb) {
  if (hostOrMb && typeof hostOrMb === 'object') {
    const cap = hostOrMb.memory_mb ? hostMemoryCap(hostOrMb.memory_mb) : (hostOrMb.fallback_cap_mb ?? null);
    return cap !== null && memoryMb > cap ? cap : memoryMb;
  }
  const cap = hostMemoryCap(hostOrMb);
  return cap !== null && memoryMb > cap ? cap : memoryMb;
}
// CPUs in steps of 0.01, the other resources whole numbers, all inside their bounds (assistant computers pass their own).
export function validResource(key, value, limits = resourceBounds) {
  const [min, max] = limits[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (key === 'cpus' ? Math.round(value * 100) === value * 100 : Number.isInteger(value));
}
