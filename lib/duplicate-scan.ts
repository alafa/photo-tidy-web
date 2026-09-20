/**
 * Pure exact-duplicate-scan logic: a one-shot `POST /api/cluster` call at
 * threshold 0.0 across the whole loaded batch, no UI coupling. Reuses
 * `hooks/useClusterApi.ts`'s `postCluster` for request-building rather than
 * duplicating it or reimplementing the live hook's debounce/generation-token/
 * health-gate machinery, none of which applies to a one-shot call.
 */

import type { PhotoEntry } from '@/hooks/usePhotos'
import { postCluster } from '@/hooks/useClusterApi'
import { generateThumbnail } from './generate-thumbnail'
import { chunkArray } from './chunk-array'

// Fixed-size concurrency bound for whole-batch thumbnail generation, the
// same bounded shape `components/PhotoUploadPage.tsx`'s
// `decodeDimensionsWithConcurrency` already uses via `chunkArray` — not an
// unbounded `Promise.all` across the whole batch. A one-shot, uncached,
// whole-batch call like this one is heavier than `useClusterApi`'s own
// incremental, cache-hit-skipping case, so that hook's unbounded
// `Promise.all` (over only the *pending*, uncached subset) isn't a
// precedent this can lean on.
const THUMBNAIL_CONCURRENCY = 5

// R3/R5: exact-duplicate detection is photo-tidy-api's clustering mechanism
// at its strictest setting — no fuzzy/near-duplicate tolerance, ever.
const EXACT_DUPLICATE_THRESHOLD = 0.0

export type DuplicateScanResult = { ok: true; groups: string[][] } | { ok: false }

/**
 * Scans `photos` for exact-duplicate groups via a one-shot
 * `POST /api/cluster` request at threshold 0.0 (R3, R5).
 *
 * Generates a thumbnail per photo in bounded-concurrency batches, excludes
 * any photo whose thumbnail generation failed (`generateThumbnail` never
 * throws — it degrades to `null` on decode failure), then calls
 * `postCluster`. A single-photo-rejection failure retries once with that
 * photo also excluded (mirroring `useClusterApi`'s own retry, minus its
 * generation-token concept — there's nothing to supersede a one-shot call).
 * Any other failure, or `postCluster` itself throwing (a network error),
 * resolves `{ ok: false }` rather than rejecting.
 *
 * On success, only clusters of 2+ members count as duplicate groups (R4) —
 * a single-member cluster is dropped here, not left for the caller to
 * filter.
 */
export async function scanForExactDuplicateGroups(photos: PhotoEntry[]): Promise<DuplicateScanResult> {
  const thumbnailsByFile = new Map<File, string | null>()
  for (const batch of chunkArray(photos, THUMBNAIL_CONCURRENCY)) {
    const results = await Promise.all(
      batch.map(async (p) => ({ file: p.file, thumbnail: await generateThumbnail(p.file) })),
    )
    for (const { file, thumbnail } of results) {
      thumbnailsByFile.set(file, thumbnail)
    }
  }

  const excludeIds = new Set<string>()
  for (const p of photos) {
    if (thumbnailsByFile.get(p.file) === null) excludeIds.add(p.id)
  }

  let result
  try {
    result = await postCluster(photos, excludeIds, thumbnailsByFile, EXACT_DUPLICATE_THRESHOLD)
  } catch {
    return { ok: false }
  }

  if (!result.ok && result.rejectedId !== null) {
    excludeIds.add(result.rejectedId)
    try {
      result = await postCluster(photos, excludeIds, thumbnailsByFile, EXACT_DUPLICATE_THRESHOLD)
    } catch {
      return { ok: false }
    }
  }

  if (!result.ok) return { ok: false }

  return {
    ok: true,
    groups: result.clusters.filter((c) => c.photoIds.length >= 2).map((c) => c.photoIds),
  }
}
