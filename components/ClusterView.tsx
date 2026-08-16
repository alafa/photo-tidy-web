'use client'

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { PhotoMetrics } from '@/lib/perceptual-hash'
import {
  buildDendrogram,
  cosineDistance,
  cutDendrogram,
  hashToVector,
  hierarchicalOrder,
  l2Normalize,
  MAX_DISTANCE_THRESHOLD,
  type Cluster,
} from '@/lib/photo-clustering'
import { parseDatetimeLocalAsUTC } from '@/lib/datetime-local'
import PhotoCard from './PhotoCard'

// R1's grouping aggressiveness, exposed to the user as a 0-100% slider
// rather than the raw cosine-distance threshold (0.0-0.5) — "23/32" was
// meaningless to a user with no reason to know the hash's bit width.
// 0% maps to distance_threshold 0.0 (only exact duplicates); 100% maps to
// MAX_DISTANCE_THRESHOLD (very loose grouping). Default 40% == 0.2, the
// starting distance_threshold this app has validated is a reasonable
// middle ground.
const DEFAULT_SIMILARITY_PERCENT = 40
const MIN_SIMILARITY_PERCENT = 0
const MAX_SIMILARITY_PERCENT = 100

function percentToDistanceThreshold(percent: number): number {
  return (percent / 100) * MAX_DISTANCE_THRESHOLD
}

// How long `hashInputs` must stay unchanged before the expensive dendrogram
// build (below) re-runs on it. `usePhotoMetrics` commits a new metrics Map
// after every 5-photo chunk resolves, which otherwise gives `hashInputs` a
// new identity roughly that often during a large import -- rebuilding the
// full O(n^3)-ish dendrogram on every one of those ticks instead of once.
const DENDROGRAM_REBUILD_DEBOUNCE_MS = 200

/**
 * Returns `value`, but only updates to a new value after it has stayed the
 * same reference for `delayMs` -- except the very first value, which
 * commits immediately (so opening cluster view onto an already-settled
 * batch, the common case, shows clusters right away instead of behind a
 * fixed delay). Used to decouple the expensive dendrogram build from every
 * individual metrics-arrival tick during an in-progress import; the cheap
 * per-tick cut (`cutDendrogram`) still runs on the live, undebounced value.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  const isFirstRef = useRef(true)

  useEffect(() => {
    // `useState(value)` above already seeded `debounced` with the initial
    // value at mount time, so the first effect run has nothing to commit --
    // only later changes need debouncing.
    if (isFirstRef.current) {
      isFirstRef.current = false
      return
    }
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}

interface ClusterViewProps {
  photos: PhotoEntry[]
  metrics: Map<string, PhotoMetrics | undefined>
  /**
   * Not part of the original ClusterViewProps sketch in the plan excerpt,
   * but required in practice: `PhotoCard` needs an `objectUrl` per member,
   * and the only correct source for that is `PhotoUploadPage`'s existing
   * `useObjectUrls` cache (mirrors how `PhotoGrid` already receives
   * `getObjectUrl` as a prop rather than creating its own object URLs).
   */
  getObjectUrl: (file: File) => string
  /**
   * Called only when the user explicitly clicks "Delete selected" within a
   * cluster — there is no automatic removal anywhere in this component. The
   * caller (`PhotoUploadPage`) wraps `hooks/usePhotos.ts`'s `removePhotos`
   * with its own object-URL release and selection cleanup, mirroring what
   * the timeline view's delete path already does.
   */
  removePhotos: (ids: string[]) => void
  /**
   * `hooks/usePhotos.ts`'s `batchSetTimestamps`, called unchanged (KTD10,
   * R10) for U5's cluster-scoped batch timestamp editing. It already applies
   * the app's one-second-offset convention per selected photo in display
   * order — this component just needs to call it with the right ids/date.
   */
  batchSetTimestamps: (ids: string[], anchorDate: Date) => void
}

/**
 * A stable, content-derived identity for a cluster: the sorted-and-joined
 * member id list. `clusterPhotos`/`cutDendrogram` reassign `cluster.id` as
 * `cluster-${N}` fresh on every call, purely from union-find discovery
 * order — as metrics resolve asynchronously (KTD12), the threshold slider
 * moves, or a delete shrinks the batch, a given index can end up pointing
 * at a completely different real-world group of photos than it did on a
 * prior render. Using `cluster.id` as a React key or a selection-state Map
 * key would let a stale selection from one cluster silently attach to an
 * unrelated cluster that later inherits the same index. This key is used
 * everywhere identity needs to survive a recompute; `cluster.id` itself is
 * not used for that purpose anywhere in this component. Order-independent
 * (sorts before joining), so reordering a cluster's `members` for display
 * never changes its key.
 */
function clusterKey(cluster: Cluster): string {
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
 * Shared toggle mechanics for a per-cluster `Map<clusterKey, Set<memberId>>`
 * selection: copy-or-default the cluster's current `Set`, add/delete `id`,
 * write it back into a new `Map`. Used by both the manual delete-selection
 * and the timestamp-edit selection (U5) — the two Maps stay separate (they
 * represent independently toggleable concepts a member can carry at once),
 * only this update mechanic is shared.
 */
function toggleInClusterSelection(
  setSelections: Dispatch<SetStateAction<Map<string, Set<string>>>>,
  clusterId: string,
  id: string,
  checked: boolean,
  defaultSelection: () => Set<string>
) {
  setSelections((prev) => {
    const next = new Map(prev)
    const current = new Set(prev.get(clusterId) ?? defaultSelection())
    if (checked) current.add(id)
    else current.delete(id)
    next.set(clusterId, current)
    return next
  })
}

/** "8/12/2025, 3:04 PM"-style label for a quick-pick timestamp button. Uses
 * `timeZone: 'UTC'` because `capturedAt` clock times are stored as UTC values
 * (see `PhotoCard.tsx`'s `dateFormatter`), so this displays them as-is. */
const quickPickFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'UTC',
})

/**
 * U5's cluster-scoped batch timestamp editor: quick-pick buttons for each
 * distinct existing `capturedAt` among the selected members, plus a custom
 * datetime-local input. Only rendered once `selectedIds` is non-empty (the
 * caller gates this). A separate component (rather than inline JSX in the
 * map callback) so the custom-date draft value is its own local state per
 * cluster, isolated from other clusters' editors.
 */
function ClusterTimestampEditor({
  selectedIds,
  photosById,
  batchSetTimestamps,
}: {
  selectedIds: string[]
  photosById: Map<string, PhotoEntry>
  batchSetTimestamps: (ids: string[], anchorDate: Date) => void
}) {
  const [customValue, setCustomValue] = useState('')

  // R9: distinct existing timestamps among the selected members, deduped by
  // ms value and sorted ascending. Members with a null capturedAt (nothing
  // to offer) are skipped.
  const seen = new Map<number, Date>()
  for (const id of selectedIds) {
    const capturedAt = photosById.get(id)?.capturedAt ?? null
    if (capturedAt === null) continue
    if (!seen.has(capturedAt.getTime())) seen.set(capturedAt.getTime(), capturedAt)
  }
  const distinctTimestamps = [...seen.values()].sort((a, b) => a.getTime() - b.getTime())

  function applyCustom() {
    const parsed = parseDatetimeLocalAsUTC(customValue)
    if (!parsed) return
    batchSetTimestamps(selectedIds, parsed)
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 p-3">
      <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400 uppercase tracking-wide">
        Set timestamp for {selectedIds.length} selected
      </span>
      {distinctTimestamps.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {distinctTimestamps.map((date) => (
            <button
              key={date.getTime()}
              type="button"
              onClick={() => batchSetTimestamps(selectedIds, date)}
              className="px-2.5 py-1 text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
            >
              Use {quickPickFormatter.format(date)}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="datetime-local"
          value={customValue}
          onChange={(e) => setCustomValue(e.target.value)}
          aria-label="Custom timestamp"
          className="flex-1 text-sm border border-zinc-300 dark:border-zinc-600 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />
        <button
          type="button"
          onClick={applyCustom}
          disabled={!customValue}
          className="px-3 py-1.5 text-xs font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 transition-colors dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Apply
        </button>
      </div>
    </div>
  )
}

/**
 * Debug view: the cosine distance between every pair of members in a
 * cluster, so the user can verify whether the hashing/threshold is behaving
 * as expected rather than guessing from grouping outcomes alone.
 */
function PairwiseDistances({
  cluster,
  photosById,
  vectorsById,
}: {
  cluster: Cluster
  photosById: Map<string, PhotoEntry>
  vectorsById: Map<string, number[]>
}) {
  if (cluster.members.length < 2) return null

  const pairs: Array<{ id: string; a: string; b: string; distance: number | null }> = []
  for (let i = 0; i < cluster.members.length; i++) {
    for (let j = i + 1; j < cluster.members.length; j++) {
      const idA = cluster.members[i]
      const idB = cluster.members[j]
      const vectorA = vectorsById.get(idA)
      const vectorB = vectorsById.get(idB)
      pairs.push({
        id: `${idA}-${idB}`,
        a: idA,
        b: idB,
        distance: vectorA && vectorB ? cosineDistance(vectorA, vectorB) : null,
      })
    }
  }

  return (
    <ul className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 flex flex-col gap-0.5">
      {pairs.map(({ id, a, b, distance }) => (
        <li key={id}>
          {photosById.get(a)?.filename} ↔ {photosById.get(b)?.filename}:{' '}
          {distance !== null ? `${distance.toFixed(3)} cosine distance` : 'hash pending/unavailable'}
        </li>
      ))}
    </ul>
  )
}

export default function ClusterView({ photos, metrics, getObjectUrl, removePhotos, batchSetTimestamps }: ClusterViewProps) {
  const photosById = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos])

  const [similarityPercent, setSimilarityPercent] = useState(DEFAULT_SIMILARITY_PERCENT)
  const distanceThreshold = percentToDistanceThreshold(similarityPercent)

  // Hash inputs for the clustering pipeline, and L2-normalized vectors for
  // every photo with a resolved hash (reused for hierarchical ordering and
  // the debug panel — no need to recompute per use site).
  const hashInputs = useMemo(
    () =>
      photos.map((photo) => ({
        id: photo.id,
        // A photo whose metrics are still in flight (absent map entry, or
        // present-but-`undefined`) is treated the same as "no hash" — it
        // renders as a temporary singleton and re-clusters correctly once
        // its real hash lands and `metrics` updates (KTD12).
        hash: metrics.get(photo.id)?.hash ?? null,
      })),
    [photos, metrics]
  )
  const vectorsById = useMemo(() => {
    const map = new Map<string, number[]>()
    for (const { id, hash } of hashInputs) {
      if (hash !== null) map.set(id, l2Normalize(hashToVector(hash)))
    }
    return map
  }, [hashInputs])

  // The expensive O(n^3)-ish complete-linkage dendrogram build only
  // depends on the batch's hashes, not the similarity threshold — building
  // it once and cutting it cheaply (below) on every slider change is what
  // keeps live re-clustering responsive without a Web Worker at this app's
  // stated scale (~200+ photos). See lib/photo-clustering.ts's top comment.
  // Debounced separately from `hashInputs` itself: `usePhotoMetrics` gives
  // `hashInputs` a new identity roughly every 5 photos during a large
  // import, and without debouncing this build reran on every one of those
  // ticks instead of once. `cutDendrogram` below still cuts against the
  // live, undebounced `hashInputs` — a photo that resolves mid-debounce
  // just stays a temporary singleton (already the documented/tested
  // behavior for in-flight metrics) until the next debounced build catches
  // it up.
  const debouncedHashInputs = useDebouncedValue(hashInputs, DENDROGRAM_REBUILD_DEBOUNCE_MS)
  const dendrogram = useMemo(() => buildDendrogram(debouncedHashInputs), [debouncedHashInputs])

  // Cheap O(n) cut — safe to re-run on every threshold-slider tick, and on
  // every live (non-debounced) hashInputs change. cutDendrogram tolerates
  // `dendrogram` lagging behind `hashInputs` (a merge referencing an id no
  // longer present in the current batch is simply ignored).
  const rawClusters = useMemo(
    () => cutDendrogram(hashInputs, dendrogram, distanceThreshold),
    [hashInputs, dendrogram, distanceThreshold]
  )

  // Reorders each cluster's own members by mutual similarity (most similar
  // photos sit adjacent) via the hierarchical-clustering leaves_list
  // technique, then places clusters — and single, unclustered photos, which
  // are just one-member clusters — in chronological order by earliest
  // member `capturedAt`. This is the app's one ordering rule everywhere
  // else (`hooks/usePhotos.ts`'s `sortPhotos`), and critically means a
  // photo's position never changes when the similarity slider moves unless
  // its own cluster membership actually changes: an earlier similarity-only
  // ordering (centroid + leaves_list across clusters) reshuffled the whole
  // grid on every threshold tick, which read as random jumping even though
  // the underlying clustering was stable.
  const displayClusters = useMemo(() => {
    const reordered: Cluster[] = rawClusters.map((cluster) => {
      const memberVectors = cluster.members
        .map((id) => ({ id, vector: vectorsById.get(id) }))
        .filter((m): m is { id: string; vector: number[] } => m.vector !== undefined)

      const orderedMemberIds =
        memberVectors.length > 1
          ? [...hierarchicalOrder(memberVectors), ...cluster.members.filter((id) => !vectorsById.has(id))]
          : cluster.members

      return { id: cluster.id, members: orderedMemberIds }
    })

    return reordered.sort(
      (a, b) => earliestCapturedAtMs(a, photosById) - earliestCapturedAtMs(b, photosById)
    )
  }, [rawClusters, vectorsById, photosById])

  // A cluster with only one member isn't a duplicate/near-duplicate of
  // anything and shouldn't visually read as a "cluster". Adjacent
  // singletons in the chronological sequence are bundled into one plain
  // grid block with no cluster chrome at all; a real (2+-member) cluster
  // keeps its own section.
  const renderBlocks = useMemo(() => {
    const blocks: Array<{ type: 'cluster'; cluster: Cluster } | { type: 'singles'; clusters: Cluster[] }> = []
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

  // Manual "select for deletion" per cluster. No auto-suggestion, no
  // pre-selected keeper, no automatic removal of any kind — the user picks
  // which member(s) to delete and nothing is removed until they click
  // "Delete selected".
  const [deleteSelections, setDeleteSelections] = useState<Map<string, Set<string>>>(new Map())

  function toggleDeleteSelection(key: string, id: string, checked: boolean) {
    toggleInClusterSelection(setDeleteSelections, key, id, checked, () => new Set())
  }

  function handleDeleteSelected(key: string) {
    const selected = deleteSelections.get(key)
    if (!selected || selected.size === 0) return
    removePhotos([...selected])
    setDeleteSelections((prev) => {
      const next = new Map(prev)
      next.delete(key)
      return next
    })
  }

  // U5: per-cluster "selected for timestamp edit" selection, keyed by
  // `clusterKey`. Independent of the delete-selection above — a different
  // concept (which members get a corrected timestamp) even though both use
  // the same checkbox UI pattern.
  const [timestampSelections, setTimestampSelections] = useState<Map<string, Set<string>>>(new Map())

  function toggleTimestampSelection(clusterId: string, id: string, checked: boolean) {
    toggleInClusterSelection(setTimestampSelections, clusterId, id, checked, () => new Set<string>())
  }

  // --- Debug mode: verify hash/threshold behavior directly ----------------
  const [debugMode, setDebugMode] = useState(false)
  // Up to two ids selected for direct hash/distance comparison, in click
  // order. Clicking a third photo resets to a fresh single selection.
  const [comparePair, setComparePair] = useState<[string, string | null] | null>(null)

  function handleCompareClick(id: string) {
    setComparePair((prev) => {
      if (!prev || prev[1] !== null) return [id, null]
      if (prev[0] === id) return prev
      return [prev[0], id]
    })
  }

  const compareHashA = comparePair ? hashInputs.find((h) => h.id === comparePair[0])?.hash ?? null : null
  const compareHashB = comparePair?.[1]
    ? hashInputs.find((h) => h.id === comparePair[1])?.hash ?? null
    : null
  const compareVectorA = comparePair ? vectorsById.get(comparePair[0]) ?? null : null
  const compareVectorB = comparePair?.[1] ? vectorsById.get(comparePair[1]) ?? null : null
  const compareDistance =
    compareVectorA && compareVectorB ? cosineDistance(compareVectorA, compareVectorB) : null

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <label htmlFor="similarity-threshold" className="text-xs font-medium text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
            Similarity
          </label>
          <input
            id="similarity-threshold"
            type="range"
            min={MIN_SIMILARITY_PERCENT}
            max={MAX_SIMILARITY_PERCENT}
            value={similarityPercent}
            onChange={(e) => setSimilarityPercent(Number(e.target.value))}
            aria-label="Similarity — drag left for only exact duplicates, right for looser grouping"
            className="flex-1 max-w-xs"
          />
          <span className="text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap tabular-nums">
            {similarityPercent}%
          </span>
          <label className="ml-auto flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400 cursor-pointer">
            <input
              type="checkbox"
              checked={debugMode}
              onChange={(e) => {
                setDebugMode(e.target.checked)
                setComparePair(null)
              }}
            />
            Debug mode
          </label>
        </div>
        {debugMode && (
          <div className="text-xs font-mono text-zinc-600 dark:text-zinc-400 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 p-3">
            {!comparePair && <p>Click &quot;Compare&quot; on any two photos to see their hashes and distance.</p>}
            {comparePair && (
              <div className="flex flex-col gap-1">
                <p className="break-all">A: {photosById.get(comparePair[0])?.filename} — hash: {compareHashA ?? 'pending/undecodable'}</p>
                {comparePair[1] ? (
                  <>
                    <p className="break-all">B: {photosById.get(comparePair[1])?.filename} — hash: {compareHashB ?? 'pending/undecodable'}</p>
                    <p className="font-semibold text-zinc-900 dark:text-zinc-50">
                      {compareDistance !== null
                        ? `Cosine distance: ${compareDistance.toFixed(3)}`
                        : 'Distance: unavailable (one or both hashes not resolved)'}
                    </p>
                  </>
                ) : (
                  <p>Click a second photo to compare.</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {renderBlocks.map((block) => {
        if (block.type === 'singles') {
          const blockKey = block.clusters.map((c) => c.members[0]).sort().join(',')
          return (
            <div key={blockKey} className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {block.clusters.map((cluster) => {
                const id = cluster.members[0]
                const entry = photosById.get(id)
                if (!entry) return null
                return (
                  <div key={id} className="flex flex-col gap-1">
                    <PhotoCard entry={entry} objectUrl={getObjectUrl(entry.file)} />
                    {debugMode && (
                      <button
                        type="button"
                        onClick={() => handleCompareClick(id)}
                        className="text-[11px] text-zinc-500 dark:text-zinc-400 underline text-left"
                      >
                        Compare
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )
        }

        const cluster = block.cluster
        const key = clusterKey(cluster)
        const deleteSelected = deleteSelections.get(key) ?? new Set<string>()
        const timestampSelected = timestampSelections.get(key) ?? new Set<string>()

        return (
          <section
            key={key}
            className="flex flex-col gap-3 rounded-xl border border-zinc-300 dark:border-zinc-600 bg-zinc-100/70 dark:bg-zinc-800/40 p-4"
          >
            <h2 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
              {cluster.members.length} related photos
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {cluster.members.map((id) => {
                const entry = photosById.get(id)
                if (!entry) return null
                return (
                  <div key={id} className="flex flex-col gap-1.5">
                    <PhotoCard
                      entry={entry}
                      objectUrl={getObjectUrl(entry.file)}
                      onSelect={(checked) => toggleDeleteSelection(key, id, checked)}
                      checked={deleteSelected.has(id)}
                    />
                    <label className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={timestampSelected.has(id)}
                        onChange={(e) => toggleTimestampSelection(key, id, e.target.checked)}
                        aria-label={`Select ${entry.filename} for timestamp edit`}
                        className="h-3.5 w-3.5"
                      />
                      Timestamp edit
                    </label>
                    {debugMode && (
                      <button
                        type="button"
                        onClick={() => handleCompareClick(id)}
                        className="text-[11px] text-zinc-500 dark:text-zinc-400 underline text-left"
                      >
                        Compare
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
            {debugMode && <PairwiseDistances cluster={cluster} photosById={photosById} vectorsById={vectorsById} />}
            <div>
              <button
                type="button"
                onClick={() => handleDeleteSelected(key)}
                disabled={deleteSelected.size === 0}
                className="px-3 py-1.5 text-xs font-medium bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors dark:bg-red-500 dark:hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Delete selected ({deleteSelected.size})
              </button>
            </div>
            {timestampSelected.size > 0 && (
              <ClusterTimestampEditor
                selectedIds={[...timestampSelected]}
                photosById={photosById}
                batchSetTimestamps={batchSetTimestamps}
              />
            )}
          </section>
        )
      })}
    </div>
  )
}
