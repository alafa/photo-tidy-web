'use client'

import { useState, useCallback } from 'react'
import { getPhotoDate } from '@/lib/exif'

export type PhotoEntry = {
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

export function usePhotos() {
  const [photos, setPhotos] = useState<PhotoEntry[]>([])

  const processFiles = useCallback(async (fileList: FileList) => {
    const entries: PhotoEntry[] = []

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i]
      const capturedAt = await getPhotoDate(file)
      entries.push({ file, filename: file.name, capturedAt, uploadIndex: i })
    }

    setPhotos(sortPhotos(entries))
  }, [])

  return { photos, processFiles }
}
