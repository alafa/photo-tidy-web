'use client'

import { useState, useCallback } from 'react'
import { arrayMove } from '@dnd-kit/sortable'
import { getPhotoDate } from '@/lib/exif'

export type PhotoEntry = {
  id: string
  file: File
  filename: string
  capturedAt: Date | null
  uploadIndex: number
  source: 'local' | 'google-photos'
  mediaItemId?: string
}

/**
 * Chronological comparator: null `capturedAt` sorts last (ties among nulls,
 * and any tie among equal timestamps, break by `uploadIndex`). Exported so
 * other consumers that need this exact same ordering rule applied to
 * `PhotoEntry` values (e.g. `hooks/useClusteredPhotos.ts`'s within-cluster
 * member ordering) can reuse it instead of re-implementing it.
 */
export function compareByCapturedAt(a: PhotoEntry, b: PhotoEntry): number {
  if (a.capturedAt === null && b.capturedAt === null) {
    return a.uploadIndex - b.uploadIndex
  }
  if (a.capturedAt === null) return 1
  if (b.capturedAt === null) return -1
  const diff = a.capturedAt.getTime() - b.capturedAt.getTime()
  return diff !== 0 ? diff : a.uploadIndex - b.uploadIndex
}

function sortPhotos(photos: PhotoEntry[]): PhotoEntry[] {
  return [...photos].sort(compareByCapturedAt)
}

/**
 * Compute a timestamp for the photo that was moved to `toIndex` so it slots
 * between its new neighbors. Only that one photo changes; all others keep
 * their original timestamps.
 */
function slotTimestamp(photos: PhotoEntry[], toIndex: number): PhotoEntry[] {
  const prevTs = photos[toIndex - 1]?.capturedAt ?? null
  const nextTs = photos[toIndex + 1]?.capturedAt ?? null

  let newTimestamp: Date | null
  if (prevTs !== null && nextTs !== null) {
    // Midpoint between neighbours
    newTimestamp = new Date(Math.round((prevTs.getTime() + nextTs.getTime()) / 2))
  } else if (prevTs !== null) {
    // Moved to the end — one second after the previous photo
    newTimestamp = new Date(prevTs.getTime() + 1000)
  } else if (nextTs !== null) {
    // Moved to the start — one second before the next photo
    newTimestamp = new Date(nextTs.getTime() - 1000)
  } else {
    // Only photo, or all neighbours have null timestamps — keep as-is
    newTimestamp = photos[toIndex].capturedAt
  }

  return photos.map((p, i) => (i === toIndex ? { ...p, capturedAt: newTimestamp } : p))
}

/**
 * Renumber `uploadIndex` to match current array position. `photos` is always
 * kept in display order, but a photo's `uploadIndex` otherwise still holds
 * whatever value it was assigned when first added, which can drift from its
 * visual position (e.g. after a drag-reorder among undated photos).
 * Renumbering keeps the null-`capturedAt` sort fallback (see `sortPhotos`)
 * consistent with what's on screen before further mutation.
 */
function renumberByPosition(photos: PhotoEntry[]): PhotoEntry[] {
  return photos.map((p, i) => ({ ...p, uploadIndex: i }))
}

/** Append `entries` after `prev`, continuing the upload index from `prev`'s renumbered length. */
function appendWithIndex(prev: PhotoEntry[], entries: PhotoEntry[]): PhotoEntry[] {
  const renumberedPrev = renumberByPosition(prev)
  const withIndex = entries.map((e, i) => ({ ...e, uploadIndex: renumberedPrev.length + i }))
  return sortPhotos([...renumberedPrev, ...withIndex])
}

export function usePhotos() {
  const [photos, setPhotos] = useState<PhotoEntry[]>([])

  const processFiles = useCallback(async (fileList: FileList | File[]) => {
    const entries: PhotoEntry[] = []

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i]
      const capturedAt = await getPhotoDate(file)
      entries.push({
        id: crypto.randomUUID(),
        file,
        filename: file.name,
        capturedAt,
        source: 'local',
        uploadIndex: 0, // placeholder; corrected in setPhotos below
      })
    }

    setPhotos((prev) => appendWithIndex(prev, entries))
  }, [])

  const reorderPhotos = useCallback((from: number, to: number) => {
    setPhotos((prev) => slotTimestamp(arrayMove(prev, from, to), to))
  }, [])

  const updatePhotoName = useCallback((id: string, newName: string) => {
    setPhotos((prev) =>
      prev.map((p) => (p.id === id ? { ...p, filename: newName } : p))
    )
  }, [])

  const updatePhotoTimestamp = useCallback((id: string, newDate: Date | null) => {
    setPhotos((prev) =>
      sortPhotos(renumberByPosition(prev).map((p) => (p.id === id ? { ...p, capturedAt: newDate } : p)))
    )
  }, [])

  const batchUpdateNames = useCallback((ids: string[], baseName: string) => {
    const idSet = new Set(ids)
    const padLen = String(ids.length).length
    let rank = 0
    setPhotos((prev) =>
      prev.map((p) => {
        if (!idSet.has(p.id)) return p
        rank++
        const suffix = String(rank).padStart(padLen, '0')
        const ext = p.file.name.includes('.') ? p.file.name.split('.').pop() : ''
        const newName = ext ? `${baseName}-${suffix}.${ext}` : `${baseName}-${suffix}`
        return { ...p, filename: newName }
      })
    )
  }, [])

  const batchSetTimestamps = useCallback((ids: string[], anchorDate: Date) => {
    const idSet = new Set(ids)
    let rank = 0
    setPhotos((prev) => {
      const updated = renumberByPosition(prev).map((p) => {
        if (!idSet.has(p.id)) return p
        const newDate = new Date(anchorDate.getTime() + rank * 1000)
        rank++
        return { ...p, capturedAt: newDate }
      })
      return sortPhotos(updated)
    })
  }, [])

  /**
   * Set every listed id's `capturedAt` to the identical `date` — no
   * per-photo offset (unlike `batchSetTimestamps`, which staggers each
   * target by `rank * 1000ms`). Used for pasting a copied timestamp onto
   * one or more photos, where every target must land on the exact same
   * value.
   */
  const setPhotosTimestamp = useCallback((ids: string[], date: Date) => {
    const idSet = new Set(ids)
    setPhotos((prev) =>
      sortPhotos(renumberByPosition(prev).map((p) => (idSet.has(p.id) ? { ...p, capturedAt: date } : p)))
    )
  }, [])

  const removePhotos = useCallback((ids: string[]) => {
    const idSet = new Set(ids)
    setPhotos((prev) => prev.filter((p) => !idSet.has(p.id)))
  }, [])

  const addPhotos = useCallback(async (
    files: File[],
    source: 'google-photos',
    capturedAts?: (Date | null)[],
  ) => {
    const entries: PhotoEntry[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const capturedAt =
        capturedAts && capturedAts[i] != null
          ? capturedAts[i]
          : await getPhotoDate(file)
      entries.push({
        id: crypto.randomUUID(),
        file,
        filename: file.name,
        capturedAt,
        source,
        uploadIndex: 0, // placeholder; corrected in setPhotos below
      })
    }
    setPhotos((prev) => appendWithIndex(prev, entries))
  }, [])

  /**
   * Replace `photos` wholesale with `entries`, sorted via the same
   * chronological rule as everything else. For the restore-from-persistence
   * flow only — unlike `processFiles`/`addPhotos`, it does not append to
   * whatever is already in state, so calling it more than once with the same
   * `entries` (e.g. React Strict Mode's double-invoked mount effect) is a
   * safe no-op rather than duplicating photos.
   */
  const hydratePhotos = useCallback((entries: PhotoEntry[]) => {
    setPhotos(sortPhotos(entries))
  }, [])

  /** Update one photo's `mediaItemId`, leaving every other field and photo untouched. */
  const setPhotoMediaItemId = useCallback((id: string, mediaItemId: string) => {
    setPhotos((prev) =>
      prev.map((p) => (p.id === id ? { ...p, mediaItemId } : p))
    )
  }, [])

  return {
    photos,
    processFiles,
    addPhotos,
    reorderPhotos,
    updatePhotoName,
    updatePhotoTimestamp,
    batchUpdateNames,
    batchSetTimestamps,
    setPhotosTimestamp,
    removePhotos,
    hydratePhotos,
    setPhotoMediaItemId,
  }
}
