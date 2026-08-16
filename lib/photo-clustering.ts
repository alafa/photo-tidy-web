/**
 * Pairwise perceptual-hash clustering: groups photos in a batch that are
 * within a single Hamming-distance threshold of each other — purely
 * algorithmic (R1), no AI/ML. Grouping is display-only; nothing in this
 * module removes or ranks photos.
 *
 * Clusters are connected components over the pairwise-distance graph:
 * merging is transitive, not strict mutual pairwise similarity, so a chain
 * of near-duplicates (e.g. a long burst) stays in one cluster even if its
 * first and last frames are more different from each other than either is
 * from its neighbors.
 *
 * A photo with a null hash, or with no edge to any other photo in the
 * batch, becomes its own singleton cluster — clustering never errors and
 * never drops a photo from the result.
 *
 * Deliberately O(n^2): a plain double loop over every pair is correct and
 * intended at the batch sizes this app handles (~200 photos / under 20,000
 * pairs) — no indexing/bucketing optimization.
 */

export interface PhotoHashInput {
  id: string
  hash: string | null
}

export interface Cluster {
  id: string
  members: string[]
}

/**
 * Computes the Hamming distance between two equal-length hex hash strings:
 * the number of differing bits. Exported so a debug view can display the
 * exact same distance the clustering algorithm uses.
 */
export function hammingDistance(a: string, b: string): number {
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
 * Every pair of photos with a non-null hash is compared (O(n^2)). A pair at
 * or under `threshold` bits apart is connected. Connected components over
 * that graph become clusters — transitively, so a chain of near-duplicates
 * stays in one cluster even when its endpoints exceed the threshold from
 * each other directly. Photos with no edges (including every null-hash
 * photo) end up as their own singleton cluster.
 */
export function clusterPhotos(photos: PhotoHashInput[], threshold: number): Cluster[] {
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

  // Pairwise comparison across every hashable photo (plain O(n^2) double
  // loop, no indexing structure — trivial at this app's stated scale).
  const hashable = photos.filter((p): p is PhotoHashInput & { hash: string } => p.hash !== null)
  for (let i = 0; i < hashable.length; i++) {
    for (let j = i + 1; j < hashable.length; j++) {
      const distance = hammingDistance(hashable[i].hash, hashable[j].hash)
      if (distance <= threshold) union(hashable[i].id, hashable[j].id)
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
    clusters.push({ id: `cluster-${clusterIndex++}`, members })
  }

  return clusters
}
