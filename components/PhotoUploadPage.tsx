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
import PhotoCard from './PhotoCard'
import PhotoGrid from './PhotoGrid'
import BatchEditPanel from './BatchEditPanel'
import { downloadAll } from '@/lib/download'

export default function PhotoUploadPage() {
  const {
    photos,
    hasEdits,
    processFiles,
    reorderPhotos,
    updatePhotoName,
    updatePhotoTimestamp,
    batchUpdateNames,
    batchSetTimestamps,
  } = usePhotos()
  const getObjectUrl = useObjectUrls()
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // Add distance constraint so short clicks don't trigger drag (allows checkboxes + inputs to work)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const activeEntry = activeId ? photos.find((p) => p.id === activeId) : null

  function maybeConfirm(): boolean {
    if (!hasEdits) return true
    return window.confirm('Uploading new photos will discard your edits. Continue?')
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      if (!maybeConfirm()) return
      setSelectedIds(new Set())
      processFiles(e.target.files)
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
      if (!maybeConfirm()) return
      setSelectedIds(new Set())
      processFiles(e.dataTransfer.files)
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

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <div className="max-w-6xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-50 mb-6">
          photo-tidy
        </h1>

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

            {/* Batch panel */}
            {selectedIds.size > 0 && (
              <BatchEditPanel
                selectedCount={selectedIds.size}
                onBatchRename={handleBatchRename}
                onBatchSetTimestamp={handleBatchSetTimestamp}
                onClearSelection={clearSelection}
              />
            )}

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
