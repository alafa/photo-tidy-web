'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core'
import { arrayMove } from '@dnd-kit/sortable'
import { usePhotos } from '@/hooks/usePhotos'
import { useObjectUrls } from '@/hooks/useObjectUrls'
import { useGoogleAuth } from '@/hooks/useGoogleAuth'
import { useGooglePhotosPicker } from '@/hooks/useGooglePhotosPicker'
import { useGooglePhotosUpload } from '@/hooks/useGooglePhotosUpload'
import { usePhotoPersistence } from '@/hooks/usePhotoPersistence'
import PhotoCard from './PhotoCard'
import PhotoGrid from './PhotoGrid'
import PhotoLightbox from './PhotoLightbox'
import BatchEditPanel from './BatchEditPanel'
import GoogleAuthStatus from './GoogleAuthStatus'
import GooglePhotosUploadPanel from './GooglePhotosUploadPanel'
import { downloadAll } from '@/lib/download'

/**
 * Computes the new timestamp for a photo dropped between `prevCapturedAt`
 * and `nextCapturedAt` — its TRUE final visual neighbors after the drop, not
 * neighbors resolved from the flat, purely-chronological `photos` array
 * (which can disagree with visual order whenever a cluster isn't
 * array-contiguous; see `hooks/useClusteredPhotos.ts`'s `visualOrder` doc).
 *
 * Ports the exact same midpoint/edge-offset algorithm
 * `hooks/usePhotos.ts`'s `slotTimestamp` already uses, rather than
 * reinventing it, so a drop's resulting timestamp is computed identically
 * regardless of which neighbor set (flat-array vs. true-visual) it's fed.
 */
function computeDroppedTimestamp(
  prevCapturedAt: Date | null,
  nextCapturedAt: Date | null,
  currentCapturedAt: Date | null
): Date | null {
  if (prevCapturedAt !== null && nextCapturedAt !== null) {
    // Midpoint between neighbours
    return new Date(Math.round((prevCapturedAt.getTime() + nextCapturedAt.getTime()) / 2))
  }
  if (prevCapturedAt !== null) {
    // Moved to the end — one second after the previous photo
    return new Date(prevCapturedAt.getTime() + 1000)
  }
  if (nextCapturedAt !== null) {
    // Moved to the start — one second before the next photo
    return new Date(nextCapturedAt.getTime() - 1000)
  }
  // Only photo, or all neighbours have null timestamps — keep as-is
  return currentCapturedAt
}

export default function PhotoUploadPage() {
  const {
    photos,
    processFiles,
    addPhotos,
    reorderPhotos,
    updatePhotoName,
    updatePhotoTimestamp,
    batchUpdateNames,
    batchSetTimestamps,
    removePhotos,
    hydratePhotos,
    setPhotoMediaItemId,
  } = usePhotos()
  const { getObjectUrl, releaseObjectUrl } = useObjectUrls()
  const { isSignedIn, accountEmail, isExpiringSoon, accessToken, signIn, signOut } = useGoogleAuth()
  const {
    status: pickerStatus,
    error: pickerError,
    startImport,
    cancelImport,
  } = useGooglePhotosPicker({ accessToken, addPhotos })
  const { uploadState, photoStates, startUpload, retryFailed, reset, seedPhotoStates, notifyPhotoRemoved } =
    useGooglePhotosUpload({ onMediaItemIdSet: setPhotoMediaItemId })
  const { isRestoring, storageWarning, clearAllPersisted } = usePhotoPersistence(
    photos,
    hydratePhotos,
    seedPhotoStates
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [albumName, setAlbumName] = useState('')
  const [isNamePromptOpen, setIsNamePromptOpen] = useState(false)
  const [namePromptValue, setNamePromptValue] = useState('')
  // Which photo (if any) the lightbox is currently showing, set by a card's
  // zoom icon and cleared by PhotoLightbox's onClose. PhotoLightbox
  // captures document.activeElement on its own mount to handle focus
  // return, so no extra ref is needed here -- the triggering zoom icon
  // still has focus at the moment this state update causes the lightbox to
  // mount.
  const [zoomedPhotoId, setZoomedPhotoId] = useState<string | null>(null)

  // Add distance constraint so short clicks don't trigger drag (allows checkboxes + inputs to work)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const activeEntry = activeId ? photos.find((p) => p.id === activeId) : null

  // The true flattened visual order `PhotoGrid` last rendered (see
  // `hooks/useClusteredPhotos.ts`'s `visualOrder` doc) — a ref, not state,
  // so receiving an update via `handleVisualOrderChange` below doesn't
  // itself trigger a render; `handleDragEnd` (a plain function, not a hook)
  // reads `visualOrderRef.current` fresh on every invocation instead.
  const visualOrderRef = useRef<string[]>([])

  // Reactive mirror of the same order, kept for the lightbox's prev/next
  // navigation (which needs to re-render when the order changes, unlike
  // handleDragEnd's synchronous ref read above). Kept in sync with
  // visualOrderRef.current on every report.
  const [visualOrder, setVisualOrder] = useState<string[]>([])

  // Stable identity (empty dep array, only touches the ref/setState) so
  // PhotoGrid's `useEffect([visualOrder, onVisualOrderChange])` fires only
  // when `visualOrder` itself changes, not on every PhotoUploadPage render.
  const handleVisualOrderChange = useCallback((order: string[]) => {
    visualOrderRef.current = order
    // Bail out when the reported order is the same ids in the same
    // sequence as what's already stored -- PhotoGrid recomputes `visualOrder`
    // from useClusteredPhotos on every render, so a naive unconditional
    // setState here (with a fresh array reference each time) would re-render
    // this component every time PhotoGrid renders, which re-triggers
    // PhotoGrid's effect, which calls this again -- an infinite update loop.
    // Comparing by content, not reference, breaks that cycle while still
    // updating state whenever the order actually changes.
    setVisualOrder((prev) => {
      if (
        prev.length === order.length &&
        prev.every((id, i) => id === order[i])
      ) {
        return prev
      }
      return order
    })
  }, [])

  const photosById = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos])

  // Resolves the currently-zoomed photo (if any) the same way the rest of
  // this component looks up a photo's object URL -- via getObjectUrl
  // (hooks/useObjectUrls.ts), keyed off photosById.
  const zoomedPhoto = zoomedPhotoId ? photosById.get(zoomedPhotoId) ?? null : null

  // The zoomed photo's previous/next neighbors in the TRUE visual order
  // (not the flat, purely-chronological `photos` array -- see
  // `handleDragEnd`'s doc above for why those two orderings can diverge).
  // `indexOf` naturally yields `undefined` at either edge of `visualOrder`
  // via out-of-bounds array access, so no extra edge-case branching is
  // needed beyond guarding the "lightbox isn't open" (-1) case.
  const currentVisualIndex = zoomedPhotoId ? visualOrder.indexOf(zoomedPhotoId) : -1
  const prevZoomedId = currentVisualIndex === -1 ? undefined : visualOrder[currentVisualIndex - 1]
  const nextZoomedId = currentVisualIndex === -1 ? undefined : visualOrder[currentVisualIndex + 1]

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (isRestoring) return
    if (e.target.files && e.target.files.length > 0) {
      setSelectedIds(new Set())
      processFiles(e.target.files)
      reset()
    }
  }

  function handleDragOver(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    e.stopPropagation()
  }

  function handleDrop(e: React.DragEvent<HTMLLabelElement>) {
    e.preventDefault()
    e.stopPropagation()
    if (isRestoring) return
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setSelectedIds(new Set())
      processFiles(e.dataTransfer.files)
      reset()
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id))
  }

  // Resolves from/to against the TRUE visual order (`visualOrderRef`), not
  // the flat, purely-chronological `photos` array — dnd-kit's `over.id` is
  // resolved from actual DOM hit-testing (i.e. visual order), and a
  // cluster's members aren't guaranteed to be array-contiguous in `photos`
  // (clustering is by hash similarity, not time), so `photos.findIndex`
  // could silently resolve to the wrong neighbors and corrupt the written-
  // back timestamp. See `hooks/useClusteredPhotos.ts`'s `visualOrder` doc.
  //
  // Deliberately does NOT call `reorderPhotos` (`hooks/usePhotos.ts`) — that
  // machinery computes a dropped photo's new timestamp from ITS OWN
  // flat-array neighbors, which is exactly the wrong thing here. Instead,
  // the true final visual neighbors are resolved locally and the same
  // midpoint/edge-offset algorithm (`computeDroppedTimestamp`, ported from
  // `slotTimestamp`) is applied directly via `updatePhotoTimestamp`.
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null)
    if (!over || active.id === over.id) return

    const visualOrder = visualOrderRef.current
    const from = visualOrder.indexOf(active.id as string)
    const to = visualOrder.indexOf(over.id as string)
    if (from === -1 || to === -1) return

    const reordered = arrayMove(visualOrder, from, to)
    const prevEntry = photosById.get(reordered[to - 1])
    const nextEntry = photosById.get(reordered[to + 1])
    const currentEntry = photosById.get(active.id as string)

    const newTimestamp = computeDroppedTimestamp(
      prevEntry?.capturedAt ?? null,
      nextEntry?.capturedAt ?? null,
      currentEntry?.capturedAt ?? null
    )
    updatePhotoTimestamp(active.id as string, newTimestamp)
  }

  function toggleSelect(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  function selectAll() {
    setSelectedIds(new Set(photos.map((p) => p.id)))
  }

  function clearSelection() {
    setSelectedIds(new Set())
  }

  function handleBatchRename(baseName: string) {
    batchUpdateNames(Array.from(selectedIds), baseName)
  }

  function handleBatchSetTimestamp(anchor: Date) {
    batchSetTimestamps(Array.from(selectedIds), anchor)
  }

  // The current selection's distinct existing capturedAt values, deduped
  // by exact millisecond value and sorted ascending — generalized to the
  // whole selection rather than one cluster's members, so it covers a
  // selection spanning multiple clusters or plain timeline photos alike.
  // Recomputed from `photos`/`selectedIds` on every render rather than
  // memoized — this app's photo counts don't warrant it, and every other
  // selection-derived value here (activeEntry, etc.) does the same.
  const seenTimestamps = new Map<number, Date>()
  for (const photo of photos) {
    if (!selectedIds.has(photo.id)) continue
    const capturedAt = photo.capturedAt
    if (capturedAt === null) continue
    if (!seenTimestamps.has(capturedAt.getTime())) seenTimestamps.set(capturedAt.getTime(), capturedAt)
  }
  const distinctSelectedTimestamps = [...seenTimestamps.values()].sort(
    (a, b) => a.getTime() - b.getTime()
  )

  // Accepts an explicit `ids` list (defaulting to the current selection) so
  // the per-card delete icon can delete a single photo that isn't
  // necessarily selected, independent of batch delete. Prunes only those
  // specific ids out of `selectedIds` -- mirroring `toggleSelect`'s
  // build-a-new-Set pattern above -- rather than unconditionally clearing
  // the whole selection, so deleting an unselected photo can't silently
  // wipe out an unrelated multi-photo selection the user already made.
  const handleBatchDelete = useCallback(
    (ids: string[] = Array.from(selectedIds)) => {
      for (const id of ids) {
        const photo = photosById.get(id)
        if (photo) releaseObjectUrl(photo.file)
        notifyPhotoRemoved(id)
      }
      removePhotos(ids)
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
    },
    [selectedIds, photosById, releaseObjectUrl, removePhotos, notifyPhotoRemoved]
  )

  const handleDeletePhoto = useCallback((id: string) => handleBatchDelete([id]), [handleBatchDelete])
  const handleCloseLightbox = useCallback(() => setZoomedPhotoId(null), [])

  // Deletes the currently-zoomed photo and advances the lightbox to its
  // visual neighbor (next preferred, falling back to prev), or closes it if
  // none remain. `prevZoomedId`/`nextZoomedId` are captured from THIS
  // render's pre-delete `visualOrder` state before anything else runs here,
  // per the same visual-order reasoning as `handleDragEnd` above. The
  // `visualOrder` state mirror is spliced immediately (a filter, not
  // mutated in place) so it doesn't wait on the next async recluster
  // round-trip -- `handleDeletePhoto` below still does the real work
  // (object URL release, notifyPhotoRemoved, removePhotos, selectedIds
  // pruning) via the existing, unmodified handleBatchDelete wrapper.
  const handleLightboxDelete = useCallback(() => {
    if (!zoomedPhotoId) return
    const neighbor = nextZoomedId ?? prevZoomedId
    const idToDelete = zoomedPhotoId
    setVisualOrder((prev) => prev.filter((id) => id !== idToDelete))
    handleDeletePhoto(idToDelete)
    setZoomedPhotoId(neighbor ?? null)
  }, [zoomedPhotoId, nextZoomedId, prevZoomedId, handleDeletePhoto])

  // Comprehensive reset (KTD9's "Clear all"): a deliberately much larger
  // blast radius than a single-photo delete, so it's gated behind a native
  // confirm() -- this codebase has no modal/dialog component, and a native
  // confirm is the simplest option consistent with its current UI
  // vocabulary. Order matters: object URLs are released (and
  // notifyPhotoRemoved called) against the CURRENT `photos` before
  // removePhotos clears the in-memory list, then IndexedDB is wiped, then
  // useGooglePhotosUpload's own tracking is reset.
  async function handleClearAll() {
    if (!window.confirm('Clear all photos? This cannot be undone.')) return
    for (const photo of photos) {
      releaseObjectUrl(photo.file)
      notifyPhotoRemoved(photo.id)
    }
    removePhotos(photos.map((p) => p.id))
    await clearAllPersisted()
    reset()
    setSelectedIds(new Set())
  }

  function handleImportClick() {
    setNamePromptValue(albumName)
    setIsNamePromptOpen(true)
  }

  function handleNamePromptContinue() {
    setAlbumName(namePromptValue)
    setIsNamePromptOpen(false)
    startImport()
  }

  function handleNamePromptCancel() {
    setIsNamePromptOpen(false)
    setNamePromptValue('')
  }

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Marked inert while the lightbox is open so its always-visible,
          zero-confirmation delete controls (per-card delete icon,
          BatchEditPanel's "Delete selected") are unreachable by a screen
          reader's browse-mode cursor -- which walks the accessibility tree
          independent of DOM Tab order and isn't constrained by the
          lightbox's Tab-only focus trap. Per the WAI-ARIA APG dialog
          pattern, `aria-modal` on the dialog only signals the boundary;
          `inert` (or `aria-hidden`) on everything else is what actually
          enforces it. */}
      <div className="max-w-6xl mx-auto px-4 py-10" inert={!!zoomedPhoto}>
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50 mb-6">
          photo-tidy
        </h1>

        <GoogleAuthStatus
          isSignedIn={isSignedIn}
          accountEmail={accountEmail}
          isExpiringSoon={isExpiringSoon}
          signIn={signIn}
          signOut={signOut}
        />

        {isRestoring && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400 mb-2 block">
            Restoring your photos…
          </span>
        )}

        {storageWarning && (
          <div className="bg-red-50 border border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300 rounded-lg px-3 py-2 text-sm mb-3">
            {storageWarning}
          </div>
        )}

        <label
          className="flex flex-col items-center justify-center w-full border-2 border-dashed border-zinc-300 rounded-xl p-10 cursor-pointer hover:border-zinc-400 transition-colors mb-8 bg-white dark:bg-zinc-900 dark:border-zinc-700"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
        >
          <span className="text-zinc-500 dark:text-zinc-400 text-sm mb-2">
            Click to select photos, or drag & drop
          </span>
          <span className="text-zinc-400 dark:text-zinc-600 text-xs">
            JPEG, PNG, TIFF supported
          </span>
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/tiff"
            onChange={handleChange}
            disabled={isRestoring}
            className="sr-only"
          />
        </label>

        {isSignedIn && (
          <div className="flex flex-col items-start gap-2 mb-8">
            <button
              onClick={pickerStatus === 'idle' ? handleImportClick : cancelImport}
              disabled={pickerStatus === 'downloading' || isNamePromptOpen || isRestoring}
              className="px-4 py-2 text-sm font-medium bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {pickerStatus === 'idle' ? 'Import from Google Photos' : 'Cancel import'}
            </button>
            {isNamePromptOpen && (
              <div className="flex flex-col gap-2 w-full max-w-sm">
                <input
                  type="text"
                  maxLength={500}
                  placeholder="Name this batch"
                  value={namePromptValue}
                  onChange={(e) => setNamePromptValue(e.target.value)}
                  autoFocus
                  className="text-sm border border-zinc-300 dark:border-zinc-600 rounded-lg px-3 py-1.5 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-50 placeholder:text-zinc-400 focus:outline-none w-full"
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleNamePromptContinue}
                    className="px-3 py-1.5 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 transition-colors dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
                  >
                    Continue
                  </button>
                  <button
                    onClick={handleNamePromptCancel}
                    className="px-3 py-1.5 text-sm font-medium bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {(pickerStatus === 'session-open' || pickerStatus === 'picking') && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {pickerStatus === 'session-open' ? 'Opening Google Photos…' : 'Waiting for selection…'}
              </span>
            )}
            {pickerStatus === 'downloading' && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Downloading photos…
              </span>
            )}
            {pickerStatus === 'error' && pickerError && (
              <span className="text-xs text-red-500 dark:text-red-400">
                {pickerError}
              </span>
            )}
          </div>
        )}

        {photos.length > 0 && (
          <>
            {/* Selection controls */}
            <div className="flex items-center gap-3 mb-4">
              <button
                onClick={selectAll}
                className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 underline"
              >
                Select all
              </button>
              {selectedIds.size > 0 && (
                <button
                  onClick={clearSelection}
                  className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 underline"
                >
                  Clear selection
                </button>
              )}
              <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-auto">
                Click image to select · click name or date to edit
              </span>
            </div>

            {/* Upload panel */}
            {isSignedIn && (
              <GooglePhotosUploadPanel
                photos={photos}
                accessToken={accessToken}
                uploadState={uploadState}
                photoStates={photoStates}
                albumName={albumName}
                onAlbumNameChange={setAlbumName}
                onStartUpload={() => startUpload(photos, albumName, accessToken ?? '')}
                onRetryFailed={() => retryFailed(photos, accessToken ?? '')}
              />
            )}

            {/* Batch panel */}
            {selectedIds.size > 0 && (
              <BatchEditPanel
                selectedCount={selectedIds.size}
                distinctTimestamps={distinctSelectedTimestamps}
                onBatchRename={handleBatchRename}
                onBatchSetTimestamp={handleBatchSetTimestamp}
                // Wrapped, not passed as a bare `handleBatchDelete`
                // reference: BatchEditPanel invokes this prop as
                // `onClick={onBatchDelete}`, so a bare reference would
                // receive the click's SyntheticEvent as its first argument
                // and defeat `handleBatchDelete`'s
                // `ids = Array.from(selectedIds)` default. The zero-arg
                // wrapper always triggers that default, deleting the
                // current selection.
                onBatchDelete={() => handleBatchDelete()}
                onClearSelection={clearSelection}
              />
            )}

            {/* The unified grid always renders here, drag-wired end to end
                — one grid, no separate cluster view or toggle. */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <PhotoGrid
                photos={photos}
                getObjectUrl={getObjectUrl}
                onReorder={reorderPhotos}
                onNameChange={updatePhotoName}
                onTimestampChange={updatePhotoTimestamp}
                selectedIds={selectedIds}
                onSelect={toggleSelect}
                onDelete={handleDeletePhoto}
                onZoom={setZoomedPhotoId}
                onVisualOrderChange={handleVisualOrderChange}
              />
              <DragOverlay>
                {activeEntry && (
                  <PhotoCard
                    entry={activeEntry}
                    objectUrl={getObjectUrl(activeEntry.file)}
                  />
                )}
              </DragOverlay>
            </DndContext>

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={handleClearAll}
                disabled={isRestoring}
                className="px-4 py-2 text-sm font-medium bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Clear all
              </button>
              <button
                onClick={() => downloadAll(photos)}
                className="px-4 py-2 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 transition-colors dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                Download all
              </button>
            </div>
          </>
        )}
      </div>

      {zoomedPhoto && (
        <PhotoLightbox
          filename={zoomedPhoto.filename}
          objectUrl={getObjectUrl(zoomedPhoto.file)}
          capturedAt={zoomedPhoto.capturedAt}
          onClose={handleCloseLightbox}
          onDelete={handleLightboxDelete}
          onTimestampChange={(d) => updatePhotoTimestamp(zoomedPhoto.id, d)}
          onNavigatePrev={prevZoomedId ? () => setZoomedPhotoId(prevZoomedId) : undefined}
          onNavigateNext={nextZoomedId ? () => setZoomedPhotoId(nextZoomedId) : undefined}
        />
      )}
    </div>
  )
}
