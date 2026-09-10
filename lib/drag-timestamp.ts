import { compareByCapturedAt } from '@/hooks/usePhotos'
import type { PhotoEntry } from '@/hooks/usePhotos'

/**
 * Computes `count` new timestamps for a whole dragged group dropped between
 * `prevTs` and `nextTs` — the group's TRUE final visual boundary neighbors
 * after the drop, not neighbors resolved from the flat, purely-chronological
 * `photos` array (which can disagree with visual order whenever a cluster
 * isn't array-contiguous; see `hooks/useClusteredPhotos.ts`'s `visualOrder`
 * doc). `handleDragEnd` below feeds it `effectiveGroupIds.length` for
 * `count` and zips the result 1:1 against `effectiveGroupIds`, which is
 * already in the group's pre-drag chronological order (`computeDragGroupIds`,
 * U1) — so index 0 of the returned array is the earliest-moving photo.
 *
 * N-item generalization (U3, KTD3) of the single-item algorithm
 * `hooks/usePhotos.ts`'s `slotTimestamp` (and this file's own prior
 * `computeDroppedTimestamp`) already used, generalizing its exact 3-branch
 * shape rather than inventing a new scheme:
 *
 * - Both boundaries present: evenly space `count` values strictly inside the
 *   open interval spanning `prevTs`/`nextTs` — `prevTs` is NOT assumed to be
 *   chronologically earlier than `nextTs` (a group drag's true visual
 *   boundary pair can be inverted, R6/R11), so the interval's low/high ends
 *   are resolved via `Math.min`/`Math.max` before spacing, keeping the
 *   output always strictly ascending regardless of which boundary is
 *   earlier (R5). Reduces to byte-identical output at `count === 1` (the
 *   single midpoint, which is order-independent). Because the values are
 *   strictly inside an open interval and evenly spaced, they come out
 *   distinct even when the interval is as tight as 1 second and `count` is
 *   10 or more (R7) — no special-casing needed.
 * - Only `prevTs` present ("moved to the end"): `count` values spaced 1
 *   second apart starting just after `prevTs`, preserving relative order —
 *   generalizing the single-item `prevTs + 1000ms` edge offset the same way
 *   `hooks/usePhotos.ts`'s `batchSetTimestamps` staggers its own per-id
 *   writes by `rank * 1000ms`.
 * - Only `nextTs` present ("moved to the start"): the mirror image, ending
 *   1 second before `nextTs`.
 * - Neither boundary present: returns `null` for every slot. Unlike the
 *   single-item version (which had a `currentCapturedAt` parameter to fall
 *   back to), this function has no per-item "current" value to return —
 *   `null` is a sentinel `handleDragEnd` resolves back to each photo's own
 *   existing `capturedAt`, which reproduces the exact same "keep as-is"
 *   end result.
 */
export function interpolateTimestamps(
  prevTs: Date | null,
  nextTs: Date | null,
  count: number
): (Date | null)[] {
  if (prevTs !== null && nextTs !== null) {
    // Direction-normalized: `prevTs`/`nextTs` are the group's true visual
    // boundary neighbors, which are NOT guaranteed to be chronologically
    // ascending -- a group drag can land between two neighbors whose
    // resolved capturedAt values are inverted (routine when the boundary
    // pair straddles a non-array-contiguous cluster, R6/R11). Interpolating
    // from `lo` to `hi` (rather than from `prevTs` to `nextTs` directly)
    // keeps the output strictly ascending regardless of which boundary is
    // chronologically earlier, so the group's pre-drag relative order (R5)
    // is never inverted by a negative `step`. Byte-identical to the naive
    // prevTs-to-nextTs computation at `count === 1` (a single midpoint is
    // order-independent).
    const lo = Math.min(prevTs.getTime(), nextTs.getTime())
    const hi = Math.max(prevTs.getTime(), nextTs.getTime())
    const step = (hi - lo) / (count + 1)
    return Array.from({ length: count }, (_, i) =>
      new Date(Math.round(lo + step * (i + 1)))
    )
  }
  if (prevTs !== null) {
    return Array.from({ length: count }, (_, i) => new Date(prevTs.getTime() + (i + 1) * 1000))
  }
  if (nextTs !== null) {
    return Array.from({ length: count }, (_, i) => new Date(nextTs.getTime() - (count - i) * 1000))
  }
  return Array(count).fill(null)
}

/**
 * Computes the frozen drag-group membership for a drag that just started
 * (U1, KTD1). Called exactly once, synchronously, from `handleDragStart`, and
 * its result is stored in `dragGroupIds` state rather than re-derived later —
 * so a selection change mid-drag (Esc, deselect) can't retroactively change
 * which photos move (R1/R2/R3).
 *
 * - If the dragged photo is itself part of a >=2-member selection (R1), the
 *   WHOLE selection moves together, ordered by current chronological order
 *   (`compareByCapturedAt`, `hooks/usePhotos.ts`) -- deliberately NOT `Set`
 *   iteration order, which is click/selection order and is exactly what R5
 *   says the post-drop relative order must NOT follow.
 * - Otherwise (dragging a photo outside the selection, R2; or 0/1 photos
 *   selected, R3) -- today's single-photo drag: only the dragged photo
 *   moves.
 *
 * Pure and side-effect-free: mutating the `selectedIds` Set passed in after
 * this returns has no effect on the array already returned (arrays are
 * returned by value, not as a live view over the Set).
 */
export function computeDragGroupIds(
  activeId: string,
  selectedIds: Set<string>,
  photos: PhotoEntry[]
): string[] {
  if (selectedIds.has(activeId) && selectedIds.size >= 2) {
    return photos
      .filter((p) => selectedIds.has(p.id))
      .sort(compareByCapturedAt)
      .map((p) => p.id)
  }
  return [activeId]
}
