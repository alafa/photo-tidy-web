'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import type { PhotoEntry } from '@/hooks/usePhotos'
import { useClusteredPhotos, clusterKey } from '@/hooks/useClusteredPhotos'
import PhotoCard from './PhotoCard'
import SortablePhotoCard from './SortablePhotoCard'

// R2's unified default: only exact duplicates (distance 0) are grouped out
// of the box, so the grid's contents match today's flat timeline unless the
// batch actually contains exact duplicates. Raising the slider groups
// progressively more photos live (R3).
const DEFAULT_SIMILARITY_PERCENT = 0
const MIN_SIMILARITY_PERCENT = 0
const MAX_SIMILARITY_PERCENT = 100

type Props = {
  photos: PhotoEntry[]
  getObjectUrl: (file: File) => string
  onReorder?: (from: number, to: number) => void
  onNameChange?: (id: string, newName: string) => void
  onTimestampChange?: (id: string, newDate: Date | null) => void
  selectedIds?: Set<string>
  onSelect?: (id: string, checked: boolean) => void
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
        />
      ) : (
        <PhotoCard
          entry={entry}
          objectUrl={getObjectUrl(entry.file)}
          onNameChange={onNameChange ? (name) => onNameChange(id, name) : undefined}
          onTimestampChange={onTimestampChange ? (date) => onTimestampChange(id, date) : undefined}
          onSelect={onSelect ? (checked) => onSelect(id, checked) : undefined}
          checked={selectedIds?.has(id)}
        />
      )

      return (
        <div key={id} className="flex flex-col gap-1">
          {card}
        </div>
      )
    },
    [photosById, onReorder, getObjectUrl, onNameChange, onTimestampChange, onSelect, selectedIds]
  )

  // Memoized separately from `blocksContent` below: `renderBlocks` (from
  // `useClusteredPhotos`) is itself already memoized and typically unchanged
  // across renders triggered by unrelated state (e.g. `selectedIds`) —
  // without this, the block/key derivation below re-ran on every such
  // render regardless.
  const blocks = useMemo(
    () =>
      renderBlocks.map((block) => {
        if (block.type === 'singles') {
          const blockKey = block.clusters.map(clusterKey).sort().join(',')
          return (
            <div key={blockKey} className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {block.clusters.map((cluster) => renderCard(cluster.members[0]))}
            </div>
          )
        }

        const cluster = block.cluster
        const key = clusterKey(cluster)
        return (
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
      }),
    [renderBlocks, renderCard]
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
