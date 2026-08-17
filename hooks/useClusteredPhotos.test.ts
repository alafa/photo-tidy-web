import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, cleanup, act } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { PhotoMetrics } from '@/lib/perceptual-hash'
import { range, makeHashFromPositions } from '@/lib/test-helpers/hash-fixtures'

// Spies on the real buildDendrogram (all other exports pass through
// unmocked) so the debounce test below can count how many times the
// expensive build actually ran, without faking the clustering math itself.
// Same technique components/ClusterView.test.tsx already uses.
vi.mock('@/lib/photo-clustering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/photo-clustering')>()
  return { ...actual, buildDendrogram: vi.fn(actual.buildDendrogram) }
})
import { buildDendrogram } from '@/lib/photo-clustering'
const mockBuildDendrogram = vi.mocked(buildDendrogram)

import { useClusteredPhotos } from './useClusteredPhotos'

afterEach(cleanup)

// --- test helpers -------------------------------------------------------
//
// Hashes are built from explicit "on" bit positions (not raw hex literals)
// so cosine distances between fixtures are exactly predictable by hand —
// same technique as lib/photo-clustering.test.ts and
// components/ClusterView.test.tsx. This matters here because an all-zero
// hash is a *zero vector*, and cosineDistance special-cases zero vectors (0
// vs. another zero is "identical", 0 vs. anything non-zero is "maximally
// distant") rather than reflecting bit overlap — a trap for hand-picked hex
// literals meant to encode a specific Hamming distance.

const HASH_TOTAL_BITS = 128

const hashFromPositions = makeHashFromPositions(HASH_TOTAL_BITS)

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

function makeMetrics(hash: string | null, width = 100, height = 100, size = 1000): PhotoMetrics {
  return { width, height, size, hash }
}

/** Flattens renderBlocks into a single ordered list of member-id arrays, one per block/cluster, for easy assertion. */
function memberIdsOf(block: ReturnType<typeof useClusteredPhotos>['renderBlocks'][number]): string[][] {
  if (block.type === 'cluster') return [block.cluster.members]
  return block.clusters.map((c) => c.members)
}

describe('useClusteredPhotos', () => {
  it('clusters an exact-duplicate pair at 0% similarity and leaves the rest as singletons', () => {
    const p1 = makeEntry('p1', 'p1.jpg', '2024-01-01T00:00:00Z', 0)
    const p2 = makeEntry('p2', 'p2.jpg', '2024-01-02T00:00:00Z', 1) // identical hash to p1
    const p3 = makeEntry('p3', 'p3.jpg', '2024-01-03T00:00:00Z', 2)
    const p4 = makeEntry('p4', 'p4.jpg', '2024-01-04T00:00:00Z', 3)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['p1', makeMetrics(hashFromPositions(range(0, 9)))],
      ['p2', makeMetrics(hashFromPositions(range(0, 9)))], // identical to p1: distance 0
      ['p3', makeMetrics(hashFromPositions(range(30, 39)))], // orthogonal to everything
      ['p4', makeMetrics(hashFromPositions(range(60, 69)))], // orthogonal to everything
    ])

    const { result } = renderHook(() => useClusteredPhotos([p1, p2, p3, p4], metrics, 0))

    expect(result.current.renderBlocks).toEqual([
      { type: 'cluster', cluster: { id: expect.any(String), members: ['p1', 'p2'] } },
      { type: 'singles', clusters: [expect.objectContaining({ members: ['p3'] }), expect.objectContaining({ members: ['p4'] })] },
    ])
  })

  it('raises similarityPercent to produce more/larger clusters without rebuilding the dendrogram again', () => {
    mockBuildDendrogram.mockClear()

    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1) // distance to a: 0.3
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(hashFromPositions(range(0, 9)))],
      ['b', makeMetrics(hashFromPositions(range(3, 12)))],
    ])

    const { result, rerender } = renderHook(
      ({ similarityPercent }) => useClusteredPhotos([a, b], metrics, similarityPercent),
      { initialProps: { similarityPercent: 0 } }
    )

    // 0% (threshold 0.0) is too strict for the 0.3-distance pair.
    expect(result.current.renderBlocks).toEqual([{ type: 'singles', clusters: [expect.anything(), expect.anything()] }])
    expect(mockBuildDendrogram).toHaveBeenCalledTimes(1)

    // 70% maps to threshold 0.35 — loose enough to merge a/b. Only
    // `similarityPercent` changes here; `photos`/`metrics` keep the same
    // reference, so `hashInputs` is unchanged and the expensive dendrogram
    // build must not re-run — only the cheap cut re-runs.
    rerender({ similarityPercent: 70 })

    expect(result.current.renderBlocks).toEqual([
      { type: 'cluster', cluster: { id: expect.any(String), members: ['a', 'b'] } },
    ])
    expect(mockBuildDendrogram).toHaveBeenCalledTimes(1)
  })

  it('orders a cluster\'s members chronologically by capturedAt, not by mutual similarity', () => {
    // a and c are hash-identical; b is a moderate outlier that still falls
    // within the default threshold. Input order is [a, b, c] with b the
    // chronological middle. Similarity ordering (the old ClusterView
    // behavior) would surface the outlier b first (see
    // lib/photo-clustering.ts's hierarchicalOrder / the old
    // ClusterView.test.tsx reorder test) — this hook must NOT do that: it
    // must preserve chronological order [a, b, c] instead.
    const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
    const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
    const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a', makeMetrics(hashFromPositions(range(0, 9)))],
      ['b', makeMetrics(hashFromPositions(range(2, 11)))], // distance to a and c: 0.2
      ['c', makeMetrics(hashFromPositions(range(0, 9)))], // identical to a
    ])

    const { result } = renderHook(() => useClusteredPhotos([a, b, c], metrics, 40))

    expect(result.current.renderBlocks).toEqual([
      { type: 'cluster', cluster: { id: expect.any(String), members: ['a', 'b', 'c'] } },
    ])
  })

  it('sorts a cluster whose members all have a null capturedAt after a dated cluster', () => {
    const dated1 = makeEntry('dated1', 'dated1.jpg', '2024-06-01T00:00:00Z', 0)
    const dated2 = makeEntry('dated2', 'dated2.jpg', '2024-06-02T00:00:00Z', 1) // identical hash to dated1
    const null1 = makeEntry('null1', 'null1.jpg', null, 2)
    const null2 = makeEntry('null2', 'null2.jpg', null, 3) // identical hash to null1, orthogonal to dated1/dated2

    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['dated1', makeMetrics(hashFromPositions(range(0, 9)))],
      ['dated2', makeMetrics(hashFromPositions(range(0, 9)))],
      ['null1', makeMetrics(hashFromPositions(range(60, 69)))],
      ['null2', makeMetrics(hashFromPositions(range(60, 69)))],
    ])

    // Deliberately pass the all-null cluster's photos FIRST in the input
    // array — the assertion below only holds if ordering is driven by
    // earliestCapturedAtMs's Infinity fallback, not by input/array order.
    const { result } = renderHook(() => useClusteredPhotos([null1, null2, dated1, dated2], metrics, 0))

    expect(result.current.renderBlocks).toEqual([
      { type: 'cluster', cluster: { id: expect.any(String), members: ['dated1', 'dated2'] } },
      { type: 'cluster', cluster: { id: expect.any(String), members: ['null1', 'null2'] } },
    ])
  })

  it('renders photos with in-flight metrics (absent or undefined map entry) as temporary singletons instead of crashing or being dropped', () => {
    const resolved = makeEntry('resolved', 'resolved.jpg', '2024-01-01T00:00:00Z', 0)
    const stillComputing = makeEntry('pending', 'pending.jpg', '2024-01-02T00:00:00Z', 1)
    const neverInMap = makeEntry('absent', 'absent.jpg', '2024-01-03T00:00:00Z', 2)

    // 'pending' is present with an explicit `undefined` value; 'absent' has
    // no entry in the map at all — both mean "hash not resolved yet".
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['resolved', makeMetrics(hashFromPositions(range(0, 9)))],
      ['pending', undefined],
    ])

    let renderResult: ReturnType<typeof useClusteredPhotos> | undefined
    expect(() => {
      const { result } = renderHook(() =>
        useClusteredPhotos([resolved, stillComputing, neverInMap], metrics, 40)
      )
      renderResult = result.current
    }).not.toThrow()

    expect(renderResult).toBeDefined()
    const blocks = renderResult!.renderBlocks
    // None of the three share a resolved hash, so nothing clusters — all
    // three surface as singles, none dropped from the output.
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('singles')
    expect(memberIdsOf(blocks[0]).flat()).toEqual(['resolved', 'pending', 'absent'])

    // hashInputs still carries an entry (with a null hash) for every photo,
    // including the one entirely absent from `metrics`.
    expect(renderResult!.hashInputs).toEqual([
      { id: 'resolved', hash: hashFromPositions(range(0, 9)) },
      { id: 'pending', hash: null },
      { id: 'absent', hash: null },
    ])
  })

  it('debounces the expensive dendrogram rebuild across rapid metrics-arrival ticks instead of rebuilding on every one', () => {
    // Mirrors usePhotoMetrics's own shape: a new metrics Map identity lands
    // every ~5-photo chunk during an import. Without debouncing, each of
    // these ticks re-triggers the full O(n^3)-ish dendrogram build; with
    // it, they should collapse into one build after the batch goes quiet.
    // Same technique as components/ClusterView.test.tsx's debounce test.
    vi.useFakeTimers()
    mockBuildDendrogram.mockClear()
    try {
      const a = makeEntry('a', 'a.jpg', '2024-01-01T00:00:00Z', 0)
      const b = makeEntry('b', 'b.jpg', '2024-01-02T00:00:00Z', 1)
      const c = makeEntry('c', 'c.jpg', '2024-01-03T00:00:00Z', 2)
      const hashA = hashFromPositions(range(0, 9))

      const tick1 = new Map<string, PhotoMetrics | undefined>([['a', makeMetrics(hashA)]])
      const { result, rerender } = renderHook(
        ({ photos, metrics }) => useClusteredPhotos(photos, metrics, 40),
        { initialProps: { photos: [a, b, c], metrics: tick1 } }
      )

      // The very first value commits immediately -- one build on mount.
      expect(mockBuildDendrogram).toHaveBeenCalledTimes(1)

      const tick2 = new Map<string, PhotoMetrics | undefined>([...tick1, ['b', makeMetrics(hashA)]])
      rerender({ photos: [a, b, c], metrics: tick2 })
      act(() => {
        vi.advanceTimersByTime(50)
      })

      const tick3 = new Map<string, PhotoMetrics | undefined>([...tick2, ['c', makeMetrics(hashA)]])
      rerender({ photos: [a, b, c], metrics: tick3 })

      // Still within the debounce window since tick2 -- no rebuild yet.
      expect(mockBuildDendrogram).toHaveBeenCalledTimes(1)

      act(() => {
        vi.advanceTimersByTime(300)
      })

      // Exactly one more build -- tick2 and tick3 collapsed into it.
      expect(mockBuildDendrogram).toHaveBeenCalledTimes(2)
      expect(result.current.renderBlocks).toEqual([
        { type: 'cluster', cluster: { id: expect.any(String), members: ['a', 'b', 'c'] } },
      ])
    } finally {
      vi.useRealTimers()
    }
  })
})
