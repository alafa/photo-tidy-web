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
}

function sortPhotos(photos: PhotoEntry[]): PhotoEntry[] {
  return [...photos].sort((a, b) => {
    if (a.capturedAt === null && b.capturedAt === null) {
      return a.uploadIndex - b.uploadIndex
    }
    if (a.capturedAt === null) return 1
    if (b.capturedAt === null) return -1
    const diff = a.capturedAt.getTime() - b.capturedAt.getTime()
    return diff !== 0 ? diff : a.uploadIndex - b.uploadIndex
  })
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

export function usePhotos() {
  const [photos, setPhotos] = useState<PhotoEntry[]>([])
  const [hasEdits, setHasEdits] = useState(false)

  const processFiles = useCallback(async (fileList: FileList) => {
    const entries: PhotoEntry[] = []

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i]
      const capturedAt = await getPhotoDate(file)
      entries.push({
        id: crypto.randomUUID(),
        file,
        filename: file.name,
        capturedAt,
        uploadIndex: i,
      })
    }

    setPhotos(sortPhotos(entries))
    setHasEdits(false)
  }, [])

  const reorderPhotos = useCallback((from: number, to: number) => {
    setPhotos((prev) => slotTimestamp(arrayMove(prev, from, to), to))
    // reorderPhotos does NOT set hasEdits — drag is not treated as a user edit
  }, [])

  const updatePhotoName = useCallback((id: string, newName: string) => {
    setPhotos((prev) =>
      prev.map((p) => (p.id === id ? { ...p, filename: newName } : p))
    )
    setHasEdits(true)
  }, [])

  const updatePhotoTimestamp = useCallback((id: string, newDate: Date | null) => {
    setPhotos((prev) =>
      sortPhotos(prev.map((p) => (p.id === id ? { ...p, capturedAt: newDate } : p)))
    )
    setHasEdits(true)
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
    setHasEdits(true)
  }, [])

  const batchSetTimestamps = useCallback((ids: string[], anchorDate: Date) => {
    const idSet = new Set(ids)
    let rank = 0
    setPhotos((prev) => {
      const updated = prev.map((p) => {
        if (!idSet.has(p.id)) return p
        const newDate = new Date(anchorDate.getTime() + rank * 1000)
        rank++
        return { ...p, capturedAt: newDate }
      })
      return sortPhotos(updated)
    })
    setHasEdits(true)
  }, [])

  return {
    photos,
    hasEdits,
    processFiles,
    reorderPhotos,
    updatePhotoName,
    updatePhotoTimestamp,
    batchUpdateNames,
    batchSetTimestamps,
  }
}
