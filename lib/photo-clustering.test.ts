import { describe, it, expect } from 'vitest'
import { clusterPhotos, hammingDistance, type Cluster, type PhotoHashInput } from './photo-clustering'

// --- test helpers -------------------------------------------------------
//
// This module takes hash strings directly (no File/createImageBitmap
// involved), so tests build 16-hex-char hash strings precisely from a set
// of "on" bit positions, letting us control Hamming distance between
// fixtures exactly rather than relying on real image decoding.

const HASH_BITS = 64
const ZERO_HASH = '0'.repeat(16)
const THRESHOLD = 12

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

function clusterOf(clusters: Cluster[], id: string): Cluster {
  const found = clusters.find((c) => c.members.includes(id))
  if (!found) throw new Error(`no cluster contains ${id}`)
  return found
}

describe('hammingDistance', () => {
  it('returns 0 for identical hashes', () => {
    expect(hammingDistance(ZERO_HASH, ZERO_HASH)).toBe(0)
  })

  it('counts differing bits regardless of which bits they are', () => {
    expect(hammingDistance(ZERO_HASH, hashFromPositions([0, 1, 2]))).toBe(3)
    expect(hammingDistance(ZERO_HASH, hashFromPositions(range(0, 63)))).toBe(64)
  })

  it('throws on mismatched hash lengths', () => {
    expect(() => hammingDistance('00', '000')).toThrow()
  })
})

describe('clusterPhotos', () => {
  it('clusters two photos within the threshold', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: ZERO_HASH },
      { id: 'b', hash: hashFromPositions([0, 1]) }, // distance 2 <= 12
    ]

    const clusters = clusterPhotos(photos, THRESHOLD)

    expect(clusters).toHaveLength(1)
    expect(clusters[0].members.sort()).toEqual(['a', 'b'])
  })

  it('groups an 8-photo burst (each within threshold of every other) into one cluster', () => {
    // Each photo gets a distinct, disjoint 5-bit block, so every pair's
    // distance is 10 (5 + 5, no overlap) -- within the threshold (12).
    const photos: PhotoHashInput[] = range(0, 7).map((i) => ({
      id: `p${i}`,
      hash: hashFromPositions(range(5 * i, 5 * i + 4)),
    }))

    const clusters = clusterPhotos(photos, THRESHOLD)

    expect(clusters).toHaveLength(1)
    expect(clusters[0].members.sort()).toEqual(photos.map((p) => p.id).sort())
  })

  it('puts a photo with no match within the threshold in its own singleton cluster', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: ZERO_HASH },
      { id: 'b', hash: hashFromPositions([0, 1]) }, // close to 'a' -- distance 2
      { id: 'outlier', hash: hashFromPositions(range(0, 40)) }, // far from both
    ]

    const clusters = clusterPhotos(photos, THRESHOLD)

    const outlierCluster = clusterOf(clusters, 'outlier')
    expect(outlierCluster.members).toEqual(['outlier'])

    const pairCluster = clusterOf(clusters, 'a')
    expect(pairCluster.members.sort()).toEqual(['a', 'b'])
  })

  it('puts a photo with a null hash in its own singleton cluster regardless of other photos', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: ZERO_HASH },
      { id: 'b', hash: hashFromPositions([0, 1]) }, // would cluster with 'a'
      { id: 'undecodable', hash: null },
    ]

    const clusters = clusterPhotos(photos, THRESHOLD)

    const nullCluster = clusterOf(clusters, 'undecodable')
    expect(nullCluster.members).toEqual(['undecodable'])

    const pairCluster = clusterOf(clusters, 'a')
    expect(pairCluster.members.sort()).toEqual(['a', 'b'])
  })

  it('chains transitively: A~B and B~C within threshold, but A and C not within threshold directly', () => {
    // A is all zeros. B sets 10 bits (distance 10 from A). C is a
    // superset of B's bits plus 10 more (distance 10 from B, since B's
    // bits are a subset of C's) but distance 20 from A -- above the
    // threshold, so no direct A-C edge, only the A-B-C chain.
    const a = hashFromPositions([])
    const b = hashFromPositions(range(0, 9))
    const c = hashFromPositions([...range(0, 9), ...range(20, 29)])

    const photos: PhotoHashInput[] = [
      { id: 'a', hash: a },
      { id: 'b', hash: b },
      { id: 'c', hash: c },
    ]

    const clusters = clusterPhotos(photos, THRESHOLD)

    expect(clusters).toHaveLength(1)
    expect(clusters[0].members.sort()).toEqual(['a', 'b', 'c'])
  })

  it('does not connect two photos whose distance exceeds the threshold', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: ZERO_HASH },
      { id: 'b', hash: hashFromPositions(range(0, 12)) }, // distance 13 > 12
    ]

    const clusters = clusterPhotos(photos, THRESHOLD)

    expect(clusters).toHaveLength(2)
  })

  it('a looser threshold connects photos a stricter one would not (live re-clustering)', () => {
    const photos: PhotoHashInput[] = [
      { id: 'a', hash: ZERO_HASH },
      { id: 'b', hash: hashFromPositions(range(0, 12)) }, // distance 13
    ]

    expect(clusterPhotos(photos, 12)).toHaveLength(2)
    expect(clusterPhotos(photos, 13)).toHaveLength(1)
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
