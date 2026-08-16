'use client'

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { PhotoMetrics } from '@/lib/perceptual-hash'
import { clusterPhotos, type Cluster, type RelationshipTier } from '@/lib/photo-clustering'
import { parseDatetimeLocalAsUTC } from '@/lib/datetime-local'
import PhotoCard from './PhotoCard'

// KTD2's starting Hamming-distance thresholds (out of a 64-bit hash). The
// identical tier stays fixed — it drives automatic, no-confirmation removal
// (R6), so it is deliberately not user-adjustable: loosening it would make
// auto-delete more aggressive, which is a different and riskier axis than
// "how much shows up together for review." The similar tier is
// user-adjustable via the slider below (feedback: the original fixed value
// of 12 was too strict — two copies of the same photo with a hand-drawn
// line added didn't cluster as similar).
const IDENTICAL_THRESHOLD = 3
const DEFAULT_SIMILAR_THRESHOLD = 20
const MIN_SIMILAR_THRESHOLD = IDENTICAL_THRESHOLD + 1
// Beyond ~half the hash's bit width, two hashes are no more alike than
// chance — looser than this stops meaning "similar" at all.
const MAX_SIMILAR_THRESHOLD = 32

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
  /**
   * `hooks/usePhotos.ts`'s `restorePhoto`, used to undo an automatic
   * identical-tier removal — re-inserts the exact removed `PhotoEntry` back
   * into the batch.
   */
  restorePhoto: (entry: PhotoEntry) => void
}

type MemberTier = RelationshipTier | null

/**
 * A cluster's `relationships` are per-pair, not per-member. This computes,
 * in one O(edges) pass, a "highest tier this member participates in" label
 * for every member: a member touched by any `identical`-tier relationship
 * is identical-flagged (identical wins over similar); else similar-flagged
 * if touched by any `similar`-tier relationship; else (a true singleton
 * with zero relationships) no flag at all. Computed once per cluster
 * (memoized alongside `sortedClusters`) rather than re-scanning
 * `cluster.relationships` from scratch for every member on every render.
 */
function computeMemberTiers(cluster: Cluster): Map<string, MemberTier> {
  const tiers = new Map<string, MemberTier>()
  for (const id of cluster.members) tiers.set(id, null)
  for (const relationship of cluster.relationships) {
    for (const id of [relationship.a, relationship.b]) {
      if (tiers.get(id) === 'identical') continue
      tiers.set(id, relationship.tier === 'identical' ? 'identical' : 'similar')
    }
  }
  return tiers
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
function identicalSubgroups(cluster: Cluster, tiers: Map<string, MemberTier>): string[][] {
  const identicalIds = cluster.members.filter((id) => tiers.get(id) === 'identical')
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

export default function ClusterView({ photos, metrics, getObjectUrl, removePhotos, batchSetTimestamps, restorePhoto }: ClusterViewProps) {
  const photosById = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos])

  // R1's grouping aggressiveness, live-adjustable via the slider below.
  // The identical tier is deliberately not part of this state — see
  // IDENTICAL_THRESHOLD's comment.
  const [similarThreshold, setSimilarThreshold] = useState(DEFAULT_SIMILAR_THRESHOLD)

  // The clustering pipeline (O(n^2) pairwise Hamming distance, KTD5) only
  // needs to rerun when its actual inputs — `photos`/`metrics`/the slider —
  // change, not on every local selection-state update (a keeper toggle, a
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
    const clusters = clusterPhotos(hashInputs, { identical: IDENTICAL_THRESHOLD, similar: similarThreshold })
    return [...clusters].sort(
      (a, b) => earliestCapturedAtMs(a, photosById) - earliestCapturedAtMs(b, photosById)
    )
  }, [photos, metrics, photosById, similarThreshold])

  // Per-cluster member-tier maps, computed once per cluster (O(edges) each)
  // alongside `sortedClusters` rather than re-scanning relationships from
  // scratch for every member on every render (including renders triggered
  // by unrelated selection-state updates elsewhere in this component).
  const clusterTiers = useMemo(
    () => new Map(sortedClusters.map((cluster) => [clusterKey(cluster), computeMemberTiers(cluster)])),
    [sortedClusters]
  )

  // Ids the user has explicitly undone an automatic removal for. Excluded
  // from `toRemove` below permanently for this session — without this, an
  // undo on a 3+-way identical group (restore one of several duplicates)
  // would recompute a fresh sub-group containing just the restored photo
  // and immediately auto-remove it again.
  const [undoneIds, setUndoneIds] = useState<Set<string>>(new Set())

  // R6: per-cluster identical-tier auto-resolution, derived from
  // `sortedClusters` so it only recomputes alongside it.
  const identicalResolutions = useMemo(() => sortedClusters.flatMap((cluster) =>
    identicalSubgroups(cluster, clusterTiers.get(clusterKey(cluster))!).flatMap((group) => {
      if (group.length < 2) return [] // nothing to compare against — defensive guard
      const best = bestQualityMember(group, metrics)
      const toRemove = group.filter((id) => id !== best && !undoneIds.has(id))
      if (toRemove.length === 0) return []
      return [{ owner: best, toRemove }]
    })
  ), [sortedClusters, clusterTiers, metrics, undoneIds])

  // Tracks *individual* ids already sent to `removePhotos`, not whole
  // removal groups — a per-group key (e.g. the sorted `toRemove` list)
  // would under-guard a partial undo: undoing one member of a 3+-way
  // identical group recomputes a *smaller* sub-group containing ids already
  // removed in an earlier firing (e.g. undoing p2 from {p1 best, p2, p3}
  // recomputes toRemove=[p3], a group never seen before), which would
  // re-send an already-removed id and double-record it in `removedByOwner`.
  // Tracking per id makes "already sent to removePhotos" the actual
  // invariant, so it can never re-fire regardless of how the group reshapes.
  const initiatedRemovalsRef = useRef<Set<string>>(new Set())

  // Duplicates auto-removed this session, kept visible (feedback: users
  // couldn't see or undo what got auto-deleted) — keyed by the surviving
  // member's id (a real, permanent photo id, unlike `cluster.id`/`clusterKey`
  // which can both change once membership shrinks). Captured from
  // `photosById` *before* `removePhotos` fires, since the entry disappears
  // from `photos` the moment the parent's state updates.
  const [removedByOwner, setRemovedByOwner] = useState<Map<string, PhotoEntry[]>>(new Map())
  const [expandedOwners, setExpandedOwners] = useState<Set<string>>(new Set())

  useEffect(() => {
    for (const { owner, toRemove } of identicalResolutions) {
      const freshIds = toRemove.filter((id) => !initiatedRemovalsRef.current.has(id))
      if (freshIds.length === 0) continue
      for (const id of freshIds) initiatedRemovalsRef.current.add(id)
      const removedEntries = freshIds
        .map((id) => photosById.get(id))
        .filter((entry): entry is PhotoEntry => entry !== undefined)
      if (removedEntries.length > 0) {
        setRemovedByOwner((prev) => {
          const next = new Map(prev)
          next.set(owner, [...(next.get(owner) ?? []), ...removedEntries])
          return next
        })
      }
      removePhotos(freshIds)
    }
    // `identicalResolutions` is itself memoized (stable unless sortedClusters/
    // clusterTiers/metrics/undoneIds change), so this only needs to rerun
    // when one of those actually changes — not on every render (e.g. an
    // unrelated `expandedOwners` toggle). The per-id `initiatedRemovalsRef`
    // guard above is what makes this safe regardless.
  }, [identicalResolutions, removePhotos, photosById])

  function toggleExpandedRemoved(owner: string) {
    setExpandedOwners((prev) => {
      const next = new Set(prev)
      if (next.has(owner)) next.delete(owner)
      else next.add(owner)
      return next
    })
  }

  function handleUndoRemoval(owner: string, entry: PhotoEntry) {
    setUndoneIds((prev) => new Set(prev).add(entry.id))
    setRemovedByOwner((prev) => {
      const next = new Map(prev)
      const remaining = (next.get(owner) ?? []).filter((e) => e.id !== entry.id)
      if (remaining.length > 0) next.set(owner, remaining)
      else next.delete(owner)
      return next
    })
    restorePhoto(entry)
  }

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

  // A cluster with only one member no longer being a duplicate/near-duplicate
  // of anything shouldn't visually read as a "cluster" (feedback: it looked
  // like a group of one, complete with a heading and border). Adjacent
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

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center gap-3">
        <label htmlFor="similarity-threshold" className="text-xs font-medium text-zinc-600 dark:text-zinc-400 whitespace-nowrap">
          Grouping strictness
        </label>
        <input
          id="similarity-threshold"
          type="range"
          min={MIN_SIMILAR_THRESHOLD}
          max={MAX_SIMILAR_THRESHOLD}
          value={similarThreshold}
          onChange={(e) => setSimilarThreshold(Number(e.target.value))}
          aria-label="Similarity grouping threshold — drag left for stricter, right for looser"
          className="flex-1 max-w-xs"
        />
        <span className="text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap">
          {similarThreshold === MIN_SIMILAR_THRESHOLD ? 'Strict' : similarThreshold === MAX_SIMILAR_THRESHOLD ? 'Loose' : `${similarThreshold}/${MAX_SIMILAR_THRESHOLD}`}
        </span>
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
                return <PhotoCard key={id} entry={entry} objectUrl={getObjectUrl(entry.file)} />
              })}
            </div>
          )
        }

        const cluster = block.cluster
        const key = clusterKey(cluster)
        const tiers = clusterTiers.get(key)!
        const similarIds = cluster.members.filter((id) => tiers.get(id) === 'similar')
        const selectedKeepers = similarIds.length > 0
          ? similarSelections.get(key) ?? defaultSimilarSelection(similarIds)
          : null
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
                const tier = tiers.get(id) ?? null
                const isSimilar = tier === 'similar'
                const removedDuplicates = removedByOwner.get(id) ?? []
                const isExpanded = expandedOwners.has(id)
                return (
                  <div key={id} className="flex flex-col gap-1.5">
                    <div
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
                    {removedDuplicates.length > 0 && (
                      <div>
                        <button
                          type="button"
                          onClick={() => toggleExpandedRemoved(id)}
                          className="text-[11px] text-zinc-500 dark:text-zinc-400 underline"
                        >
                          {isExpanded
                            ? 'Hide removed'
                            : `${removedDuplicates.length} duplicate${removedDuplicates.length !== 1 ? 's' : ''} removed`}
                        </button>
                        {isExpanded && (
                          <ul className="mt-1.5 flex flex-col gap-1.5">
                            {removedDuplicates.map((removedEntry) => (
                              <li
                                key={removedEntry.id}
                                className="flex items-center gap-2 rounded-md border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 p-1.5"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element -- blob: URLs are incompatible with next/image optimizer */}
                                <img
                                  src={getObjectUrl(removedEntry.file)}
                                  alt={removedEntry.filename}
                                  className="w-10 h-10 object-cover rounded blur-[1px] opacity-50"
                                />
                                <span className="text-[11px] text-zinc-500 dark:text-zinc-400 truncate">Removed</span>
                                <button
                                  type="button"
                                  onClick={() => handleUndoRemoval(id, removedEntry)}
                                  className="ml-auto text-[11px] font-medium text-zinc-700 dark:text-zinc-200 underline whitespace-nowrap"
                                >
                                  Undo
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
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
