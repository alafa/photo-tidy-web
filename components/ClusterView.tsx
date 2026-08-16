'use client'

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { PhotoMetrics } from '@/lib/perceptual-hash'
import { clusterPhotos, hammingDistance, type Cluster } from '@/lib/photo-clustering'
import { parseDatetimeLocalAsUTC } from '@/lib/datetime-local'
import PhotoCard from './PhotoCard'

// R1's grouping aggressiveness. This is the only clustering knob — there is
// no separate "identical" tier or automatic behavior tied to it; grouping
// is purely for display and manual review (feedback: automatic dedup was
// confusing and is removed for now — see the plan's "Later iteration" note
// for when smart auto-suggestions come back).
const DEFAULT_THRESHOLD = 20
const MIN_THRESHOLD = 0
// Beyond ~half the hash's bit width, two hashes are no more alike than
// chance — looser than this stops meaning "similar" at all.
const MAX_THRESHOLD = 32

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
   * `hooks/usePhotos.ts`'s `removePhotos`, called unchanged only when the
   * user explicitly clicks "Delete selected" within a cluster — there is no
   * automatic removal anywhere in this component.
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
 * member id list. `clusterPhotos` reassigns `cluster.id` as `cluster-${N}`
 * fresh on every call, purely from discovery order — as metrics resolve
 * asynchronously (KTD12), the threshold slider moves, or a delete shrinks
 * the batch, a given index can end up pointing at a completely different
 * real-world group of photos than it did on a prior render. Using
 * `cluster.id` as a React key or a selection-state Map key would let a
 * stale selection from one cluster silently attach to an unrelated cluster
 * that later inherits the same index. This key is used everywhere identity
 * needs to survive a recompute; `cluster.id` itself is not used for that
 * purpose anywhere in this component.
 */
function clusterKey(cluster: Cluster): string {
  return [...cluster.members].sort().join(',')
}

/**
 * Earliest `capturedAt` (in ms) among a cluster's members, for R3's
 * chronological ordering. Null timestamps are excluded from the min and the
 * result falls back to `Infinity` when every member is null — mirroring
 * `hooks/usePhotos.ts`'s `sortPhotos` null-last convention, so an all-null
 * cluster sorts after every dated cluster.
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
 * Debug view: the Hamming distance between every pair of members in a
 * cluster, so the user can verify whether the hashing/threshold is behaving
 * as expected rather than guessing from grouping outcomes alone.
 */
function PairwiseDistances({
  cluster,
  photosById,
  metrics,
}: {
  cluster: Cluster
  photosById: Map<string, PhotoEntry>
  metrics: Map<string, PhotoMetrics | undefined>
}) {
  if (cluster.members.length < 2) return null

  const pairs: Array<{ id: string; a: string; b: string; distance: number | null }> = []
  for (let i = 0; i < cluster.members.length; i++) {
    for (let j = i + 1; j < cluster.members.length; j++) {
      const idA = cluster.members[i]
      const idB = cluster.members[j]
      const hashA = metrics.get(idA)?.hash ?? null
      const hashB = metrics.get(idB)?.hash ?? null
      pairs.push({
        id: `${idA}-${idB}`,
        a: idA,
        b: idB,
        distance: hashA !== null && hashB !== null ? hammingDistance(hashA, hashB) : null,
      })
    }
  }

  return (
    <ul className="text-[11px] font-mono text-zinc-500 dark:text-zinc-400 flex flex-col gap-0.5">
      {pairs.map(({ id, a, b, distance }) => (
        <li key={id}>
          {photosById.get(a)?.filename} ↔ {photosById.get(b)?.filename}:{' '}
          {distance !== null ? `${distance} bits` : 'hash pending/unavailable'}
        </li>
      ))}
    </ul>
  )
}

export default function ClusterView({ photos, metrics, getObjectUrl, removePhotos, batchSetTimestamps }: ClusterViewProps) {
  const photosById = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos])

  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD)

  // The clustering pipeline (O(n^2) pairwise Hamming distance) only needs to
  // rerun when its actual inputs — `photos`/`metrics`/the slider — change,
  // not on every local selection-state update (a delete-checkbox toggle, a
  // timestamp-edit checkbox) that also re-renders this component.
  const sortedClusters = useMemo(() => {
    const hashInputs = photos.map((photo) => ({
      id: photo.id,
      // A photo whose metrics are still in flight (absent map entry, or
      // present-but-`undefined`) is treated the same as "no hash" — it
      // renders as a temporary singleton and re-clusters correctly once its
      // real hash lands and `metrics` updates (KTD12).
      hash: metrics.get(photo.id)?.hash ?? null,
    }))
    const clusters = clusterPhotos(hashInputs, threshold)
    return [...clusters].sort(
      (a, b) => earliestCapturedAtMs(a, photosById) - earliestCapturedAtMs(b, photosById)
    )
  }, [photos, metrics, photosById, threshold])

  // A cluster with only one member isn't a duplicate/near-duplicate of
  // anything and shouldn't visually read as a "cluster". Adjacent
  // singletons in the chronological sort are bundled into one plain grid
  // block with no cluster chrome at all; a real (2+-member) cluster keeps
  // its own section.
  const renderBlocks = useMemo(() => {
    const blocks: Array<{ type: 'cluster'; cluster: Cluster } | { type: 'singles'; clusters: Cluster[] }> = []
    for (const cluster of sortedClusters) {
      if (cluster.members.length > 1) {
        blocks.push({ type: 'cluster', cluster })
        continue
      }
      const last = blocks[blocks.length - 1]
      if (last?.type === 'singles') last.clusters.push(cluster)
      else blocks.push({ type: 'singles', clusters: [cluster] })
    }
    return blocks
  }, [sortedClusters])

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

  const compareHashA = comparePair ? metrics.get(comparePair[0])?.hash ?? null : null
  const compareHashB = comparePair?.[1] ? metrics.get(comparePair[1])?.hash ?? null : null
  const compareDistance =
    compareHashA !== null && compareHashB !== null ? hammingDistance(compareHashA, compareHashB) : null

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <label htmlFor="similarity-threshold" className="text-xs font-medium text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
            Grouping strictness
          </label>
          <input
            id="similarity-threshold"
            type="range"
            min={MIN_THRESHOLD}
            max={MAX_THRESHOLD}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            aria-label="Similarity grouping threshold — drag left for stricter, right for looser"
            className="flex-1 max-w-xs"
          />
          <span className="text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap">
            {threshold === MIN_THRESHOLD ? 'Strict' : threshold === MAX_THRESHOLD ? 'Loose' : `${threshold}/${MAX_THRESHOLD}`}
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
                <p>A: {photosById.get(comparePair[0])?.filename} — hash: {compareHashA ?? 'pending/undecodable'}</p>
                {comparePair[1] ? (
                  <>
                    <p>B: {photosById.get(comparePair[1])?.filename} — hash: {compareHashB ?? 'pending/undecodable'}</p>
                    <p className="font-semibold text-zinc-900 dark:text-zinc-50">
                      {compareDistance !== null
                        ? `Distance: ${compareDistance} bits`
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
          <section key={key} className="flex flex-col gap-3">
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
            {debugMode && <PairwiseDistances cluster={cluster} photosById={photosById} metrics={metrics} />}
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
