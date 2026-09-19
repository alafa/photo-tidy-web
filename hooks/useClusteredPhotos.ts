'use client'

import { useMemo } from 'react'
import { compareByCapturedAt, type PhotoEntry } from '@/hooks/usePhotos'
import { useClusterApi, type ClusterApiAvailability } from '@/hooks/useClusterApi'

/**
 * A cluster of photo ids, in the shape this hook works with internally.
 * Built from `useClusterApi`'s `{clusterIndex, photoIds}` shape (renamed to
 * `members` here) plus one-member clusters synthesized for every photo not
 * covered by a returned cluster (see `useClusteredPhotos` below) — kept
 * local to this file rather than imported from the now-removed local
 * clustering module, since nothing else this file needs comes from there
 * anymore.
 */
export interface Cluster {
  id: string
  members: string[]
}

/**
 * A stable, content-derived identity for a cluster: the sorted-and-joined
 * member id list. A cluster's synthetic `id` (either `cluster-${clusterIndex}`
 * from the API or `single-${photoId}` for a synthesized singleton — see
 * below) is not stable across re-clusters: as the API recomputes clusters at
 * a new threshold or the photo set changes, a given index/id can end up
 * pointing at a completely different real-world group of photos than it did
 * on a prior render. Using that raw `id` as a React key or a selection-state
 * map key would let a stale selection from one cluster silently attach to an
 * unrelated cluster that later inherits the same id. This key is
 * order-independent (sorts before joining), so reordering a cluster's
 * `members` for display never changes its key.
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
  return capturedAtBoundsMs(cluster, photosById).earliestMs
}

/**
 * Latest `capturedAt` (in ms) among a cluster's members — the counterpart to
 * `earliestCapturedAtMs` above, used to establish a cluster's own temporal
 * span for the non-contiguous-cluster check below. Null timestamps are
 * excluded from the max, and the result falls back to `-Infinity` when every
 * member is null, mirroring `earliestCapturedAtMs`'s `Infinity` fallback (so
 * an all-null cluster never produces a finite, checkable interval).
 */
export function latestCapturedAtMs(cluster: Cluster, photosById: Map<string, PhotoEntry>): number {
  return capturedAtBoundsMs(cluster, photosById).latestMs
}

/**
 * Shared single-pass implementation behind `earliestCapturedAtMs` and
 * `latestCapturedAtMs` above: one loop over `cluster.members` computing both
 * bounds at once (instead of two separate loops), since the non-contiguous-
 * cluster check below needs both per cluster. Not exported — external
 * callers that only need one bound keep using the named single-value
 * functions above.
 */
function capturedAtBoundsMs(
  cluster: Cluster,
  photosById: Map<string, PhotoEntry>
): { earliestMs: number; latestMs: number } {
  let earliestMs = Infinity
  let latestMs = -Infinity
  for (const id of cluster.members) {
    const capturedAt = photosById.get(id)?.capturedAt ?? null
    if (capturedAt === null) continue
    const ms = capturedAt.getTime()
    earliestMs = Math.min(earliestMs, ms)
    latestMs = Math.max(latestMs, ms)
  }
  return { earliestMs, latestMs }
}

/**
 * Sorts a cluster's members chronologically by `capturedAt`, reusing
 * `hooks/usePhotos.ts`'s `compareByCapturedAt` (a null `capturedAt` sorts
 * after every dated photo; ties, including all-null ties, break by
 * `uploadIndex`) so this hook can't silently drift from `sortPhotos`'s
 * ordering rule.
 *
 * Deliberately NOT the API's own member ordering (similarity-based) — once
 * cluster members become drag targets, a similarity-ordered visual sequence
 * would diverge from the chronologically-sorted `photos` array
 * `hooks/usePhotos.ts`'s `slotTimestamp` uses to compute a dropped photo's
 * new timestamp from its visually-adjacent neighbors, silently corrupting
 * that math. Chronological member order keeps visual order and array order
 * identical everywhere, inside a cluster included.
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
  /** `photos` indexed by id — built once here and reused by consumers (e.g. `components/PhotoGrid.tsx`) instead of each rebuilding its own copy. */
  photosById: Map<string, PhotoEntry>
  /**
   * The exact flattened sequence of photo ids in the order `renderBlocks`
   * actually renders them — i.e. true DOM/visual order, not the flat,
   * purely-per-photo-chronological `photos` array order. A cluster's
   * members are NOT guaranteed to be array-contiguous in `photos` (a
   * cluster is grouped by API similarity, not time, so an unrelated,
   * non-member photo captured in between two cluster members can still
   * land between them in `photos`), so consumers that need to resolve a
   * drag-and-drop's true visual neighbors (e.g.
   * `components/PhotoUploadPage.tsx`'s `handleDragEnd`) must use this,
   * not `photos.map((p) => p.id)`.
   */
  visualOrder: string[]
  /** Passed through from `useClusterApi` — see `hooks/useClusterApi.ts`'s `ClusterApiAvailability` doc. */
  availability: ClusterApiAvailability
  /** Passed through from `useClusterApi` — true while a cluster request (including its per-photo-rejection retry) is in flight. `renderBlocks` still reflects the last successful result while this is true (R9). */
  isLoading: boolean
  /**
   * Every member id belonging to a temporally non-contiguous cluster: a 2+
   * member cluster where some other photo outside the cluster has a
   * non-null `capturedAt` strictly between the cluster's own earliest and
   * latest member `capturedAt` (both endpoints excluded) — usually a sign
   * one of those timestamps is wrong. A `Set` rather than a per-cluster
   * boolean map, since the only thing a consumer needs is an O(1) "is my own
   * id flagged" membership check.
   */
  nonContiguousMemberIds: Set<string>
}

/**
 * Fetches similarity clusters for a batch of photos from photo-tidy-api (via
 * `useClusterApi`) and groups them into chronologically-ordered render
 * blocks (cluster sections and singleton runs) — the pure computation half
 * of what `components/PhotoGrid.tsx` renders. Mirrors the previous
 * local-clustering version of this hook's separation of computation from
 * rendering; only the clustering *source* changed (API call instead of a
 * client-side dendrogram).
 *
 * `similarityPercent` is a 0-100 value; the caller owns whatever slider or
 * control produces it. `useClusterApi` maps it onto the API's 0.0-0.5
 * threshold and owns the health gate, debouncing, and race-safety.
 */
export function useClusteredPhotos(photos: PhotoEntry[], similarityPercent: number): UseClusteredPhotosResult {
  const photosById = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos])

  const { clusters: apiClusters, availability, isLoading } = useClusterApi(photos, similarityPercent)

  // Maps the API's `{clusterIndex, photoIds}` clusters into this file's
  // internal `Cluster{id, members}` shape, then synthesizes a one-member
  // `Cluster` for every photo NOT covered by any returned cluster, so it
  // still renders as an ordinary singleton instead of silently vanishing
  // from the grid. This single "cover every photo" rule handles several
  // cases uniformly:
  //  - R15/R16/KTD12: a photo excluded from the request (thumbnail failure,
  //    or a per-photo API rejection) was never sent, so it can never appear
  //    in `apiClusters` and is always picked up here.
  //  - R5: at 0% similarity (or before any cluster call has ever
  //    succeeded), `apiClusters` is empty and every photo renders as its
  //    own ungrouped singleton, matching "render photos ungrouped."
  //  - Mirrors the old local-clustering version's guarantee (there,
  //    `cutDendrogram` always assigned every photo to at least a
  //    single-member cluster) so this hook's full-coverage invariant is
  //    unchanged by the clustering-source swap.
  // Member ids not present in the current `photos` batch are dropped (and a
  // cluster left with zero members is dropped entirely) rather than
  // crashing `sortMembersChronologically` below — `useClusterApi` can hand
  // back a stale `clusters` value (KTD8's stale-while-loading) referencing a
  // photo id no longer in `photos` after a delete, briefly, until its next
  // request (reflecting the new `photos`) supersedes it.
  const rawClusters = useMemo<Cluster[]>(() => {
    const fromApi: Cluster[] = apiClusters
      .map((cluster) => ({
        id: `cluster-${cluster.clusterIndex}`,
        members: cluster.photoIds.filter((id) => photosById.has(id)),
      }))
      .filter((cluster) => cluster.members.length > 0)

    const coveredIds = new Set(fromApi.flatMap((cluster) => cluster.members))

    const singles: Cluster[] = []
    for (const photo of photos) {
      if (coveredIds.has(photo.id)) continue
      singles.push({ id: `single-${photo.id}`, members: [photo.id] })
    }

    return [...fromApi, ...singles]
  }, [apiClusters, photos, photosById])

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

  // Every member id belonging to a temporally non-contiguous cluster (R1-R4,
  // KTD1-KTD4): a 2+-member cluster where some photo outside it has a
  // non-null capturedAt strictly between the cluster's own earliest and
  // latest member capturedAt (open interval — KTD2's boundary ties don't
  // count). Walks the already-globally-sorted `photos` array (ascending by
  // capturedAt, nulls last — see hooks/usePhotos.ts's
  // sortPhotos/compareByCapturedAt) instead of comparing every cluster
  // against every other photo pairwise: since `photos` is sorted, every
  // photo whose timestamp falls in a cluster's open interval forms one
  // contiguous slice of `sortedDated`, located here via a binary search for
  // the interval's lower bound rather than a full per-cluster scan.
  const nonContiguousMemberIds = useMemo(() => {
    const sortedDated = photos.filter((p) => p.capturedAt !== null)
    const flagged = new Set<string>()

    for (const cluster of displayClusters) {
      if (cluster.members.length < 2) continue

      const { earliestMs: earliest, latestMs: latest } = capturedAtBoundsMs(cluster, photosById)
      if (!Number.isFinite(earliest) || !Number.isFinite(latest)) continue

      const memberSet = new Set(cluster.members)

      // Binary search for the first entry strictly greater than `earliest`
      // — the start of the cluster's open interval slice.
      let lo = 0
      let hi = sortedDated.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (sortedDated[mid].capturedAt!.getTime() <= earliest) lo = mid + 1
        else hi = mid
      }

      let isNonContiguous = false
      for (let i = lo; i < sortedDated.length; i++) {
        const ts = sortedDated[i].capturedAt!.getTime()
        if (ts >= latest) break
        if (!memberSet.has(sortedDated[i].id)) {
          isNonContiguous = true
          break
        }
      }

      if (isNonContiguous) {
        for (const id of cluster.members) flagged.add(id)
      }
    }

    return flagged
  }, [displayClusters, photos, photosById])

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

  return { renderBlocks, photosById, visualOrder, availability, isLoading, nonContiguousMemberIds }
}
