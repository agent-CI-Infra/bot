// A size Docker did not report is not a measured zero: a missing field, moby's `-1`, or anything that is not a number
// means that kind of usage is unknown, so its total stays null (the page lists it as not measured) while the count still
// says how many rows were looked at. Summing a missing row as 0 would show a short number as complete.
function measuredBytes(rows, size) {
  let total = 0;
  for (const row of rows) {
    const value = size(row);
    if (value === undefined || value === null) return null;
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return null;
    total += bytes;
  }
  return total;
}
export async function collectDockerUsage({ docker, readContainers, readVolumes, logFailure }, now) {
  const df = await docker.request('GET', '/system/df?type=image&type=build-cache');
  const rows = value => Array.isArray(value) ? value : [];
  const images = rows(df?.Images), cache = rows(df?.BuildCache);
  // Docker reports the layers' own total; without it the listed image sizes add up, as long as each one is known.
  const layers = df?.LayersSize, layersBytes = layers === undefined || layers === null || !Number.isFinite(Number(layers)) || Number(layers) < 0
    ? measuredBytes(images, row => row?.Size) : Number(layers);
  // An image no container uses can be removed; its layers shared with images in use stay, so that part is not counted.
  const unused = images.filter(image => image.Containers === 0);
  const containers = await readContainers().catch(error => { logFailure('reading Docker container usage failed', error); return null; });
  const volumes = await readVolumes().catch(error => { logFailure('reading Docker volume usage failed', error); return null; });
  const usage = { read_at: new Date(now).toISOString(),
    images: { count: images.length, bytes: layersBytes, unused_count: unused.length,
      reclaimable_bytes: unused.reduce((total, image) => total + Math.max(0, (Number(image.Size) || 0) - Math.max(0, Number(image.SharedSize) || 0)), 0) },
    // A container takes its writable layer (SizeRw), not its whole filesystem (SizeRootFs), which is mostly its image.
    // A container read that failed leaves this kind null (not measured), while the two rows that did answer stand.
    containers,
    build_cache: { count: cache.length, bytes: measuredBytes(cache, row => row?.Size), reclaimable_bytes: measuredBytes(cache.filter(row => !row.InUse && !row.Shared), row => row?.Size) },
    // Only what is not already counted elsewhere, and the assistant HOME with its own attribution.
    volumes: volumes?.volumes ?? null, assistant_homes: volumes?.assistant_homes ?? null };
  return usage;
}

// The containers' writable layers, in a request of their own with a limit long enough for a host whose layers are slow
// to walk: the default 90 s of request() was shared with the image and build-cache read, so one slow container emptied
// every Docker row (#680). Docker answers `Containers` for this type; the other lists stay empty.
export async function readDockerContainers(docker) {
  const df = await docker.request('GET', '/system/df?type=container', undefined, false, 5 * 60_000);
  const containers = Array.isArray(df?.Containers) ? df.Containers : [];
  return { count: containers.length, bytes: measuredBytes(containers, row => row?.SizeRw) };
}
// The host's Docker volumes, in a request of their own (#968) for the same reason as the containers: sizing a volume
// walks it, and a volume read that is slow or times out must not cost the images or the build cache their numbers.
//
// A labelled volume never enters the Docker volume row, so the same bytes are not counted twice: the deployment labels
// every volume it creates with com.docker.compose.volume and the manager labels every volume it creates with
// department.bot.*. Some of those bytes are already in `known`: bot-data and manager-data (the two databases and
// their trajectory directories) and every current-generation *-work volume that was scanned — that includes the last
// generation a deleted project was ever scanned in, because computer_storage rows are never deleted and the `computers`
// row sums every one of them. The rest are excluded from the row but have no known row either — agent-tools, bot-keys/
// internal-keys/tunnel-keys, the *-notes volumes, an older-generation *-work volume left behind after a reset whose new
// generation has been scanned, and a work volume never scanned — so their bytes stay in "other"; none of them is
// Docker's own footprint. Only a volume outside that set is Docker's own, and assistant-homes — Compose-created but
// the bot's own data — is reported on its own so "other" stops absorbing it.
export async function readDockerVolumes(docker) {
  const df = await docker.request('GET', '/system/df?type=volume', undefined, false, 5 * 60_000);
  const rows = Array.isArray(df?.Volumes) ? df.Volumes : [], labels = row => row?.Labels ?? {};
  const home = row => labels(row)['com.docker.compose.volume'] === 'assistant-homes' || /(^|[-_])assistant-homes$/.test(String(row?.Name ?? ''));
  const claimed = row => Object.keys(labels(row)).some(label => label === 'com.docker.compose.volume' || label.startsWith('department.bot.'));
  const outside = rows.filter(row => !home(row) && !claimed(row)), homes = rows.filter(home);
  return { volumes: { count: outside.length, bytes: measuredBytes(outside, row => row?.UsageData?.Size) },
    assistant_homes: homes.length ? { bytes: measuredBytes(homes, row => row?.UsageData?.Size) } : null };
}
