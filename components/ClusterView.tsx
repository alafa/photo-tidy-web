'use client'

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { PhotoMetrics } from '@/lib/perceptual-hash'
import { clusterPhotos, type Cluster, type RelationshipTier } from '@/lib/photo-clustering'
import PhotoCard from './PhotoCard'

// KTD2's starting Hamming-distance thresholds (out of a 64-bit hash) — kept
// as a local constant so they're easy to find and tune once real
// WhatsApp-sourced photos are validated per the plan's Definition of Done.
const CLUSTER_THRESHOLDS = { identical: 3, similar: 12 }

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
   * `hooks/usePhotos.ts`'s `removePhotos`, called unchanged (KTD10) both for
   * U4's automatic identical-tier resolution and its confirmed similar-tier
   * removal.
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

/** Parse a datetime-local string ("YYYY-MM-DDTHH:MM") as UTC clock time. Duplicated
 * from `PhotoCard.tsx`/`BatchEditPanel.tsx` per this codebase's established
 * convention of duplicating this small helper rather than extracting a shared
 * module. */
function parseDatetimeLocalAsUTC(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  if (!match) return null
  const [, y, mo, d, h, mi] = match.map(Number)
  return new Date(Date.UTC(y, mo - 1, d, h, mi, 0))
}

type MemberTier = RelationshipTier | null

/**
 * A cluster's `relationships` are per-pair, not per-member. This derives a
 * single "highest tier this member participates in" label for rendering: a
 * member touched by any `identical`-tier relationship is identical-flagged
 * (identical wins over similar); else similar-flagged if touched by any
 * `similar`-tier relationship; else (a true singleton with zero
 * relationships) no flag at all.
 */
function memberTier(cluster: Cluster, memberId: string): MemberTier {
  let sawSimilar = false
  for (const relationship of cluster.relationships) {
    if (relationship.a !== memberId && relationship.b !== memberId) continue
    if (relationship.tier === 'identical') return 'identical'
    sawSimilar = true
  }
  return sawSimilar ? 'similar' : null
}

/**
 * A stable, content-derived identity for a cluster: the sorted-and-joined
 * member id list. `clusterPhotos` reassigns `cluster.id` as `cluster-${N}`
 * fresh on every call, purely from discovery order — as metrics resolve
 * asynchronously (KTD12) and clusters merge/split/reorder, a given index can
 * end up pointing at a completely different real-world group of photos than
 * it did on a prior render. Using `cluster.id` as a React key or a
 * `similarSelections`/`timestampSelections` Map key would let a stale
 * selection from one cluster silently attach to an unrelated cluster that
 * later inherits the same index. This key is used everywhere identity needs
 * to survive a recompute; `cluster.id` itself is not used for that purpose
 * anywhere in this component.
 */
function clusterKey(cluster: Cluster): string {
  return [...cluster.members].sort().join(',')
}

/**
 * Partitions a cluster's identical-tagged members into their own connected
 * sub-groups, considering only `identical`-tier edges. A single connected
 * component from `clusterPhotos` can contain two or more separate
 * identical-tier duplicate pairs bridged together purely by a weaker
 * `similar`-tier edge (e.g. a burst chain where frame 2 and 3 are identical,
 * frame 5 and 6 are a separate identical pair, and frame 3~5 is only
 * similar) — treating every identical-tagged member in the whole cluster as
 * one group would auto-delete photos that are only weakly `similar` to the
 * kept survivor, not actually duplicates of it. Each returned sub-group is
 * resolved to its own single best-quality survivor independently.
 */
function identicalSubgroups(cluster: Cluster): string[][] {
  const identicalIds = cluster.members.filter((id) => memberTier(cluster, id) === 'identical')
  const parent = new Map<string, string>()
  for (const id of identicalIds) parent.set(id, id)

  function find(id: string): string {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) as string
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
    if (rootA !== rootB) parent.set(rootA, rootB)
  }

  for (const relationship of cluster.relationships) {
    if (relationship.tier === 'identical' && parent.has(relationship.a) && parent.has(relationship.b)) {
      union(relationship.a, relationship.b)
    }
  }

  const groups = new Map<string, string[]>()
  for (const id of identicalIds) {
    const root = find(id)
    const group = groups.get(root) ?? []
    group.push(id)
    groups.set(root, group)
  }
  return [...groups.values()]
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
 * KTD9's "best quality" ordering: pixel count (width * height) descending,
 * file size descending as a tie-breaker. A member with no metrics yet (still
 * computing) sorts as 0x0/0 bytes, i.e. last — this only matters in practice
 * for members that already participate in an identical/similar relationship,
 * which requires a resolved (non-null) hash and therefore resolved metrics.
 */
function compareByQualityDescending(
  a: string,
  b: string,
  metrics: Map<string, PhotoMetrics | undefined>
): number {
  const metricsA = metrics.get(a)
  const metricsB = metrics.get(b)
  const pixelsA = (metricsA?.width ?? 0) * (metricsA?.height ?? 0)
  const pixelsB = (metricsB?.width ?? 0) * (metricsB?.height ?? 0)
  if (pixelsA !== pixelsB) return pixelsB - pixelsA
  return (metricsB?.size ?? 0) - (metricsA?.size ?? 0)
}

/** The single best-by-quality (KTD9) member id among `ids`. `ids` must be non-empty. */
function bestQualityMember(ids: string[], metrics: Map<string, PhotoMetrics | undefined>): string {
  return [...ids].sort((a, b) => compareByQualityDescending(a, b, metrics))[0]
}

/**
 * Shared toggle mechanics for a per-cluster `Map<clusterId, Set<memberId>>`
 * selection: copy-or-default the cluster's current `Set`, add/delete `id`,
 * write it back into a new `Map`. Used by both `similarSelections` (U4's
 * dedup-keeper choice) and `timestampSelections` (U5's timestamp-edit
 * choice) — the two Maps stay separate (they represent independently
 * toggleable concepts a member can carry at once), only this update
 * mechanic is shared.
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

const TIER_STYLES: Record<RelationshipTier, string> = {
  identical: 'ring-2 ring-emerald-500 dark:ring-emerald-400 rounded-lg',
  similar: 'ring-2 ring-amber-500 dark:ring-amber-400 rounded-lg',
}

const TIER_LABELS: Record<RelationshipTier, string> = {
  identical: 'Identical',
  similar: 'Similar',
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

export default function ClusterView({ photos, metrics, getObjectUrl, removePhotos, batchSetTimestamps }: ClusterViewProps) {
  const photosById = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos])

  // The clustering pipeline (O(n^2) pairwise Hamming distance, KTD5) only
  // needs to rerun when its actual inputs — `photos`/`metrics` — change, not
  // on every local selection-state update (a keeper toggle, a timestamp-edit
  // checkbox) that also re-renders this component.
  const sortedClusters = useMemo(() => {
    const hashInputs = photos.map((photo) => ({
      id: photo.id,
      // A photo whose metrics are still in flight (absent map entry, or
      // present-but-`undefined`) is treated the same as "no hash" — it
      // renders as a temporary singleton and re-clusters correctly once its
      // real hash lands and `metrics` updates (KTD12).
      hash: metrics.get(photo.id)?.hash ?? null,
    }))
    const clusters = clusterPhotos(hashInputs, CLUSTER_THRESHOLDS)
    return [...clusters].sort(
      (a, b) => earliestCapturedAtMs(a, photosById) - earliestCapturedAtMs(b, photosById)
    )
  }, [photos, metrics, photosById])

  // R6: per-cluster identical-tier auto-resolution, derived from
  // `sortedClusters` so it only recomputes alongside it. A ref (not state)
  // tracks which removals have already been *initiated* so the effect below
  // never issues the same `removePhotos` call twice, and never reacts to the
  // smaller post-removal cluster shape as if it were a new duplicate set.
  const identicalResolutions = useMemo(() => sortedClusters.flatMap((cluster) =>
    identicalSubgroups(cluster).flatMap((group) => {
      if (group.length < 2) return [] // nothing to compare against — defensive guard
      const best = bestQualityMember(group, metrics)
      const toRemove = group.filter((id) => id !== best)
      if (toRemove.length === 0) return []
      // Keyed by the sorted ids being removed (not `cluster.id`, which is
      // reassigned on every `clusterPhotos` call) so the same real-world
      // removal is recognized as already-handled even across recomputes.
      const key = [...toRemove].sort().join(',')
      return [{ key, toRemove }]
    })
  ), [sortedClusters, metrics])

  const initiatedRemovalsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    for (const { key, toRemove } of identicalResolutions) {
      if (initiatedRemovalsRef.current.has(key)) continue
      initiatedRemovalsRef.current.add(key)
      removePhotos(toRemove)
    }
  })

  // R7: per-cluster similar-tier suggested-keep selection, scoped by
  // `clusterKey` (not `cluster.id` — see its doc comment). A cluster with no recorded selection yet falls back to the
  // best-by-quality member as its suggested keep (KTD9) — computed lazily on
  // read rather than seeded via an effect, so there's no extra render/effect
  // cycle before the suggested selection is visible.
  const [similarSelections, setSimilarSelections] = useState<Map<string, Set<string>>>(new Map())

  function defaultSimilarSelection(similarIds: string[]): Set<string> {
    return new Set([bestQualityMember(similarIds, metrics)])
  }

  function toggleSimilarSelection(clusterId: string, similarIds: string[], id: string, checked: boolean) {
    toggleInClusterSelection(setSimilarSelections, clusterId, id, checked, () => defaultSimilarSelection(similarIds))
  }

  function handleRemoveNonSelected(clusterId: string, similarIds: string[]) {
    const selected = similarSelections.get(clusterId) ?? defaultSimilarSelection(similarIds)
    removePhotos(similarIds.filter((id) => !selected.has(id)))
  }

  // U5: per-cluster "selected for timestamp edit" selection, keyed by
  // `clusterKey` (not `cluster.id`). Independent of `similarSelections` above — a different
  // concept (which similar-tier members survive dedup) even though both use
  // the same checkbox UI pattern. Every member of a cluster is eligible
  // (not just similar-tier), and defaults to empty (nothing selected) until
  // the user picks something, unlike `similarSelections`'s pre-selected
  // default.
  const [timestampSelections, setTimestampSelections] = useState<Map<string, Set<string>>>(new Map())

  function toggleTimestampSelection(clusterId: string, id: string, checked: boolean) {
    toggleInClusterSelection(setTimestampSelections, clusterId, id, checked, () => new Set<string>())
  }

  return (
    <div className="flex flex-col gap-8">
      {sortedClusters.map((cluster) => {
        const key = clusterKey(cluster)
        const similarIds = cluster.members.filter((id) => memberTier(cluster, id) === 'similar')
        const selectedKeepers = similarIds.length > 0
          ? similarSelections.get(key) ?? defaultSimilarSelection(similarIds)
          : null
        const timestampSelected = timestampSelections.get(key) ?? new Set<string>()

        return (
          <section key={key} className="flex flex-col gap-3">
            <h2 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
              {cluster.members.length > 1 ? `${cluster.members.length} related photos` : 'Photo'}
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {cluster.members.map((id) => {
                const entry = photosById.get(id)
                if (!entry) return null
                const tier = memberTier(cluster, id)
                const isSimilar = tier === 'similar'
                return (
                  <div
                    key={id}
                    role={tier ? 'group' : undefined}
                    aria-label={tier ? TIER_LABELS[tier] : undefined}
                    className={tier ? TIER_STYLES[tier] : undefined}
                  >
                    {tier && <span className="sr-only">{TIER_LABELS[tier]}</span>}
                    <PhotoCard
                      entry={entry}
                      objectUrl={getObjectUrl(entry.file)}
                      onSelect={
                        isSimilar
                          ? (checked) => toggleSimilarSelection(key, similarIds, id, checked)
                          : undefined
                      }
                      checked={isSimilar ? (selectedKeepers?.has(id) ?? false) : undefined}
                    />
                    {/*
                      U5's timestamp-edit selection: a dedicated checkbox,
                      independent of PhotoCard's own onSelect/checked pair
                      above (which is U4's similar-tier dedup selection).
                      Every member is eligible, not just similar-tier ones.
                    */}
                    <label className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={timestampSelected.has(id)}
                        onChange={(e) => toggleTimestampSelection(key, id, e.target.checked)}
                        aria-label={`Select ${entry.filename} for timestamp edit`}
                        className="h-3.5 w-3.5"
                      />
                      Timestamp edit
                    </label>
                  </div>
                )
              })}
            </div>
            {selectedKeepers && (
              <div>
                <button
                  type="button"
                  onClick={() => handleRemoveNonSelected(key, similarIds)}
                  disabled={selectedKeepers.size === 0}
                  className="px-3 py-1.5 text-xs font-medium bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Remove non-selected
                </button>
              </div>
            )}
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
