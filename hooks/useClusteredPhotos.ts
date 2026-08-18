'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { compareByCapturedAt, type PhotoEntry } from '@/hooks/usePhotos'
import type { PhotoMetrics } from '@/lib/perceptual-hash'
import {
  buildDendrogram,
  cutDendrogram,
  hashToVector,
  l2Normalize,
  MAX_DISTANCE_THRESHOLD,
  type Cluster,
  type PhotoHashInput,
} from '@/lib/photo-clustering'

/**
 * Maps the UI's 0-100% similarity slider onto the raw cosine-distance
 * threshold (0.0-`MAX_DISTANCE_THRESHOLD`) `cutDendrogram` expects. Kept in
 * this hook (not the slider's own component) because the hook's public
 * contract takes `similarityPercent`, not a raw distance — the component
 * owns the slider's min/max/default UI concerns, this hook only owns turning
 * whatever percent it's given into clustering math.
 */
function percentToDistanceThreshold(percent: number): number {
  return (percent / 100) * MAX_DISTANCE_THRESHOLD
}

// How long `hashInputs` must stay unchanged before the expensive dendrogram
// build (below) re-runs on it. `usePhotoMetrics` commits a new metrics Map
// after every 5-photo chunk resolves, which otherwise gives `hashInputs` a
// new identity roughly that often during a large import -- rebuilding the
// full O(n^3)-ish dendrogram on every one of those ticks instead of once.
const DENDROGRAM_REBUILD_DEBOUNCE_MS = 200

/**
 * Returns `value`, but only updates to a new value after it has stayed the
 * same reference for `delayMs` -- except the very first value, which
 * commits immediately (so mounting onto an already-settled batch, the
 * common case, shows clusters right away instead of behind a fixed delay).
 * Used to decouple the expensive dendrogram build from every individual
 * metrics-arrival tick during an in-progress import; the cheap per-tick cut
 * (`cutDendrogram`) still runs on the live, undebounced value.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  const isFirstRef = useRef(true)

  useEffect(() => {
    // `useState(value)` above already seeded `debounced` with the initial
    // value at mount time, so the first effect run has nothing to commit --
    // only later changes need debouncing.
    if (isFirstRef.current) {
      isFirstRef.current = false
      return
    }
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}

/**
 * A stable, content-derived identity for a cluster: the sorted-and-joined
 * member id list. `cutDendrogram` reassigns `cluster.id` as `cluster-${N}`
 * fresh on every call, purely from union-find discovery order — as metrics
 * resolve asynchronously, the similarity slider moves, or a delete shrinks
 * the batch, a given index can end up pointing at a completely different
 * real-world group of photos than it did on a prior render. Using
 * `cluster.id` as a React key or a selection-state map key would let a
 * stale selection from one cluster silently attach to an unrelated cluster
 * that later inherits the same index. This key is order-independent (sorts
 * before joining), so reordering a cluster's `members` for display never
 * changes its key.
 */
export function clusterKey(cluster: Cluster): string {
  return [...cluster.members].sort().join(',')
}

/**
 * Earliest `capturedAt` (in ms) among a cluster's members — the position a
 * cluster's card takes in the grid. Null timestamps are excluded from the
 * min and the result falls back to `Infinity` when every member is null,
 * mirroring `hooks/usePhotos.ts`'s `sortPhotos` null-last convention, so an
 * all-null cluster sorts after every dated cluster. For a single
 * (unclustered) photo — a one-member "cluster" — this is just that photo's
 * own `capturedAt`, so it sorts at exactly the position it already holds in
 * the `photos` prop; changing the similarity threshold never moves a photo
 * whose own cluster membership didn't change.
 *
 * Exported (alongside `clusterKey`) for `components/PhotoGrid.tsx`'s
 * day-boundary-header pass: it's the same "what day does this cluster's
 * earliest member fall on" anchor value this hook already computes for
 * ordering, so the day-bucketing pass reuses it instead of recomputing an
 * equivalent value from scratch. This is the ONLY change day-grouping makes
 * to this hook — see the day-grouping unit's plan notes: `renderBlocks`'s
 * shape, the `ClusterRenderBlock` union, and `visualOrder` are all
 * deliberately untouched, so day headers can never affect what
 * drag-and-drop resolves against.
 */
export function earliestCapturedAtMs(cluster: Cluster, photosById: Map<string, PhotoEntry>): number {
  let earliest = Infinity
  for (const id of cluster.members) {
    const capturedAt = photosById.get(id)?.capturedAt ?? null
    if (capturedAt === null) continue
    earliest = Math.min(earliest, capturedAt.getTime())
  }
  return earliest
}

/**
 * Sorts a cluster's members chronologically by `capturedAt`, reusing
 * `hooks/usePhotos.ts`'s `compareByCapturedAt` (a null `capturedAt` sorts
 * after every dated photo; ties, including all-null ties, break by
 * `uploadIndex`) so this hook can't silently drift from `sortPhotos`'s
 * ordering rule.
 *
 * Every member id is guaranteed to resolve via `photosById`: `rawClusters`
 * is built from `hashInputs`, which is itself `photos.map(...)`, so a
 * cluster member can never reference an id absent from `photos`
 * (`cutDendrogram` never invents ids — see `lib/photo-clustering.test.ts`'s
 * "ignores a merge referencing an id no longer in the current photo set"
 * guard).
 *
 * Deliberately NOT `hierarchicalOrder` (`lib/photo-clustering.ts`'s
 * similarity-based ordering, which the old `ClusterView.tsx` used) — once
 * cluster members become drag targets in a later unit, a similarity-ordered
 * visual sequence would diverge from the chronologically-sorted `photos`
 * array `hooks/usePhotos.ts`'s `slotTimestamp` uses to compute a dropped
 * photo's new timestamp from its visually-adjacent neighbors, silently
 * corrupting that math. Chronological member order keeps visual order and
 * array order identical everywhere, inside a cluster included.
 */
function sortMembersChronologically(members: string[], photosById: Map<string, PhotoEntry>): string[] {
  return [...members].sort((idA, idB) => compareByCapturedAt(photosById.get(idA)!, photosById.get(idB)!))
}

/**
 * A cluster with only one member isn't a duplicate/near-duplicate of
 * anything and shouldn't visually read as a "cluster". Adjacent singletons
 * in the chronological sequence are bundled into one plain run so the
 * rendering layer can lay them out as ordinary grid cards with no cluster
 * chrome at all; a real (2+-member) cluster keeps its own section.
 */
export type ClusterRenderBlock = { type: 'cluster'; cluster: Cluster } | { type: 'singles'; clusters: Cluster[] }

export interface UseClusteredPhotosResult {
  /** Chronologically-ordered cluster sections and singleton runs, ready to render. */
  renderBlocks: ClusterRenderBlock[]
  /** L2-normalized perceptual-hash vector per photo with a resolved hash — reused by debug mode's pairwise-distance display. */
  vectorsById: Map<string, number[]>
  /** Per-photo hash (or `null` for in-flight/undecodable) fed into the clustering pipeline — reused by debug mode's hash display. */
  hashInputs: PhotoHashInput[]
  /** `photos` indexed by id — built once here and reused by consumers (e.g. `components/PhotoGrid.tsx`) instead of each rebuilding its own copy. */
  photosById: Map<string, PhotoEntry>
  /**
   * The exact flattened sequence of photo ids in the order `renderBlocks`
   * actually renders them — i.e. true DOM/visual order, not the flat,
   * purely-per-photo-chronological `photos` array order. A cluster's
   * members are NOT guaranteed to be array-contiguous in `photos` (a
   * cluster is grouped by hash similarity, not time, so an unrelated,
   * non-member photo captured in between two cluster members can still
   * land between them in `photos`), so consumers that need to resolve a
   * drag-and-drop's true visual neighbors (e.g.
   * `components/PhotoUploadPage.tsx`'s `handleDragEnd`) must use this,
   * not `photos.map((p) => p.id)`.
   */
  visualOrder: string[]
}

/**
 * Computes perceptual-hash clusters for a batch of photos and groups them
 * into chronologically-ordered render blocks (cluster sections and
 * singleton runs) — the pure computation half of what `components/
 * ClusterView.tsx` used to do inline, split out so it can be unit-tested
 * without rendering and reused by a future consumer without debug-mode UI
 * state (`debugMode`, `comparePair`) coming along for the ride. Mirrors
 * `hooks/usePhotoMetrics.ts`'s separation of computation from rendering.
 *
 * `similarityPercent` is a 0-100 value (see `percentToDistanceThreshold`);
 * the caller owns whatever slider or control produces it.
 */
export function useClusteredPhotos(
  photos: PhotoEntry[],
  metrics: Map<string, PhotoMetrics | undefined>,
  similarityPercent: number
): UseClusteredPhotosResult {
  const photosById = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos])
  const distanceThreshold = percentToDistanceThreshold(similarityPercent)

  // Hash inputs for the clustering pipeline, and L2-normalized vectors for
  // every photo with a resolved hash (reused by debug mode's pairwise
  // distance display).
  const hashInputs = useMemo<PhotoHashInput[]>(
    () =>
      photos.map((photo) => ({
        id: photo.id,
        // A photo whose metrics are still in flight (absent map entry, or
        // present-but-`undefined`) is treated the same as "no hash" — it
        // renders as a temporary singleton and re-clusters correctly once
        // its real hash lands and `metrics` updates.
        hash: metrics.get(photo.id)?.hash ?? null,
      })),
    [photos, metrics]
  )
  const vectorsById = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const { id, hash } of hashInputs) {
      if (hash !== null) map.set(id, l2Normalize(hashToVector(hash)))
    }
    return map
  }, [hashInputs])

  // The expensive O(n^3)-ish complete-linkage dendrogram build only
  // depends on the batch's hashes, not the similarity threshold — building
  // it once and cutting it cheaply (below) on every slider change is what
  // keeps live re-clustering responsive without a Web Worker at this app's
  // stated scale (~200+ photos). See lib/photo-clustering.ts's top comment.
  // Debounced separately from `hashInputs` itself: `usePhotoMetrics` gives
  // `hashInputs` a new identity roughly every 5 photos during a large
  // import, and without debouncing this build reran on every one of those
  // ticks instead of once. `cutDendrogram` below still cuts against the
  // live, undebounced `hashInputs` — a photo that resolves mid-debounce
  // just stays a temporary singleton (already the documented/tested
  // behavior for in-flight metrics) until the next debounced build catches
  // it up.
  const debouncedHashInputs = useDebouncedValue(hashInputs, DENDROGRAM_REBUILD_DEBOUNCE_MS)
  const dendrogram = useMemo(() => buildDendrogram(debouncedHashInputs), [debouncedHashInputs])

  // Cheap O(n) cut — safe to re-run on every threshold-slider tick, and on
  // every live (non-debounced) hashInputs change. cutDendrogram tolerates
  // `dendrogram` lagging behind `hashInputs` (a merge referencing an id no
  // longer present in the current batch is simply ignored).
  const rawClusters = useMemo(
    () => cutDendrogram(hashInputs, dendrogram, distanceThreshold),
    [hashInputs, dendrogram, distanceThreshold]
  )

  // Orders each cluster's own members chronologically (see
  // sortMembersChronologically), then places clusters — and single,
  // unclustered photos, which are just one-member clusters — in
  // chronological order by earliest member `capturedAt`. This is the app's
  // one ordering rule everywhere else (`hooks/usePhotos.ts`'s
  // `sortPhotos`), and critically means a photo's position never changes
  // when the similarity slider moves unless its own cluster membership
  // actually changes.
  const displayClusters = useMemo(() => {
    const reordered: Cluster[] = rawClusters.map((cluster) => ({
      id: cluster.id,
      members: sortMembersChronologically(cluster.members, photosById),
    }))

    return reordered.sort(
      (a, b) => earliestCapturedAtMs(a, photosById) - earliestCapturedAtMs(b, photosById)
    )
  }, [rawClusters, photosById])

  const renderBlocks = useMemo(() => {
    const blocks: ClusterRenderBlock[] = []
    for (const cluster of displayClusters) {
      if (cluster.members.length > 1) {
        blocks.push({ type: 'cluster', cluster })
        continue
      }
      const last = blocks[blocks.length - 1]
      if (last?.type === 'singles') last.clusters.push(cluster)
      else blocks.push({ type: 'singles', clusters: [cluster] })
    }
    return blocks
  }, [displayClusters])

  // The true flattened visual order `renderBlocks` renders in: for a
  // 'cluster' block, its members (already chronologically sorted within the
  // cluster, per sortMembersChronologically above); for a 'singles' block,
  // each single-member cluster's one member, in that block's chronological
  // clusters order. This is what dnd-kit's SortableContext needs for its
  // `items` (DOM-order-derived collision detection/animation), and what
  // handleDragEnd needs to resolve a drop's true visual neighbors instead of
  // `photos`' flat chronological neighbors, which can disagree whenever a
  // cluster isn't array-contiguous (see the interface doc above).
  const visualOrder = useMemo(() => {
    const order: string[] = []
    for (const block of renderBlocks) {
      if (block.type === 'cluster') {
        order.push(...block.cluster.members)
      } else {
        for (const cluster of block.clusters) order.push(cluster.members[0])
      }
    }
    return order
  }, [renderBlocks])

  return { renderBlocks, vectorsById, hashInputs, photosById, visualOrder }
}
