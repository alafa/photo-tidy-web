/**
 * Perceptual-hash clustering: groups photos in a batch that are within a
 * cosine-distance threshold of each other — purely algorithmic (R1), no
 * AI/ML, no external library or service. Grouping is display-only; nothing
 * in this module removes or ranks photos.
 *
 * This hand-rolls the same shape of algorithm scikit-learn's
 * `AgglomerativeClustering(n_clusters=None, distance_threshold=T,
 * metric='cosine', linkage='complete')` implements, since this app is a
 * client-side-only browser app with no Python runtime available (KTD1's
 * "hand-roll rather than add a dependency" precedent, extended from dHash
 * to the clustering algorithm itself).
 *
 * Complete-linkage agglomerative clustering builds a dendrogram (merge
 * history) independent of any distance threshold: starting from every
 * photo as its own cluster, it repeatedly merges the two clusters whose
 * *farthest-apart* pair of members is closest (complete linkage), until
 * every pair of photos would be farther apart than any threshold the UI
 * could ever request. A "cut" of that dendrogram at a specific threshold —
 * union-find over every recorded merge at or under that distance — is
 * O(n) and produces the actual clusters. Building the dendrogram once and
 * cutting it cheaply on every threshold change (rather than re-running the
 * full O(n^3) clustering per slider tick) is what keeps live re-clustering
 * responsive at this app's stated scale (~200+ photos) without needing a
 * Web Worker — see `clusterPhotos`.
 */

export interface PhotoHashInput {
  id: string
  hash: string | null
}

export interface Cluster {
  id: string
  members: string[]
}

/** A cosine distance beyond this is never worth recording — no UI-selectable
 * threshold (0.0-0.5) could ever merge two photos that far apart, and the
 * dendrogram builder stops growing once every remaining pairwise distance
 * exceeds it. */
export const MAX_DISTANCE_THRESHOLD = 0.5

/**
 * Converts a hex-encoded dHash string into a numeric vector of 0s and 1s,
 * one entry per bit, most-significant bit first per hex digit — the same
 * bit order `computeDHash` (lib/perceptual-hash.ts) writes them in.
 */
export function hashToVector(hash: string): number[] {
  const vector: number[] = new Array(hash.length * 4)
  for (let i = 0; i < hash.length; i++) {
    const nibble = parseInt(hash[i], 16)
    vector[i * 4] = (nibble >> 3) & 1
    vector[i * 4 + 1] = (nibble >> 2) & 1
    vector[i * 4 + 2] = (nibble >> 1) & 1
    vector[i * 4 + 3] = nibble & 1
  }
  return vector
}

/** L2-normalizes a vector (unit length). A zero vector is returned unchanged
 * (there is no direction to normalize it to) — callers compare it via
 * `cosineDistance`, which handles the zero-vector case explicitly. */
export function l2Normalize(vector: number[]): number[] {
  let sumOfSquares = 0
  for (const value of vector) sumOfSquares += value * value
  const norm = Math.sqrt(sumOfSquares)
  if (norm === 0) return vector.slice()
  return vector.map((value) => value / norm)
}

/**
 * Cosine distance (1 - cosine similarity) between two equal-length vectors.
 * Callers pass already-L2-normalized vectors (so the dot product alone
 * equals the cosine similarity), but this also accepts raw vectors safely.
 * A zero vector (degenerate all-identical-pixel hash) has no defined
 * direction: distance to another zero vector is 0 (both trivially
 * "identical"); distance to any non-zero vector is 1 (maximally
 * dissimilar) rather than producing `NaN`.
 */
export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 && normB === 0) return 0
  if (normA === 0 || normB === 0) return 1
  // sqrt(normA * normB), not sqrt(normA) * sqrt(normB): the latter
  // compounds two independent rounding errors from (usually irrational)
  // intermediate roots, which can push an exact boundary case (e.g. two
  // equal-magnitude vectors sharing exactly 80% of their "on" bits) a
  // floating-point hair to the wrong side of a `<=` threshold comparison.
  // Multiplying first is both simpler and exact whenever normA * normB is
  // a perfect square (the common case for equal-popcount bit vectors).
  const similarity = dot / Math.sqrt(normA * normB)
  // Clamp for float error — similarity can drift a hair outside [-1, 1].
  const clamped = Math.max(-1, Math.min(1, similarity))
  return 1 - clamped
}

export interface DendrogramMerge {
  /** A representative original item id from each side of the merge — either
   * one is sufficient to union the two original clusters via union-find. */
  a: string
  b: string
  distance: number
}

/**
 * Builds a complete-linkage dendrogram over a set of (already L2-normalized)
 * vectors: the full merge history, independent of any distance threshold.
 * Naive O(n^3) — a plain "scan for the closest pair, merge, update
 * distances" loop, correct and fast enough at this app's stated scale
 * (~200 items; a few million operations, well under what would visibly
 * block a frame). Stops early once the closest remaining pair exceeds
 * `MAX_DISTANCE_THRESHOLD` — no threshold the UI can select would ever
 * merge them anyway, so continuing would be wasted work.
 */
function buildDendrogramFromVectors(items: Array<{ id: string; vector: number[] }>): DendrogramMerge[] {
  const n = items.length
  if (n < 2) return []

  // Per-active-cluster state, indexed 0..n-1 initially, extended with a new
  // synthetic index each merge. `representative` is any one original item
  // id belonging to that cluster (arbitrary choice — union-find only needs
  // one point per side to connect the whole cluster).
  const members: string[][] = items.map((item) => [item.id])
  const representative: string[] = items.map((item) => item.id)
  const active = new Set<number>(items.map((_, i) => i))

  // Pairwise complete-linkage distance between every pair of *current*
  // clusters, keyed by `${min}-${max}` index pair. Seeded from the raw
  // vector distances; updated (never recomputed from scratch) after each
  // merge using the complete-linkage rule: dist(new, x) = max(dist(a, x),
  // dist(b, x)).
  const distance = new Map<string, number>()
  function key(i: number, j: number): string {
    return i < j ? `${i}-${j}` : `${j}-${i}`
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      distance.set(key(i, j), cosineDistance(items[i].vector, items[j].vector))
    }
  }

  const merges: DendrogramMerge[] = []
  let nextIndex = n

  while (active.size > 1) {
    let bestI = -1
    let bestJ = -1
    let bestDistance = Infinity
    for (const i of active) {
      for (const j of active) {
        if (j <= i) continue
        const d = distance.get(key(i, j))!
        if (d < bestDistance) {
          bestDistance = d
          bestI = i
          bestJ = j
        }
      }
    }

    if (bestDistance > MAX_DISTANCE_THRESHOLD) break

    merges.push({ a: representative[bestI], b: representative[bestJ], distance: bestDistance })

    const newIndex = nextIndex++
    members[newIndex] = [...members[bestI], ...members[bestJ]]
    representative[newIndex] = representative[bestI]
    active.delete(bestI)
    active.delete(bestJ)

    for (const x of active) {
      const merged = Math.max(distance.get(key(bestI, x))!, distance.get(key(bestJ, x))!)
      distance.set(key(newIndex, x), merged)
    }
    active.add(newIndex)
  }

  return merges
}

/** Union-find with path compression, used both to cut a dendrogram at a
 * threshold and to group photos with no hash at all. */
class UnionFind {
  private parent = new Map<string, string>()

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id)
  }

  find(id: string): string {
    let root = id
    while (this.parent.get(root) !== root) root = this.parent.get(root)!
    let current = id
    while (this.parent.get(current) !== root) {
      const next = this.parent.get(current)!
      this.parent.set(current, root)
      current = next
    }
    return root
  }

  union(a: string, b: string): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA !== rootB) this.parent.set(rootA, rootB)
  }
}

/**
 * Builds the full complete-linkage dendrogram over a batch's hashes —
 * independent of any distance threshold. This is the expensive O(n^3)-ish
 * step; callers should memoize it separately from `cutDendrogram` (keyed
 * only on the photo/hash set, not the threshold) so moving the UI's
 * similarity slider only re-runs the cheap O(n) cut below, not this build,
 * keeping live re-clustering responsive at this app's stated scale
 * (~200+ photos) without needing a Web Worker.
 */
export function buildDendrogram(photos: PhotoHashInput[]): DendrogramMerge[] {
  const hashable = photos.filter((p): p is PhotoHashInput & { hash: string } => p.hash !== null)
  const vectors = hashable.map((p) => ({ id: p.id, vector: l2Normalize(hashToVector(p.hash)) }))
  return buildDendrogramFromVectors(vectors)
}

/**
 * Cuts a dendrogram at a specific distance threshold: union-find over every
 * recorded merge at or under that distance, producing the resulting
 * clusters. O(n) — cheap enough to re-run on every threshold-slider change.
 * Photos with a null hash (undecodable) never appear in the dendrogram and
 * so always end up as their own singleton cluster.
 */
export function cutDendrogram(photos: PhotoHashInput[], merges: DendrogramMerge[], threshold: number): Cluster[] {
  const uf = new UnionFind()
  const knownIds = new Set<string>()
  for (const photo of photos) {
    uf.add(photo.id)
    knownIds.add(photo.id)
  }
  for (const merge of merges) {
    // Guards against a caller memoizing `merges` separately from `photos`
    // (e.g. debouncing the expensive dendrogram build while cutting stays
    // live on every tick, per hooks/useClusteredPhotos.ts): a merge built
    // from an earlier, larger photo set can reference an id that's since
    // been deleted from the batch. Unioning against an id `uf` never added
    // would corrupt the union-find (its "root" resolves to `undefined`,
    // silently merging unrelated clusters under that shared undefined
    // root), so skip any merge whose endpoint isn't in the current batch.
    if (!knownIds.has(merge.a) || !knownIds.has(merge.b)) continue
    // A small epsilon absorbs residual floating-point noise so a merge
    // distance that is *mathematically* exactly at the threshold (e.g. two
    // equal-magnitude vectors sharing exactly 80% of their bits, at a 0.2
    // threshold) reliably merges rather than landing a float hair on the
    // wrong side of `<=`.
    if (merge.distance <= threshold + 1e-9) uf.union(merge.a, merge.b)
  }

  const membersByRoot = new Map<string, string[]>()
  for (const photo of photos) {
    const root = uf.find(photo.id)
    const members = membersByRoot.get(root)
    if (members) members.push(photo.id)
    else membersByRoot.set(root, [photo.id])
  }

  const clusters: Cluster[] = []
  let clusterIndex = 0
  for (const members of membersByRoot.values()) {
    clusters.push({ id: `cluster-${clusterIndex++}`, members })
  }
  return clusters
}

/**
 * Groups photos into clusters by cosine distance between their perceptual
 * hashes, using complete-linkage agglomerative clustering (see this
 * module's top comment) — a convenience wrapper over `buildDendrogram` +
 * `cutDendrogram` for callers that don't need the two steps memoized
 * separately (e.g. tests, or a one-off clustering pass).
 */
export function clusterPhotos(photos: PhotoHashInput[], threshold: number): Cluster[] {
  return cutDendrogram(photos, buildDendrogram(photos), threshold)
}
