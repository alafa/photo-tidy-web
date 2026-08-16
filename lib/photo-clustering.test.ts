import { describe, it, expect } from 'vitest'
import {
  buildDendrogram,
  clusterPhotos,
  cosineDistance,
  cutDendrogram,
  hashToVector,
  hierarchicalOrder,
  l2Normalize,
  type PhotoHashInput,
} from './photo-clustering'

// --- test helpers -------------------------------------------------------
//
// This module takes hash strings directly (no File/createImageBitmap
// involved). Hashes are 256-bit (64 hex chars), matching lib/perceptual-hash.ts's
// 16x16 dHash grid. Tests build hashes from an explicit set of "on" bit
// positions so the resulting cosine distance between any two fixtures is
// exactly predictable by hand.

const HASH_BITS = 256
const ZERO_HASH = '0'.repeat(64)
const THRESHOLD = 0.2

function hashFromPositions(positions: number[]): string {
  const bits = new Array(HASH_BITS).fill(0)
  for (const position of positions) bits[position] = 1
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16)
  }
  return hex
}

/** Inclusive range of integers, e.g. range(10, 12) -> [10, 11, 12]. */
function range(start: number, end: number): number[] {
  const out: number[] = []
  for (let i = start; i <= end; i++) out.push(i)
  return out
}

function clusterOf(clusters: { id: string; members: string[] }[], id: string) {
  const found = clusters.find((c) => c.members.includes(id))
  if (!found) throw new Error(`no cluster contains ${id}`)
  return found
}

describe('hashToVector', () => {
  it('decodes each hex digit into 4 bits, most-significant first', () => {
    expect(hashToVector('f')).toEqual([1, 1, 1, 1])
    expect(hashToVector('0')).toEqual([0, 0, 0, 0])
    expect(hashToVector('a')).toEqual([1, 0, 1, 0]) // 1010
    expect(hashToVector('0f')).toEqual([0, 0, 0, 0, 1, 1, 1, 1])
  })
})

describe('l2Normalize', () => {
  it('scales a vector to unit length', () => {
    expect(l2Normalize([3, 4])).toEqual([0.6, 0.8])
  })

  it('leaves a zero vector unchanged rather than dividing by zero', () => {
    expect(l2Normalize([0, 0, 0])).toEqual([0, 0, 0])
  })
})

describe('cosineDistance', () => {
  it('is 0 for identical vectors', () => {
    expect(cosineDistance([1, 0, 1, 0], [1, 0, 1, 0])).toBeCloseTo(0)
  })

  it('is 1 for orthogonal vectors', () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1)
  })

  it('computes a known partial-overlap distance', () => {
    // 4 ones each, 2 shared -> similarity = 2/sqrt(4*4) = 0.5 -> distance 0.5.
    const a = [1, 1, 1, 1, 0, 0, 0, 0]
    const b = [1, 1, 0, 0, 1, 1, 0, 0]
    expect(cosineDistance(a, b)).toBeCloseTo(0.5)
  })

  it('treats two zero vectors as identical (distance 0)', () => {
    expect(cosineDistance([0, 0, 0], [0, 0, 0])).toBe(0)
  })

  it('treats a zero vector vs. a non-zero vector as maximally distant (distance 1), never NaN', () => {
    expect(cosineDistance([0, 0, 0], [1, 0, 0])).toBe(1)
  })
})

describe('hierarchicalOrder', () => {
  it('returns an empty array for empty input', () => {
    expect(hierarchicalOrder([])).toEqual([])
  })

  it('returns the single id unchanged for one item', () => {
    expect(hierarchicalOrder([{ id: 'only', vector: [1, 0] }])).toEqual(['only'])
  })

  it('places two near-identical items adjacent to a distant outlier', () => {
    const order = hierarchicalOrder([
      { id: 'a', vector: [1, 1, 1, 1, 0, 0, 0, 0] },
      { id: 'outlier', vector: [0, 0, 0, 0, 1, 1, 1, 1] }, // orthogonal to a and b
      { id: 'b', vector: [1, 1, 1, 0, 0, 0, 0, 0] }, // near-identical to a
    ])
    expect(order).toHaveLength(3)
    const aIndex = order.indexOf('a')
    const bIndex = order.indexOf('b')
    expect(Math.abs(aIndex - bIndex)).toBe(1) // a and b are adjacent
    expect(order.indexOf('outlier')).not.toBe((aIndex + bIndex) / 2) // outlier isn't wedged between them
  })
})

describe('clusterPhotos', () => {
  it('clusters two photos within the threshold', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: hashFromPositions(range(0, 9)) },
      { id: 'b', hash: hashFromPositions(range(0, 9)) }, // identical -> distance 0
    ]

    const clusters = clusterPhotos(photos, THRESHOLD)

    expect(clusters).toHaveLength(1)
    expect(clusters[0].members.sort()).toEqual(['a', 'b'])
  })

  it('does not connect two photos whose distance exceeds the threshold', () => {
    // 8 ones each, sharing only 4 -> similarity 4/8 = 0.5 -> distance 0.5.
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: hashFromPositions(range(0, 7)) },
      { id: 'b', hash: hashFromPositions([...range(0, 3), ...range(8, 11)]) },
    ]

    expect(clusterPhotos(photos, THRESHOLD)).toHaveLength(2)
  })

  it('a looser threshold connects photos a stricter one would not (live re-clustering)', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: hashFromPositions(range(0, 7)) },
      { id: 'b', hash: hashFromPositions([...range(0, 3), ...range(8, 11)]) }, // distance 0.5
    ]

    expect(clusterPhotos(photos, 0.2)).toHaveLength(2)
    expect(clusterPhotos(photos, 0.5)).toHaveLength(1)
  })

  it('puts a photo with no match within the threshold in its own singleton cluster', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: hashFromPositions(range(0, 9)) },
      { id: 'b', hash: hashFromPositions(range(0, 9)) }, // identical to a
      { id: 'outlier', hash: hashFromPositions(range(100, 109)) }, // disjoint bits -> orthogonal, distance 1
    ]

    const clusters = clusterPhotos(photos, THRESHOLD)

    const outlierCluster = clusterOf(clusters, 'outlier')
    expect(outlierCluster.members).toEqual(['outlier'])

    const pairCluster = clusterOf(clusters, 'a')
    expect(pairCluster.members.sort()).toEqual(['a', 'b'])
  })

  it('puts a photo with a null hash in its own singleton cluster regardless of other photos', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: hashFromPositions(range(0, 9)) },
      { id: 'b', hash: hashFromPositions(range(0, 9)) }, // would cluster with 'a'
      { id: 'undecodable', hash: null },
    ]

    const clusters = clusterPhotos(photos, THRESHOLD)

    const nullCluster = clusterOf(clusters, 'undecodable')
    expect(nullCluster.members).toEqual(['undecodable'])

    const pairCluster = clusterOf(clusters, 'a')
    expect(pairCluster.members.sort()).toEqual(['a', 'b'])
  })

  it('does not chain transitively under complete linkage, unlike single-linkage', () => {
    // Sliding 10-bit window, shifted by 2 each step: A-B and B-C are each
    // within THRESHOLD (distance 0.2), but A-C (shifted by 4) is not
    // (distance 0.4). Complete linkage's inter-cluster distance is the
    // *farthest* pair, so once {a,b} merge, the distance from {a,b} to c
    // is max(dist(a,c), dist(b,c)) = the far a-c distance — deliberately
    // resisting the single-linkage-style chaining a naive
    // "any pairwise edge under threshold" union-find would produce. This
    // is exactly why complete linkage was chosen over single linkage for
    // this app: a slowly-drifting sequence of photos should not bridge two
    // genuinely different shots into one cluster.
    const a = hashFromPositions(range(0, 9))
    const b = hashFromPositions(range(2, 11))
    const c = hashFromPositions(range(4, 13))

    const photos: PhotoHashInput[] = [
      { id: 'a', hash: a },
      { id: 'b', hash: b },
      { id: 'c', hash: c },
    ]

    const clusters = clusterPhotos(photos, THRESHOLD)

    expect(clusters).toHaveLength(2)
    expect(clusterOf(clusters, 'a').members.sort()).toEqual(['a', 'b'])
    expect(clusterOf(clusters, 'c').members).toEqual(['c'])
  })

  it('returns an empty array for empty input', () => {
    expect(clusterPhotos([], THRESHOLD)).toEqual([])
  })

  it('returns one singleton cluster for a single-photo batch', () => {
    const clusters = clusterPhotos([{ id: 'only', hash: ZERO_HASH }], THRESHOLD)

    expect(clusters).toHaveLength(1)
    expect(clusters[0].members).toEqual(['only'])
  })
})

describe('buildDendrogram + cutDendrogram', () => {
  it('cutting a once-built dendrogram at a given threshold matches clusterPhotos at that same threshold', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: hashFromPositions(range(0, 9)) },
      { id: 'b', hash: hashFromPositions(range(2, 11)) }, // distance to a: 0.2
      { id: 'c', hash: hashFromPositions(range(100, 109)) }, // orthogonal to both
    ]

    const merges = buildDendrogram(photos)
    const cutAtStrict = cutDendrogram(photos, merges, 0.1)
    const cutAtLoose = cutDendrogram(photos, merges, 0.2)

    expect(cutAtStrict).toHaveLength(3) // nothing merges below distance 0.2
    expect(cutAtLoose).toHaveLength(2) // a/b merge, c stays separate

    // The same merges, re-cut at each threshold, match clusterPhotos'
    // single-call equivalent exactly — proving the split doesn't change
    // clustering results, only when the expensive build step reruns.
    expect(cutAtStrict.map((c) => c.members.sort())).toEqual(
      clusterPhotos(photos, 0.1).map((c) => c.members.sort())
    )
    expect(cutAtLoose.map((c) => c.members.sort())).toEqual(
      clusterPhotos(photos, 0.2).map((c) => c.members.sort())
    )
  })

  it('a photo with a null hash never appears in the dendrogram but still cuts into its own singleton', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: hashFromPositions(range(0, 9)) },
      { id: 'undecodable', hash: null },
    ]

    const merges = buildDendrogram(photos)
    expect(merges).toEqual([])

    const clusters = cutDendrogram(photos, merges, 0.5)
    expect(clusterOf(clusters, 'undecodable').members).toEqual(['undecodable'])
  })

  it('ignores a merge referencing an id no longer in the current photo set, rather than corrupting the union-find', () => {
    // Simulates a caller (ClusterView) memoizing `merges` from an earlier,
    // larger batch than the `photos` it cuts against now -- e.g. debouncing
    // the expensive build step separately from the cheap live cut, where a
    // photo present when `merges` was built has since been deleted. Before
    // the ids-known guard, unioning against a never-added id silently
    // collapsed unrelated clusters under a shared `undefined` root.
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: hashFromPositions(range(0, 9)) },
      { id: 'c', hash: hashFromPositions(range(100, 109)) }, // orthogonal to a
    ]
    // 'b' (close to 'a') and 'd' (close to 'c') are in these merges but not
    // in the current `photos` -- as if they were deleted after the
    // dendrogram was built from a batch that still included them.
    const staleMerges = [
      { a: 'a', b: 'b', distance: 0.05 },
      { a: 'c', b: 'd', distance: 0.05 },
    ]

    const clusters = cutDendrogram(photos, staleMerges, 0.2)

    // 'a' and 'c' are orthogonal to each other and must stay in separate
    // clusters -- the stale merges (each referencing one live + one
    // now-deleted id) must not bridge them together.
    expect(clusterOf(clusters, 'a').members).toEqual(['a'])
    expect(clusterOf(clusters, 'c').members).toEqual(['c'])
  })
})
