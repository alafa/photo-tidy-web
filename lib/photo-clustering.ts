/**
 * Pairwise perceptual-hash clustering: groups photos in a batch into
 * clusters of "identical" (same shot, different resolution/format/
 * compression) or "similar" (same moment/scene, e.g. burst shots) photos,
 * purely from Hamming distance between dHash strings — no AI/ML (R1).
 *
 * Clusters are connected components over the pairwise-similar graph
 * (KTD4): merging is transitive, not strict mutual pairwise similarity, so
 * a chain of near-duplicates (e.g. a long burst) stays in one cluster even
 * if its first and last frames are more different from each other than
 * either is from its neighbors.
 *
 * A photo with a null hash, or with no edge to any other photo in the
 * batch, becomes its own singleton cluster (KTD3, R5) — clustering never
 * errors and never drops a photo from the result.
 *
 * Deliberately O(n^2): a plain double loop over every pair (KTD5) is
 * correct and intended at the batch sizes this app handles (~200 photos /
 * under 20,000 pairs) — no indexing/bucketing optimization.
 */

export interface PhotoHashInput {
  id: string
  hash: string | null
}

export type RelationshipTier = 'identical' | 'similar'

export interface PhotoRelationship {
  a: string
  b: string
  tier: RelationshipTier
}

export interface Cluster {
  id: string
  members: string[]
  relationships: PhotoRelationship[]
}

export interface ClusterThresholds {
  /** Hamming distance (in bits, out of 64) at or under which two photos are tagged `identical`. */
  identical: number
  /** Hamming distance (in bits, out of 64) at or under which two photos are tagged `similar` (must be >= `identical`). Above this, no edge is created. */
  similar: number
}

/**
 * Computes the Hamming distance between two equal-length hex hash strings:
 * the number of differing bits.
 */
function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`hash length mismatch: ${a.length} vs ${b.length}`)
  }
  let distance = 0
  for (let i = 0; i < a.length; i++) {
    let nibbleXor = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (nibbleXor > 0) {
      distance += nibbleXor & 1
      nibbleXor >>= 1
    }
  }
  return distance
}

/**
 * Groups photos into clusters by pairwise perceptual-hash similarity.
 *
 * Every pair of photos with a non-null hash is compared (O(n^2), KTD5). A
 * pair at or under `thresholds.similar` gets an edge, tagged `identical`
 * when the distance is also at or under `thresholds.identical`, otherwise
 * `similar`. Connected components over that edge graph become clusters
 * (KTD4) — transitively, so a cluster can mix `identical`- and
 * `similar`-tagged relationships across different member pairs. Photos
 * with no edges (including every photo with a null hash) end up as their
 * own singleton cluster (KTD3, R5).
 */
export function clusterPhotos(photos: PhotoHashInput[], thresholds: ClusterThresholds): Cluster[] {
  const relationshipsByPhoto = new Map<string, PhotoRelationship[]>()
  for (const photo of photos) {
    relationshipsByPhoto.set(photo.id, [])
  }

  // Union-find over photo ids, used to build connected components.
  const parent = new Map<string, string>()
  for (const photo of photos) {
    parent.set(photo.id, photo.id)
  }

  function find(id: string): string {
    let root = id
    while (parent.get(root) !== root) {
      root = parent.get(root) as string
    }
    // Path compression.
    let current = id
    while (parent.get(current) !== root) {
      const next = parent.get(current) as string
      parent.set(current, root)
      current = next
    }
    return root
  }

  function union(a: string, b: string): void {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) {
      parent.set(rootA, rootB)
    }
  }

  // Pairwise comparison across every hashable photo (KTD5: plain O(n^2)
  // double loop, no indexing structure).
  const hashable = photos.filter((p): p is PhotoHashInput & { hash: string } => p.hash !== null)
  for (let i = 0; i < hashable.length; i++) {
    for (let j = i + 1; j < hashable.length; j++) {
      const photoA = hashable[i]
      const photoB = hashable[j]
      const distance = hammingDistance(photoA.hash, photoB.hash)
      if (distance > thresholds.similar) continue // unrelated — no edge

      const tier: RelationshipTier = distance <= thresholds.identical ? 'identical' : 'similar'
      const relationship: PhotoRelationship = { a: photoA.id, b: photoB.id, tier }
      relationshipsByPhoto.get(photoA.id)!.push(relationship)
      relationshipsByPhoto.get(photoB.id)!.push(relationship)
      union(photoA.id, photoB.id)
    }
  }

  // Group photo ids by connected component root, preserving input order.
  const membersByRoot = new Map<string, string[]>()
  for (const photo of photos) {
    const root = find(photo.id)
    let members = membersByRoot.get(root)
    if (!members) {
      members = []
      membersByRoot.set(root, members)
    }
    members.push(photo.id)
  }

  const clusters: Cluster[] = []
  let clusterIndex = 0
  for (const members of membersByRoot.values()) {
    // Dedupe relationships: every edge was pushed onto both endpoints'
    // lists above, so collect them per-component via one representative
    // member's accumulated list plus the rest, then dedupe by identity.
    const seen = new Set<PhotoRelationship>()
    const relationships: PhotoRelationship[] = []
    for (const memberId of members) {
      for (const relationship of relationshipsByPhoto.get(memberId) ?? []) {
        if (!seen.has(relationship)) {
          seen.add(relationship)
          relationships.push(relationship)
        }
      }
    }

    clusters.push({
      id: `cluster-${clusterIndex++}`,
      members,
      relationships,
    })
  }

  return clusters
}
