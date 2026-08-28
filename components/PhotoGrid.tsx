'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import type { PhotoEntry } from '@/hooks/usePhotos'
import { useClusteredPhotos, clusterKey, earliestCapturedAtMs, type Cluster } from '@/hooks/useClusteredPhotos'
import PhotoCard from './PhotoCard'
import SortablePhotoCard from './SortablePhotoCard'

// Unified default: only exact duplicates (distance 0) are grouped out of
// the box, so the grid's contents match today's flat timeline unless the
// batch actually contains exact duplicates. Raising the slider groups
// progressively more photos live.
const DEFAULT_SIMILARITY_PERCENT = 0
const MIN_SIMILARITY_PERCENT = 0
const MAX_SIMILARITY_PERCENT = 100

// Dedicated full-month UTC formatter for day-separator headers — a
// page-level landmark, not a per-card label, so this is deliberately NOT
// PhotoCard.tsx's `dateFormatter` (which uses `month: 'short'` and includes
// a time-of-day, appropriate for a compact per-card timestamp but not a day
// header).
const dayHeaderFormatter = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  // Mirrors PhotoCard.tsx's dateFormatter: exifr builds Date objects via
  // Date.UTC, so EXIF clock times are stored as UTC values. Bucketing by
  // local time would silently misfile a photo relative to the date already
  // shown on its own card.
  timeZone: 'UTC',
})

// Sentinel day-bucket key for every all-null-anchor cluster/single.
// `earliestCapturedAtMs`'s `Infinity` fallback always sorts after every
// finite anchor, so — same reasoning as `dayBuckets` below — every
// all-null-anchor unit is guaranteed contiguous at the tail of the
// flattened sequence, giving exactly one trailing "Undated" bucket.
const UNDATED_DAY_KEY = 'undated'

/**
 * UTC-calendar-day key for a day-anchor ms value — `Infinity` (the anchor
 * helper's all-null fallback) always maps to `UNDATED_DAY_KEY` rather than
 * a real calendar day.
 */
function dayKeyFor(anchorMs: number): string {
  if (!Number.isFinite(anchorMs)) return UNDATED_DAY_KEY
  const d = new Date(anchorMs)
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`
}

/**
 * One `renderBlocks` entry reduced to "what day does it belong under, and
 * as what kind of visual unit": a whole `'cluster'` render block is always
 * one unit — a cluster's day placement is its earliest member's day, never
 * split even when its members span multiple days — while a `'singles'`
 * block is exploded into one unit per individual 1-member cluster, since it
 * bundles any run of chronologically-adjacent 1-member clusters with no
 * day-boundary awareness in how it was built, so a single block can
 * legitimately span multiple UTC days when no 2+-member cluster interrupts
 * the run.
 */
type DayUnit = { kind: 'cluster'; cluster: Cluster; anchorMs: number } | { kind: 'single'; cluster: Cluster; anchorMs: number }

type Props = {
  photos: PhotoEntry[]
  getObjectUrl: (file: File) => string
  onReorder?: (from: number, to: number) => void
  onNameChange?: (id: string, newName: string) => void
  onTimestampChange?: (id: string, newDate: Date | null) => void
  selectedIds?: Set<string>
  onSelect?: (id: string, checked: boolean) => void
  onDelete?: (id: string) => void
  onZoom?: (id: string) => void
  /**
   * Reports the true flattened visual order (see `useClusteredPhotos`'s
   * `visualOrder`) up to the parent whenever it changes — `PhotoGrid` has no
   * other channel to expose this internally-computed state, and
   * `components/PhotoUploadPage.tsx`'s `handleDragEnd` needs it to resolve a
   * drop's true visual neighbors instead of the flat `photos` array's
   * chronological neighbors, which can diverge from visual order whenever a
   * cluster isn't array-contiguous.
   */
  onVisualOrderChange?: (order: string[]) => void
}

export default function PhotoGrid({
  photos,
  getObjectUrl,
  onReorder,
  onNameChange,
  onTimestampChange,
  selectedIds,
  onSelect,
  onDelete,
  onZoom,
  onVisualOrderChange,
}: Props) {
  const [similarityPercent, setSimilarityPercent] = useState(DEFAULT_SIMILARITY_PERCENT)
  const { renderBlocks, photosById, visualOrder, availability, isLoading } = useClusteredPhotos(
    photos,
    similarityPercent
  )

  // Reports the true visual order up to the parent only when it actually
  // changes (not on every render) — `onVisualOrderChange` is expected to
  // stash this in a ref rather than state, so this effect firing is cheap
  // and doesn't itself trigger a re-render loop.
  useEffect(() => {
    onVisualOrderChange?.(visualOrder)
  }, [visualOrder, onVisualOrderChange])

  const renderCard = useCallback(
    (id: string) => {
      const entry = photosById.get(id)
      if (!entry) return null

      const card = onReorder ? (
        <SortablePhotoCard
          id={id}
          entry={entry}
          objectUrl={getObjectUrl(entry.file)}
          onNameChange={onNameChange ? (name) => onNameChange(id, name) : undefined}
          onTimestampChange={onTimestampChange ? (date) => onTimestampChange(id, date) : undefined}
          onSelect={onSelect ? (checked) => onSelect(id, checked) : undefined}
          checked={selectedIds?.has(id)}
          onDelete={onDelete ? () => onDelete(id) : undefined}
          onZoom={onZoom ? () => onZoom(id) : undefined}
        />
      ) : (
        <PhotoCard
          entry={entry}
          objectUrl={getObjectUrl(entry.file)}
          onNameChange={onNameChange ? (name) => onNameChange(id, name) : undefined}
          onTimestampChange={onTimestampChange ? (date) => onTimestampChange(id, date) : undefined}
          onSelect={onSelect ? (checked) => onSelect(id, checked) : undefined}
          checked={selectedIds?.has(id)}
          onDelete={onDelete ? () => onDelete(id) : undefined}
          onZoom={onZoom ? () => onZoom(id) : undefined}
        />
      )

      return (
        <div key={id} className="flex flex-col gap-1">
          {card}
        </div>
      )
    },
    [
      photosById,
      onReorder,
      getObjectUrl,
      onNameChange,
      onTimestampChange,
      onSelect,
      selectedIds,
      onDelete,
      onZoom,
    ]
  )

  // Flattens renderBlocks into day-anchored units (see DayUnit above), then
  // groups them into day buckets by consecutive same-day-key runs. This is
  // safe -- i.e. never scatters one calendar day across two buckets --
  // because `renderBlocks` (and transitively every unit's own anchor) is
  // already sorted ascending by `earliestCapturedAtMs` (see
  // `useClusteredPhotos.ts`'s `displayClusters`), and UTC calendar day is a
  // monotonic function of ms, so same-day units are always contiguous in
  // this flattened sequence, never interleaved with a different day's
  // units. The all-null `Infinity` anchor sorts last for the same reason,
  // so `UNDATED_DAY_KEY` units always end up contiguous at the very end --
  // exactly one trailing "Undated" bucket, never a scattered one.
  //
  // Deliberately NOT computed inside `hooks/useClusteredPhotos.ts`:
  // `renderBlocks`'s shape and `visualOrder` stay completely untouched by
  // day-grouping, so drag-and-drop can never be affected by it.
  const dayBuckets = useMemo(() => {
    const units: DayUnit[] = []
    for (const block of renderBlocks) {
      if (block.type === 'cluster') {
        units.push({
          kind: 'cluster',
          cluster: block.cluster,
          anchorMs: earliestCapturedAtMs(block.cluster, photosById),
        })
      } else {
        for (const cluster of block.clusters) {
          units.push({ kind: 'single', cluster, anchorMs: earliestCapturedAtMs(cluster, photosById) })
        }
      }
    }

    const buckets: Array<{ key: string; anchorMs: number; units: DayUnit[] }> = []
    for (const unit of units) {
      const key = dayKeyFor(unit.anchorMs)
      const last = buckets[buckets.length - 1]
      if (last && last.key === key) last.units.push(unit)
      else buckets.push({ key, anchorMs: unit.anchorMs, units: [unit] })
    }
    return buckets
  }, [renderBlocks, photosById])

  // Memoized separately from `blocksContent` below: `dayBuckets` is itself
  // already memoized and typically unchanged across renders triggered by
  // unrelated state (e.g. `selectedIds`) — without this, the block/key
  // derivation below re-ran on every such render regardless.
  const blocks = useMemo(
    () =>
      dayBuckets.map((bucket) => {
        const headerLabel =
          bucket.key === UNDATED_DAY_KEY ? 'Undated' : dayHeaderFormatter.format(new Date(bucket.anchorMs))

        // Within a day bucket, consecutive 'single' units re-form one grid
        // run (mirroring how a 'singles' render block renders as one grid
        // today) — a 'cluster' unit always breaks the run and renders as
        // its own bordered section, exactly as it did before day-bucketing
        // existed.
        const content: React.ReactNode[] = []
        let singlesRun: Cluster[] = []
        const flushSinglesRun = () => {
          if (singlesRun.length === 0) return
          const runKey = singlesRun.map(clusterKey).sort().join(',')
          content.push(
            <div key={runKey} className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {singlesRun.map((cluster) => renderCard(cluster.members[0]))}
            </div>
          )
          singlesRun = []
        }

        for (const unit of bucket.units) {
          if (unit.kind === 'single') {
            singlesRun.push(unit.cluster)
            continue
          }
          flushSinglesRun()
          const cluster = unit.cluster
          const key = clusterKey(cluster)
          content.push(
            <section
              key={key}
              className="flex flex-col gap-3 rounded-xl border border-zinc-300 dark:border-zinc-600 bg-zinc-100/70 dark:bg-zinc-800/40 p-4"
            >
              <h2 className="text-xs font-medium text-zinc-500 dark:text-zinc-400 uppercase tracking-wide">
                {cluster.members.length} related photos
              </h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                {cluster.members.map((id) => renderCard(id))}
              </div>
            </section>
          )
        }
        flushSinglesRun()

        return (
          <div key={bucket.key} className="flex flex-col gap-4">
            {/* Day-boundary header -- plain, non-sticky heading in normal
                document flow, visually more prominent than the per-cluster
                "N related photos" <h2> above (bigger, bolder, not
                uppercase/tracked-out). */}
            <h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-50">{headerLabel}</h2>
            <div className="flex flex-col gap-8">{content}</div>
          </div>
        )
      }),
    [dayBuckets, renderCard]
  )

  const blocksContent = <div className="flex flex-col gap-8">{blocks}</div>

  // R12/R13/KTD13: the slider is disabled both while the initial health
  // check hasn't resolved yet ('checking') and once the service is known
  // unavailable ('unavailable') — only the latter also shows the
  // "Clustering service unavailable" message (KTD10 unifies the initial
  // health-check failure and a mid-session cluster-call failure into this
  // one message/code path).
  const sliderDisabled = availability === 'checking' || availability === 'unavailable'

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
            disabled={sliderDisabled}
          />
          <span className="text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap tabular-nums">
            {similarityPercent}%
          </span>
          {isLoading && (
            <span role="status" className="text-xs text-zinc-400 dark:text-zinc-500 whitespace-nowrap">
              Updating…
            </span>
          )}
        </div>
        {availability === 'unavailable' && (
          <p className="text-xs text-red-600 dark:text-red-400">Clustering service unavailable</p>
        )}
      </div>

      {onReorder ? (
        <SortableContext items={visualOrder} strategy={rectSortingStrategy}>
          {blocksContent}
        </SortableContext>
      ) : (
        blocksContent
      )}
    </div>
  )
}
