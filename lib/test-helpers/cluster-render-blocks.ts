// Shared test-fixture helpers for building `useClusteredPhotos`-shaped mock
// return values from a plain ordered list of groups, so tests can describe
// the exact render-block shape they want without going through real
// clustering/hashing at all -- used across components/PhotoGrid.test.tsx and
// components/PhotoUploadPage.test.tsx.

import type { PhotoEntry } from '@/hooks/usePhotos'
import type { ClusterRenderBlock, UseClusteredPhotosResult } from '@/hooks/useClusteredPhotos'

/**
 * Builds `renderBlocks` the same way the real `useClusteredPhotos` does
 * (adjacent single-member "clusters" bundled into one `'singles'` block,
 * any 2+-member group standing alone as a `'cluster'` block) from a plain
 * ordered list of groups — each group either one id (a singleton) or
 * several (a cluster).
 */
export function buildRenderBlocks(groups: string[][]): ClusterRenderBlock[] {
  const blocks: ClusterRenderBlock[] = []
  for (const members of groups) {
    if (members.length > 1) {
      blocks.push({ type: 'cluster', cluster: { id: `cluster-${members.join('-')}`, members } })
      continue
    }
    const single = { id: `single-${members[0]}`, members }
    const last = blocks[blocks.length - 1]
    if (last?.type === 'singles') last.clusters.push(single)
    else blocks.push({ type: 'singles', clusters: [single] })
  }
  return blocks
}

/** Builds a full `UseClusteredPhotosResult` mock return value from `photos` and a `groups` shape (see `buildRenderBlocks`). */
export function clusteredResult(
  photos: PhotoEntry[],
  groups: string[][],
  overrides: Partial<UseClusteredPhotosResult> = {}
): UseClusteredPhotosResult {
  const photosById = new Map(photos.map((p) => [p.id, p]))
  const renderBlocks = buildRenderBlocks(groups)
  const visualOrder = renderBlocks.flatMap((block) =>
    block.type === 'cluster' ? block.cluster.members : block.clusters.map((c) => c.members[0])
  )
  return {
    renderBlocks,
    photosById,
    visualOrder,
    availability: 'available',
    isLoading: false,
    ...overrides,
  }
}

/** Shorthand for the common "no clusters, every photo a plain singleton" shape. */
export function flatResult(photos: PhotoEntry[], overrides: Partial<UseClusteredPhotosResult> = {}): UseClusteredPhotosResult {
  return clusteredResult(
    photos,
    photos.map((p) => [p.id]),
    overrides
  )
}
