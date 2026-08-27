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
interface Cluster {
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
 */
function earliestCapturedAtMs(cluster: Cluster, photosById: Map<string, PhotoEntry>): number {
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

  return { renderBlocks, photosById, visualOrder, availability, isLoading }
}
