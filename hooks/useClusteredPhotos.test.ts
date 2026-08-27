import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { ApiCluster, ClusterApiAvailability, UseClusterApiResult } from '@/hooks/useClusterApi'

// U3's own tests (hooks/useClusterApi.test.ts) already cover the network,
// debounce, health-gate, and race-safety layer — this file mocks
// useClusterApi entirely and only exercises the shaping logic downstream of
// it (chronological re-sort, render-block bundling, excluded-id synthesis).
const mockUseClusterApi = vi.fn<(photos: PhotoEntry[], similarityPercent: number) => UseClusterApiResult>()
vi.mock('@/hooks/useClusterApi', () => ({
  useClusterApi: (photos: PhotoEntry[], similarityPercent: number) => mockUseClusterApi(photos, similarityPercent),
}))

import { useClusteredPhotos } from './useClusteredPhotos'

afterEach(cleanup)

// --- test helpers -------------------------------------------------------

function makeEntry(id: string, name: string, capturedAt: string | null, uploadIndex: number): PhotoEntry {
  return {
    id,
    file: new File([], name, { type: 'image/jpeg' }),
    filename: name,
    capturedAt: capturedAt ? new Date(capturedAt) : null,
    uploadIndex,
    source: 'local',
  }
}

function apiResult(overrides: Partial<UseClusterApiResult> = {}): UseClusterApiResult {
  return {
    clusters: [],
    availability: 'available' as ClusterApiAvailability,
    isLoading: false,
    ...overrides,
  }
}

/** Flattens renderBlocks into a single ordered list of member-id arrays, one per block/cluster, for easy assertion. */
function memberIdsOf(block: ReturnType<typeof useClusteredPhotos>['renderBlocks'][number]): string[][] {
  if (block.type === 'cluster') return [block.cluster.members]
  return block.clusters.map((c) => c.members)
}

describe('useClusteredPhotos', () => {
  it('re-sorts an API cluster whose members arrive out of chronological order', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)

    // API returns the cluster's members in similarity order, not
    // chronological order — c first, then a, then b.
    mockUseClusterApi.mockReturnValue(
      apiResult({ clusters: [{ clusterIndex: 0, photoIds: ['c', 'a', 'b'] }] })
    )

    const { result } = renderHook(() => useClusteredPhotos([a, b, c], 40))

    expect(result.current.renderBlocks).toEqual([
      { type: 'cluster', cluster: { id: expect.any(String), members: ['a', 'b', 'c'] } },
    ])
  })

  it('renders a single-member API cluster as a plain grid card (no cluster chrome)', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)

    mockUseClusterApi.mockReturnValue(
      apiResult({
        clusters: [
          { clusterIndex: 0, photoIds: ['a'] },
          { clusterIndex: 1, photoIds: ['b'] },
        ],
      })
    )

    const { result } = renderHook(() => useClusteredPhotos([a, b], 40))

    expect(result.current.renderBlocks).toEqual([
      { type: 'singles', clusters: [expect.objectContaining({ members: ['a'] }), expect.objectContaining({ members: ['b'] })] },
    ])
  })

  it('produces visualOrder reflecting the true rendered DOM order for a mix of clusters and singles', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1) // paired with a
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2) // single
    const d = makeEntry('d', 'd.jpg', '2024-01-04T00:00:00Z', 3) // single
    const e = makeEntry('e', 'e.jpg', '2024-01-05T00:00:00Z', 4)
    const f = makeEntry('f', 'f.jpg', '2024-01-06T00:00:00Z', 5) // paired with e

    mockUseClusterApi.mockReturnValue(
      apiResult({
        clusters: [
          { clusterIndex: 0, photoIds: ['a', 'b'] },
          { clusterIndex: 1, photoIds: ['e', 'f'] },
        ],
      })
    )

    const { result } = renderHook(() => useClusteredPhotos([a, b, c, d, e, f], 40))

    expect(result.current.renderBlocks).toEqual([
      { type: 'cluster', cluster: { id: expect.any(String), members: ['a', 'b'] } },
      { type: 'singles', clusters: [expect.objectContaining({ members: ['c'] }), expect.objectContaining({ members: ['d'] })] },
      { type: 'cluster', cluster: { id: expect.any(String), members: ['e', 'f'] } },
    ])
    expect(result.current.visualOrder).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('keeps returning the previous renderBlocks while useClusterApi reports isLoading (R9)', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const clusters: ApiCluster[] = [{ clusterIndex: 0, photoIds: ['a', 'b'] }]

    // useClusterApi's own contract keeps `clusters` stable while a new
    // request is loading (KTD8) — this hook derives renderBlocks purely
    // from `clusters`, so the same passthrough should fall out naturally.
    mockUseClusterApi.mockReturnValue(apiResult({ clusters, isLoading: false }))
    const { result, rerender } = renderHook(() => useClusteredPhotos([a, b], 40))

    const before = result.current.renderBlocks
    expect(before).toEqual([{ type: 'cluster', cluster: { id: expect.any(String), members: ['a', 'b'] } }])

    mockUseClusterApi.mockReturnValue(apiResult({ clusters, isLoading: true }))
    rerender()

    expect(result.current.isLoading).toBe(true)
    expect(result.current.renderBlocks).toEqual(before)
  })

  it('returns a usable renderBlocks instead of throwing when availability is unavailable', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)

    mockUseClusterApi.mockReturnValue(
      apiResult({ clusters: [], availability: 'unavailable' })
    )

    let renderResult: ReturnType<typeof useClusteredPhotos> | undefined
    expect(() => {
      const { result } = renderHook(() => useClusteredPhotos([a, b], 40))
      renderResult = result.current
    }).not.toThrow()

    expect(renderResult!.availability).toBe('unavailable')
    // No clusters returned and nothing excluded -> both photos surface as
    // ordinary singletons, none dropped.
    expect(renderResult!.renderBlocks).toEqual([
      { type: 'singles', clusters: [expect.objectContaining({ members: ['a'] }), expect.objectContaining({ members: ['b'] })] },
    ])
  })

  it('keeps photosById and visualOrder correctly keyed after a photo is deleted mid-flight', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)

    // A stale response (from before the delete) can still reference 'b'
    // briefly per useClusterApi's stale-while-loading contract (KTD8) —
    // simulate that here directly, since the superseded-request mechanics
    // themselves are covered by hooks/useClusterApi.test.ts.
    mockUseClusterApi.mockReturnValue(
      apiResult({ clusters: [{ clusterIndex: 0, photoIds: ['a', 'b'] }], isLoading: true })
    )
    const { result, rerender } = renderHook(({ photos }) => useClusteredPhotos(photos, 40), {
      initialProps: { photos: [a, b] },
    })
    expect(result.current.photosById.has('b')).toBe(true)

    // 'b' is deleted; the mocked hook still (briefly) hands back the stale
    // cluster referencing 'b' — must not crash, and 'b' must not appear in
    // photosById/visualOrder any more since it's gone from `photos`.
    mockUseClusterApi.mockReturnValue(
      apiResult({ clusters: [{ clusterIndex: 0, photoIds: ['a', 'b'] }], isLoading: true })
    )
    expect(() => rerender({ photos: [a] })).not.toThrow()

    expect(result.current.photosById.has('b')).toBe(false)
    expect(result.current.visualOrder).toEqual(['a'])

    // Next request resolves, reflecting the new photo set.
    mockUseClusterApi.mockReturnValue(apiResult({ clusters: [], isLoading: false }))
    rerender({ photos: [a] })

    expect(result.current.photosById.has('b')).toBe(false)
    expect(result.current.visualOrder).toEqual(['a'])
  })

  it('renders an excluded photo id absent from every cluster as its own singleton at its normal chronological position (R15, R16)', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const excluded = makeEntry('excluded', 'excluded.jpg', '2024-01-02T00:00:00Z', 1)
    const b = makeEntry('b', 'b.jpg', '2024-01-03T00:00:00Z', 2)

    mockUseClusterApi.mockReturnValue(
      apiResult({
        clusters: [{ clusterIndex: 0, photoIds: ['a', 'b'] }],
      })
    )

    const { result } = renderHook(() => useClusteredPhotos([a, excluded, b], 40))

    // 'excluded' sits chronologically between a and b, and it wasn't
    // returned in any API cluster (a+b are a 2-member cluster, so they
    // render as a 'cluster' block, not 'singles') -- it must still render,
    // as its own singleton, in its normal chronological position (after the
    // a+b cluster block, which sorts first since a's capturedAt is earlier
    // than excluded's).
    expect(result.current.renderBlocks).toEqual([
      { type: 'cluster', cluster: { id: expect.any(String), members: ['a', 'b'] } },
      { type: 'singles', clusters: [expect.objectContaining({ members: ['excluded'] })] },
    ])
    expect(result.current.visualOrder).toEqual(['a', 'b', 'excluded'])
  })

  it('does not duplicate an excluded photo id that the API clusters still include (stale response)', () => {
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)

    // 'b' is reported excluded, but the (stale) clusters response still
    // includes it as part of the a+b cluster.
    mockUseClusterApi.mockReturnValue(
      apiResult({
        clusters: [{ clusterIndex: 0, photoIds: ['a', 'b'] }],
      })
    )

    const { result } = renderHook(() => useClusteredPhotos([a, b], 40))

    expect(result.current.renderBlocks).toEqual([
      { type: 'cluster', cluster: { id: expect.any(String), members: ['a', 'b'] } },
    ])
    // 'b' appears exactly once across the whole renderBlocks output.
    const allIds = result.current.renderBlocks.flatMap(memberIdsOf).flat()
    expect(allIds.filter((id) => id === 'b')).toHaveLength(1)
  })
})
