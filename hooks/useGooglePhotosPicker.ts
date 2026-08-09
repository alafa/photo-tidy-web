'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import type { PickerSession, PickedMediaItem, MediaItemsResponse } from '@/lib/google-photos-types'

export type PickerStatus = 'idle' | 'session-open' | 'picking' | 'downloading' | 'error'

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/tiff': '.tiff',
}

function parseDurationSeconds(value: string, fallback: number): number {
  const match = /^(\d+)s$/.exec(value)
  return match ? parseInt(match[1], 10) : fallback
}

function deriveFilename(item: PickedMediaItem): string {
  if (item.mediaFile.filename && item.mediaFile.filename.trim() !== '') {
    return item.mediaFile.filename
  }
  const ext = MIME_TO_EXT[item.mediaFile.mimeType] ?? '.jpg'
  return `${item.id}${ext}`
}

const DOWNLOAD_CONCURRENCY = 5

async function downloadBatch(
  items: PickedMediaItem[],
  accessToken: string,
  signal: AbortSignal,
): Promise<Array<{ file: File; capturedAt: Date | null }>> {
  const results: Array<{ file: File; capturedAt: Date | null } | null> = new Array(items.length).fill(null)

  for (let i = 0; i < items.length; i += DOWNLOAD_CONCURRENCY) {
    if (signal.aborted) break
    const batch = items.slice(i, i + DOWNLOAD_CONCURRENCY)
    const settled = await Promise.allSettled(
      batch.map(async (item, batchIdx) => {
        const res = await fetch('/api/google-photos/download', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ baseUrl: item.mediaFile.baseUrl }),
          signal,
        })
        if (!res.ok) throw new Error(`Download failed for ${item.id}: ${res.status}`)
        const blob = await res.blob()
        const filename = deriveFilename(item)
        const file = new File([blob], filename, { type: item.mediaFile.mimeType })
        const capturedAt = item.mediaMetadata?.creationTime
          ? new Date(item.mediaMetadata.creationTime)
          : null
        results[i + batchIdx] = { file, capturedAt }
      }),
    )
    // Log failures but continue
    settled.forEach((s, batchIdx) => {
      if (s.status === 'rejected') {
        console.warn(`Failed to download item at batch index ${batchIdx}:`, s.reason)
      }
    })
  }

  return results.filter((r): r is { file: File; capturedAt: Date | null } => r !== null)
}

export function useGooglePhotosPicker(opts: {
  accessToken: string | null
  addPhotos: (files: File[], source: 'google-photos', capturedAts?: (Date | null)[]) => Promise<void>
}) {
  const { accessToken, addPhotos } = opts
  const [status, setStatus] = useState<PickerStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const sessionIdRef = useRef<string | null>(null)
  const cancelledRef = useRef(false)
  const abortControllerRef = useRef<AbortController | null>(null)

  // Visibility-change optimization: when returning from Google Photos tab, kick a poll
  const triggerImmediatePollRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && triggerImmediatePollRef.current) {
        triggerImmediatePollRef.current()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])

  const cleanupSession = useCallback((id: string) => {
    fetch(`/api/google-photos/sessions/${id}`, { method: 'DELETE' }).catch(() => {
      // fire-and-forget; ignore errors
    })
  }, [])

  const cancelImport = useCallback(() => {
    cancelledRef.current = true
    abortControllerRef.current?.abort()
    if (sessionIdRef.current) {
      cleanupSession(sessionIdRef.current)
      sessionIdRef.current = null
    }
    setStatus('idle')
    setError(null)
  }, [cleanupSession])

  const startImport = useCallback(async () => {
    if (!accessToken || status !== 'idle') return

    cancelledRef.current = false
    abortControllerRef.current = new AbortController()

    setStatus('session-open')
    setError(null)

    // Step 1: Create picker session
    let session: PickerSession
    try {
      const res = await fetch('/api/google-photos/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: abortControllerRef.current.signal,
      })
      if (!res.ok) throw new Error(`Session creation failed: ${res.status}`)
      session = await res.json() as PickerSession
    } catch {
      if (!cancelledRef.current) {
        setStatus('error')
        setError('Failed to create import session')
      }
      return
    }

    sessionIdRef.current = session.id

    // Step 2: Open Google Photos picker
    window.open(session.pickerUri, '_blank')
    setStatus('picking')

    // Step 3: Poll until mediaItemsSet=true or timeout
    const pollIntervalMs = parseDurationSeconds(session.pollingConfig?.pollInterval ?? '', 3) * 1000
    const timeoutSec = parseDurationSeconds(session.pollingConfig?.timeoutIn ?? '', 300)
    const startTime = Date.now()

    let immediatePollTrigger: (() => void) | null = null

    triggerImmediatePollRef.current = () => {
      if (immediatePollTrigger) immediatePollTrigger()
    }

    const waitWithImmediateOption = (ms: number): Promise<void> => {
      return new Promise((resolve) => {
        immediatePollTrigger = resolve
        const timeout = setTimeout(resolve, ms)
        // Override so calling immediately also clears the timeout
        immediatePollTrigger = () => {
          clearTimeout(timeout)
          resolve()
        }
      })
    }

    let mediaItemsSet = false
    while (!cancelledRef.current) {
      await waitWithImmediateOption(pollIntervalMs)

      if (cancelledRef.current) break

      try {
        const res = await fetch(`/api/google-photos/sessions/${session.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: abortControllerRef.current?.signal,
        })
        if (!res.ok) throw new Error(`Poll failed: ${res.status}`)
        const data = await res.json() as PickerSession
        if (data.mediaItemsSet) {
          mediaItemsSet = true
          break
        }
      } catch {
        if (!cancelledRef.current) {
          // network hiccup during poll — keep trying
        }
      }

      if (Date.now() - startTime > timeoutSec * 1000) {
        setStatus('error')
        setError('Import timed out. Please try again.')
        cleanupSession(session.id)
        sessionIdRef.current = null
        triggerImmediatePollRef.current = null
        return
      }
    }

    triggerImmediatePollRef.current = null

    if (cancelledRef.current || !mediaItemsSet) return

    // Step 4: Fetch media items
    let mediaItemsResponse: MediaItemsResponse
    try {
      const res = await fetch(`/api/google-photos/sessions/${session.id}?items=true`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: abortControllerRef.current?.signal,
      })
      if (!res.ok) throw new Error(`Fetch items failed: ${res.status}`)
      mediaItemsResponse = await res.json() as MediaItemsResponse
    } catch {
      if (!cancelledRef.current) {
        setStatus('error')
        setError('Failed to fetch selected photos')
        cleanupSession(session.id)
        sessionIdRef.current = null
      }
      return
    }

    if (cancelledRef.current) return

    const items = mediaItemsResponse.mediaItems ?? []
    if (items.length === 0) {
      // Nothing to import; clean up and go idle
      cleanupSession(session.id)
      sessionIdRef.current = null
      setStatus('idle')
      return
    }

    // Step 5: Download
    setStatus('downloading')

    const downloaded = await downloadBatch(
      items,
      accessToken,
      abortControllerRef.current?.signal ?? new AbortController().signal,
    )

    if (cancelledRef.current) return

    if (downloaded.length > 0) {
      const files = downloaded.map((d) => d.file)
      const capturedAts = downloaded.map((d) => d.capturedAt)
      await addPhotos(files, 'google-photos', capturedAts)
    }

    if (cancelledRef.current) return

    // Step 6: Cleanup
    cleanupSession(session.id)
    sessionIdRef.current = null

    setStatus('idle')
    setError(null)
  }, [accessToken, status, addPhotos, cleanupSession])

  return {
    status,
    error,
    startImport,
    cancelImport,
  }
}
