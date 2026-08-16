import { describe, it, expect } from 'vitest'
import { clusterPhotos, type Cluster, type ClusterThresholds, type PhotoHashInput } from './photo-clustering'

// --- test helpers -------------------------------------------------------
//
// This module takes hash strings directly (no File/createImageBitmap
// involved), so tests build 16-hex-char hash strings precisely from a set
// of "on" bit positions, letting us control Hamming distance between
// fixtures exactly rather than relying on real image decoding.

const HASH_BITS = 64
const ZERO_HASH = '0'.repeat(16)

function hashToBits(hash: string): number[] {
  const bits: number[] = []
  for (const ch of hash) {
    const nibble = parseInt(ch, 16).toString(2).padStart(4, '0')
    for (const bit of nibble) bits.push(Number(bit))
  }
  return bits
}

function bitsToHash(bits: number[]): string {
  if (bits.length !== HASH_BITS) throw new Error(`expected ${HASH_BITS} bits, got ${bits.length}`)
  let hex = ''
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16)
  }
  return hex
}

/** Flips the given bit positions (0-63) on top of a base hash. */
function flipBits(base: string, positions: number[]): string {
  const bits = hashToBits(base)
  for (const position of positions) {
    bits[position] = bits[position] === 1 ? 0 : 1
  }
  return bitsToHash(bits)
}

/** Builds a hash with exactly the given bit positions (0-63) set to 1. */
function hashFromPositions(positions: number[]): string {
  return flipBits(ZERO_HASH, positions)
}

/** Inclusive range of integers, e.g. range(10, 12) -> [10, 11, 12]. */
function range(start: number, end: number): number[] {
  const out: number[] = []
  for (let i = start; i <= end; i++) out.push(i)
  return out
}

const THRESHOLDS: ClusterThresholds = { identical: 3, similar: 12 }

/** Finds the relationship between two ids regardless of a/b order. */
function findRelationship(cluster: Cluster, idA: string, idB: string) {
  return cluster.relationships.find(
    (r) => (r.a === idA && r.b === idB) || (r.a === idB && r.b === idA)
  )
}

function clusterOf(clusters: Cluster[], id: string): Cluster {
  const found = clusters.find((c) => c.members.includes(id))
  if (!found) throw new Error(`no cluster contains ${id}`)
  return found
}

describe('clusterPhotos', () => {
  it('clusters two photos within the identical threshold, tagged identical', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: ZERO_HASH },
      { id: 'b', hash: hashFromPositions([0, 1]) }, // distance 2 <= identical(3)
    ]

    const clusters = clusterPhotos(photos, THRESHOLDS)

    expect(clusters).toHaveLength(1)
    expect(clusters[0].members.sort()).toEqual(['a', 'b'])
    expect(clusters[0].relationships).toHaveLength(1)
    expect(clusters[0].relationships[0].tier).toBe('identical')
  })

  it('groups an 8-photo burst (each within similar threshold of every other) into one cluster, tagged similar', () => {
    // Each photo gets a distinct, disjoint 5-bit block, so every pair's
    // distance is 10 (5 + 5, no overlap) -- within the similar threshold
    // (12) but above the identical threshold (3).
    const photos: PhotoHashInput[] = range(0, 7).map((i) => ({
      id: `p${i}`,
      hash: hashFromPositions(range(5 * i, 5 * i + 4)),
    }))

    const clusters = clusterPhotos(photos, THRESHOLDS)

    expect(clusters).toHaveLength(1)
    expect(clusters[0].members.sort()).toEqual(photos.map((p) => p.id).sort())
    expect(clusters[0].relationships.length).toBeGreaterThan(0)
    for (const relationship of clusters[0].relationships) {
      expect(relationship.tier).toBe('similar')
    }
  })

  it('mixes an identical-tier pair and a similar-tier trio in one connected component', () => {
    // Chain: P1-P2 identical (distance 2), P2-P3 similar (distance 12),
    // P3-P4 similar (distance 6), P4-P5 similar (distance 8). P3/P4/P5
    // form a similar-tier trio connected to the identical pair via the
    // P2-P3 edge, all in a single connected component of 5 photos.
    const p1 = hashFromPositions([])
    const p2 = hashFromPositions([0, 1])
    const p3 = hashFromPositions([0, 1, ...range(10, 21)])
    const p4 = hashFromPositions([0, 1, ...range(10, 21), ...range(30, 35)])
    const p5 = hashFromPositions([0, 1, ...range(10, 21), ...range(30, 35), ...range(40, 47)])

    const photos: PhotoHashInput[] = [
      { id: 'p1', hash: p1 },
      { id: 'p2', hash: p2 },
      { id: 'p3', hash: p3 },
      { id: 'p4', hash: p4 },
      { id: 'p5', hash: p5 },
    ]

    const clusters = clusterPhotos(photos, THRESHOLDS)

    expect(clusters).toHaveLength(1)
    const cluster = clusters[0]
    expect(cluster.members.sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])

    expect(findRelationship(cluster, 'p1', 'p2')?.tier).toBe('identical')
    expect(findRelationship(cluster, 'p2', 'p3')?.tier).toBe('similar')
    expect(findRelationship(cluster, 'p3', 'p4')?.tier).toBe('similar')
    expect(findRelationship(cluster, 'p4', 'p5')?.tier).toBe('similar')

    const tiers = new Set(cluster.relationships.map((r) => r.tier))
    expect(tiers.has('identical')).toBe(true)
    expect(tiers.has('similar')).toBe(true)
  })

  it('puts a photo with no match within the similar threshold in its own singleton cluster', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: ZERO_HASH },
      { id: 'b', hash: hashFromPositions([0, 1]) }, // close to 'a' -- distance 2
      { id: 'outlier', hash: hashFromPositions(range(0, 40)) }, // far from both
    ]

    const clusters = clusterPhotos(photos, THRESHOLDS)

    const outlierCluster = clusterOf(clusters, 'outlier')
    expect(outlierCluster.members).toEqual(['outlier'])
    expect(outlierCluster.relationships).toEqual([])

    const pairCluster = clusterOf(clusters, 'a')
    expect(pairCluster.members.sort()).toEqual(['a', 'b'])
  })

  it('puts a photo with a null hash in its own singleton cluster regardless of other photos', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: ZERO_HASH },
      { id: 'b', hash: hashFromPositions([0, 1]) }, // would cluster with 'a'
      { id: 'undecodable', hash: null },
    ]

    const clusters = clusterPhotos(photos, THRESHOLDS)

    const nullCluster = clusterOf(clusters, 'undecodable')
    expect(nullCluster.members).toEqual(['undecodable'])
    expect(nullCluster.relationships).toEqual([])

    const pairCluster = clusterOf(clusters, 'a')
    expect(pairCluster.members.sort()).toEqual(['a', 'b'])
  })

  it('chains transitively: A~B and B~C similar, but A and C not within threshold directly', () => {
    // A is all zeros. B sets 10 bits (distance 10 from A). C is a
    // superset of B's bits plus 10 more (distance 10 from B, since B's
    // bits are a subset of C's) but distance 20 from A -- above the
    // similar threshold, so no direct A-C edge, only the A-B-C chain.
    const a = hashFromPositions([])
    const b = hashFromPositions(range(0, 9))
    const c = hashFromPositions([...range(0, 9), ...range(20, 29)])

    const photos: PhotoHashInput[] = [
      { id: 'a', hash: a },
      { id: 'b', hash: b },
      { id: 'c', hash: c },
    ]

    const clusters = clusterPhotos(photos, THRESHOLDS)

    expect(clusters).toHaveLength(1)
    expect(clusters[0].members.sort()).toEqual(['a', 'b', 'c'])
    expect(findRelationship(clusters[0], 'a', 'b')).toBeDefined()
    expect(findRelationship(clusters[0], 'b', 'c')).toBeDefined()
    expect(findRelationship(clusters[0], 'a', 'c')).toBeUndefined()
  })

  it('returns an empty array for empty input', () => {
    expect(clusterPhotos([], THRESHOLDS)).toEqual([])
  })

  it('returns one singleton cluster for a single-photo batch', () => {
    const clusters = clusterPhotos([{ id: 'only', hash: ZERO_HASH }], THRESHOLDS)

    expect(clusters).toHaveLength(1)
    expect(clusters[0].members).toEqual(['only'])
    expect(clusters[0].relationships).toEqual([])
  })
})
