'use client'

import { useState, useCallback, useRef } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import { writeTimestamp } from '@/lib/exif-write'
import type { UploadToken, Album } from '@/lib/google-photos-types'

export type UploadState = 'idle' | 'uploading' | 'done' | 'error'
export type PhotoUploadStatus = 'pending' | 'uploading' | 'done' | 'failed'

export interface PhotoUploadState {
  status: PhotoUploadStatus
  error?: string
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

export function useGooglePhotosUpload() {
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [photoStates, setPhotoStates] = useState<Map<string, PhotoUploadState>>(new Map())

  // Store albumId across startUpload/retryFailed calls
  const albumIdRef = useRef<string | undefined>(undefined)

  const uploadSinglePhoto = useCallback(
    async (photo: PhotoEntry, accessToken: string): Promise<UploadToken | null> => {
      setPhotoStates((prev) => {
        const next = new Map(prev)
        next.set(photo.id, { status: 'uploading' })
        return next
      })

      try {
        const modifiedBlob = await writeTimestamp(photo.file, photo.capturedAt ?? new Date())
        const arrayBuffer = await modifiedBlob.arrayBuffer()

        const response = await fetch('/api/google-photos/upload', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'X-Goog-Upload-Content-Type': photo.file.type || 'image/jpeg',
            'X-Goog-Upload-Filename': photo.filename,
          },
          body: arrayBuffer,
        })

        if (!response.ok) {
          const errorText = await response.text().catch(() => `HTTP ${response.status}`)
          throw new Error(errorText || `HTTP ${response.status}`)
        }

        const uploadToken = await response.text()

        setPhotoStates((prev) => {
          const next = new Map(prev)
          next.set(photo.id, { status: 'done' })
          return next
        })

        return { token: uploadToken, filename: photo.filename }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        setPhotoStates((prev) => {
          const next = new Map(prev)
          next.set(photo.id, { status: 'failed', error: errorMessage })
          return next
        })
        return null
      }
    },
    []
  )

  const batchCreate = useCallback(
    async (tokens: UploadToken[], albumId: string | undefined, accessToken: string) => {
      const batches = chunkArray(tokens, 50)
      for (const batch of batches) {
        const body: { uploadTokens: UploadToken[]; albumId?: string } = {
          uploadTokens: batch,
        }
        if (albumId) {
          body.albumId = albumId
        }
        const res = await fetch('/api/google-photos/batch-create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          throw new Error(`Batch create failed: ${res.status}`)
        }
      }
    },
    []
  )

  const startUpload = useCallback(
    async (photos: PhotoEntry[], albumName: string, accessToken: string): Promise<void> => {
      // Noop if already uploading
      if (uploadState === 'uploading') return

      // Empty photos → done immediately
      if (photos.length === 0) {
        setUploadState('done')
        return
      }

      // Initialize all photo states to pending
      const initialStates = new Map<string, PhotoUploadState>()
      for (const photo of photos) {
        initialStates.set(photo.id, { status: 'pending' })
      }
      setPhotoStates(initialStates)
      setUploadState('uploading')

      // Reset refs
      albumIdRef.current = undefined

      // Optionally create album
      if (albumName.trim()) {
        try {
          const albumResponse = await fetch('/api/google-photos/albums', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({ title: albumName.trim() }),
          })

          if (!albumResponse.ok) {
            throw new Error(`Album creation failed: HTTP ${albumResponse.status}`)
          }

          const albumData = await albumResponse.json() as Album
          albumIdRef.current = albumData.id
        } catch {
          setUploadState('error')
          return
        }
      }

      // Upload each photo sequentially
      const tokens: UploadToken[] = []
      for (const photo of photos) {
        const result = await uploadSinglePhoto(photo, accessToken)
        if (result) {
          tokens.push(result)
        }
      }

      // Batch create
      if (tokens.length > 0) {
        try {
          await batchCreate(tokens, albumIdRef.current, accessToken)
        } catch {
          setUploadState('error')
          return
        }
      }

      setUploadState('done')
    },
    [uploadState, uploadSinglePhoto, batchCreate]
  )

  const retryFailed = useCallback(
    async (photos: PhotoEntry[], accessToken: string): Promise<void> => {
      // Find failed photos
      const failedPhotos = photos.filter(
        (p) => photoStates.get(p.id)?.status === 'failed'
      )

      if (failedPhotos.length === 0) return

      setUploadState('uploading')

      // Re-upload failed photos
      const newTokens: UploadToken[] = []
      for (const photo of failedPhotos) {
        const result = await uploadSinglePhoto(photo, accessToken)
        if (result) {
          newTokens.push(result)
        }
      }

      // Only batch-create the newly retried tokens — previously successful tokens
      // were already committed in the initial startUpload call
      if (newTokens.length > 0) {
        try {
          await batchCreate(newTokens, albumIdRef.current, accessToken)
        } catch {
          setUploadState('error')
          return
        }
      }

      setUploadState('done')
    },
    [photoStates, uploadSinglePhoto, batchCreate]
  )

  const reset = useCallback(() => {
    setUploadState('idle')
    setPhotoStates(new Map())
    albumIdRef.current = undefined
  }, [])

  return {
    uploadState,
    photoStates,
    startUpload,
    retryFailed,
    reset,
  }
}
