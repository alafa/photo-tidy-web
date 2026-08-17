'use client'

import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core'
import { usePhotos } from '@/hooks/usePhotos'
import { useObjectUrls } from '@/hooks/useObjectUrls'
import { useGoogleAuth } from '@/hooks/useGoogleAuth'
import { useGooglePhotosPicker } from '@/hooks/useGooglePhotosPicker'
import { useGooglePhotosUpload } from '@/hooks/useGooglePhotosUpload'
import { usePhotoMetrics } from '@/hooks/usePhotoMetrics'
import PhotoCard from './PhotoCard'
import PhotoGrid from './PhotoGrid'
import BatchEditPanel from './BatchEditPanel'
import GoogleAuthStatus from './GoogleAuthStatus'
import GooglePhotosUploadPanel from './GooglePhotosUploadPanel'
import { downloadAll } from '@/lib/download'

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
  } = usePhotos()
  const { getObjectUrl, releaseObjectUrl } = useObjectUrls()
  const { isSignedIn, accountEmail, isExpiringSoon, accessToken, signIn, signOut } = useGoogleAuth()
  const {
    status: pickerStatus,
    error: pickerError,
    startImport,
    cancelImport,
  } = useGooglePhotosPicker({ accessToken, addPhotos })
  const { uploadState, photoStates, startUpload, retryFailed, reset } = useGooglePhotosUpload()
  // Metrics must start computing as soon as photos are added regardless of
  // which view mode is active (KTD12) — called here, unconditionally,
  // rather than inside ClusterView (which only mounts once the user toggles
  // to cluster view).
  const metrics = usePhotoMetrics(photos)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [albumName, setAlbumName] = useState('')
  const [isNamePromptOpen, setIsNamePromptOpen] = useState(false)
  const [namePromptValue, setNamePromptValue] = useState('')
  const [viewMode, setViewMode] = useState<'timeline' | 'clusters'>('timeline')

  // Add distance constraint so short clicks don't trigger drag (allows checkboxes + inputs to work)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const activeEntry = activeId ? photos.find((p) => p.id === activeId) : null

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
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
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setSelectedIds(new Set())
      processFiles(e.dataTransfer.files)
      reset()
    }
  }

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id))
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null)
    if (!over || active.id === over.id) return
    const from = photos.findIndex((p) => p.id === active.id)
    const to = photos.findIndex((p) => p.id === over.id)
    if (from !== -1 && to !== -1) {
      reorderPhotos(from, to)
    }
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

  // R8/KTD7: the current selection's distinct existing capturedAt values,
  // deduped by exact millisecond value and sorted ascending — the same rule
  // ClusterTimestampEditor (components/ClusterView.tsx) used, generalized
  // here to the whole selection rather than one cluster's members, so it
  // covers a selection spanning multiple clusters or plain timeline photos
  // alike (AE3). Recomputed from `photos`/`selectedIds` on every render
  // rather than memoized — this app's photo counts don't warrant it, and
  // every other selection-derived value here (activeEntry, etc.) does the
  // same.
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

  function handleBatchDelete() {
    for (const photo of photos) {
      if (selectedIds.has(photo.id)) releaseObjectUrl(photo.file)
    }
    removePhotos(Array.from(selectedIds))
    clearSelection()
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
      <div className="max-w-6xl mx-auto px-4 py-10">
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
            className="sr-only"
          />
        </label>

        {isSignedIn && (
          <div className="flex flex-col items-start gap-2 mb-8">
            <button
              onClick={pickerStatus === 'idle' ? handleImportClick : cancelImport}
              disabled={pickerStatus === 'downloading' || isNamePromptOpen}
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
            {/* View mode toggle + selection controls */}
            <div className="flex items-center gap-3 mb-4">
              <button
                onClick={() => setViewMode((prev) => (prev === 'timeline' ? 'clusters' : 'timeline'))}
                className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 underline"
              >
                {viewMode === 'timeline' ? 'Group similar photos' : 'Back to timeline view'}
              </button>
              {viewMode === 'timeline' && (
                <>
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
                </>
              )}
              <span className="text-xs text-zinc-400 dark:text-zinc-500 ml-auto">
                Click image to select · click name or date to edit
              </span>
            </div>

            {/* Upload panel — unrelated to view mode, stays visible in both */}
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

            {/* Batch panel — hidden in cluster view; cluster-scoped selection (U4/U5) replaces it there */}
            {viewMode === 'timeline' && selectedIds.size > 0 && (
              <BatchEditPanel
                selectedCount={selectedIds.size}
                distinctTimestamps={distinctSelectedTimestamps}
                onBatchRename={handleBatchRename}
                onBatchSetTimestamp={handleBatchSetTimestamp}
                onBatchDelete={handleBatchDelete}
                onClearSelection={clearSelection}
              />
            )}

            {/* U3: the unified grid always renders here, drag-wired end to
                end (KTD2) — the conditional that used to swap this out for
                a standalone, non-draggable ClusterView is gone. `viewMode`
                and its toggle button (above) still exist but no longer
                affect what renders here; removing them entirely is U7's
                job once selection/delete are also unified (U4-U6). */}
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            >
              <PhotoGrid
                photos={photos}
                metrics={metrics}
                getObjectUrl={getObjectUrl}
                onReorder={reorderPhotos}
                onNameChange={updatePhotoName}
                onTimestampChange={updatePhotoTimestamp}
                selectedIds={selectedIds}
                onSelect={toggleSelect}
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

            <div className="mt-6 flex justify-end">
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
    </div>
  )
}
