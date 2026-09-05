/**
 * Pure "keep the best photo" logic: reading a photo's pixel dimensions and
 * picking a winner among interchangeable candidates by resolution, with file
 * size and upload order as tiebreakers. No UI coupling — see
 * components/consumers for how this is wired into the picker action.
 */

import { withTimeout, DECODE_TIMEOUT_MS } from './generate-thumbnail'

/**
 * Decodes `file` via `createImageBitmap` to read its pixel dimensions.
 * Reuses `generate-thumbnail.ts`'s decode-timeout guard so a pathological
 * file can't hang this the same way it can't hang thumbnail generation.
 * Never throws: any decode failure or timeout degrades to
 * `{ width: 0, height: 0 }` so a single bad photo doesn't block comparing
 * the rest of the selected batch (the photo itself is still included in the
 * comparison, unlike `generateThumbnail`'s own contract, where callers
 * exclude a failed decode from the request entirely).
 */
export async function getPhotoDimensions(file: File): Promise<{ width: number; height: number }> {
  let bitmap: ImageBitmap
  try {
    bitmap = await withTimeout(
      createImageBitmap(file, { imageOrientation: 'from-image' }),
      DECODE_TIMEOUT_MS,
      'createImageBitmap timed out decoding file'
    )
  } catch {
    return { width: 0, height: 0 }
  }

  try {
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}

export type PhotoQualityCandidate = {
  id: string
  width: number
  height: number
  size: number
  uploadIndex: number
}

/**
 * Three-tier cascade comparator: resolution (width * height), then file
 * size, then `uploadIndex` (lower — added earlier — wins). Mirrors the shape
 * of `hooks/usePhotos.ts`'s `compareByCapturedAt`. Callers must pass 2+
 * candidates; this is not a defensive concern of this function.
 */
export function pickBestPhoto(
  candidates: PhotoQualityCandidate[]
): { winnerId: string; loserIds: string[] } {
  function compare(a: PhotoQualityCandidate, b: PhotoQualityCandidate): number {
    const resolutionDiff = a.width * a.height - (b.width * b.height)
    if (resolutionDiff !== 0) return resolutionDiff
    const sizeDiff = a.size - b.size
    if (sizeDiff !== 0) return sizeDiff
    return b.uploadIndex - a.uploadIndex
  }

  const winner = candidates.reduce((best, candidate) =>
    compare(candidate, best) > 0 ? candidate : best
  )

  return {
    winnerId: winner.id,
    loserIds: candidates.filter((c) => c.id !== winner.id).map((c) => c.id),
  }
}
