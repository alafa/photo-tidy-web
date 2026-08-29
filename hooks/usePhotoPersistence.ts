'use client'

/**
 * Persists the in-memory photo batch (`hooks/usePhotos.ts`'s `PhotoEntry[]`)
 * to IndexedDB (`lib/photo-storage.ts`) so it survives reload/tab-close, and
 * restores it on mount. Two independent concerns:
 *
 * - Restore-on-mount: reads everything out of IndexedDB once and hydrates
 *   the in-memory photo list from it. Guarded by a generation-token ref
 *   (see docs/solutions/logic-errors/stale-shared-ref-read-after-concurrent-
 *   invocation-in-async-hooks.md) so a React Strict Mode double-invoked
 *   mount effect, or a `clearAllPersisted()` call that races an in-flight
 *   restore, can never let a superseded read's result land after the fact.
 * - Write-through: whenever `photos` changes (after restore has finished),
 *   diffs it against what's known to already be persisted and writes only
 *   what's new or changed, deletes what's gone, and never crashes the batch
 *   on a single photo's write failure (e.g. quota exceeded).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import {
  getAllPhotoRecords,
  putPhotoRecord,
  deletePhotoRecord,
  clearAllPhotoRecords,
  requestPersistence,
  type PhotoRecord,
} from '@/lib/photo-storage'
import { generateThumbnail } from '@/lib/generate-thumbnail'
import { dataURLtoBlob } from '@/lib/exif-write'
import { chunkArray } from '@/hooks/useGooglePhotosUpload'

const RESTORE_FAILURE_MESSAGE = "Couldn't load your saved photos — starting a new session."
const SAVE_FAILURE_MESSAGE = "Some photos couldn't be saved — your browser's storage may be full."

// Writes are batched so a large restore/first-save doesn't block the main
// thread in one long synchronous run; between chunks we yield via a
// zero-delay setTimeout.
const WRITE_CHUNK_SIZE = 15

function recordToEntry(record: PhotoRecord): PhotoEntry {
  return {
    id: record.id,
    file: new File([record.blob], record.filename, {
      type: record.type,
      lastModified: record.lastModified,
    }),
    filename: record.filename,
    capturedAt: record.capturedAt === null ? null : new Date(record.capturedAt),
    uploadIndex: record.uploadIndex,
    source: record.source,
    ...(record.mediaItemId !== undefined ? { mediaItemId: record.mediaItemId } : {}),
  }
}

/** Whether `photo` (at its current array position `actualUploadIndex`)
 * differs from the record last known to be persisted for it. */
function hasChangedSincePersisted(
  photo: PhotoEntry,
  actualUploadIndex: number,
  prevRecord: PhotoRecord,
): boolean {
  const capturedAtMs = photo.capturedAt === null ? null : photo.capturedAt.getTime()
  return (
    photo.file !== prevRecord.blob ||
    photo.filename !== prevRecord.filename ||
    capturedAtMs !== prevRecord.capturedAt ||
    photo.source !== prevRecord.source ||
    actualUploadIndex !== prevRecord.uploadIndex ||
    photo.mediaItemId !== prevRecord.mediaItemId
  )
}

export function usePhotoPersistence(
  photos: PhotoEntry[],
  hydratePhotos: (entries: PhotoEntry[]) => void,
  seedPhotoStates: (map: Map<string, string>) => void,
) {
  const [isRestoring, setIsRestoring] = useState(true)
  const [storageWarning, setStorageWarning] = useState<string | null>(null)

  // Identifies which restore (or clearAllPersisted invalidation) is still
  // "current". Bumped at the start of the mount effect and by
  // clearAllPersisted, so a superseded run's late-resolving read can tell
  // it no longer owns hydratePhotos/lastPersistedRef/thumbnailCacheRef.
  const generationRef = useRef(0)

  // What we believe is currently sitting in IndexedDB, keyed by photo id —
  // the write-through effect diffs `photos` against this to find new/
  // changed/removed ids, rather than re-reading the DB on every pass.
  const lastPersistedRef = useRef<Map<string, PhotoRecord>>(new Map())

  // Thumbnails generated (or known-null) for a given photo id, so a
  // metadata-only change (rename, timestamp edit, reorder) never triggers a
  // redundant `generateThumbnail` call.
  const thumbnailCacheRef = useRef<Map<string, Blob | null>>(new Map())

  // requestPersistence() is fired once, ever, the first time any write
  // succeeds — not on every write.
  const hasRequestedPersistenceRef = useRef(false)

  useEffect(() => {
    const myGeneration = ++generationRef.current
    const isCurrent = () => generationRef.current === myGeneration

    async function restore() {
      let records: PhotoRecord[]
      try {
        records = await getAllPhotoRecords()
      } catch {
        if (!isCurrent()) return
        setStorageWarning(RESTORE_FAILURE_MESSAGE)
        setIsRestoring(false)
        return
      }

      if (!isCurrent()) return

      const entries = records.map(recordToEntry)
      hydratePhotos(entries)

      const seedMap = new Map<string, string>()
      const persistedMap = new Map<string, PhotoRecord>()
      const thumbCache = new Map<string, Blob | null>()
      records.forEach((record, i) => {
        // Seed with the SAME File object just handed to hydratePhotos
        // (entries[i].file), not the raw record.blob straight out of
        // IndexedDB. hasChangedSincePersisted compares `photo.file !==
        // prevRecord.blob` by reference — recordToEntry wraps record.blob
        // in a brand-new `File`, which is never === the original Blob, so
        // seeding with record.blob would make every restored photo look
        // "changed" and trigger a full rewrite on every load. `file` stays
        // the same object reference across metadata-only edits elsewhere
        // (rename/timestamp), so this keeps the comparison stable.
        persistedMap.set(record.id, { ...record, blob: entries[i].file })
        thumbCache.set(record.id, record.thumbnail)
        if (record.mediaItemId) seedMap.set(record.id, record.mediaItemId)
      })
      seedPhotoStates(seedMap)
      lastPersistedRef.current = persistedMap
      thumbnailCacheRef.current = thumbCache
      setIsRestoring(false)
    }

    void restore()
    // Intentionally mount-only: `hydratePhotos`/`seedPhotoStates` are stable
    // mutators from their owning hooks, and this restore must run exactly
    // once per hook instance (guarded above for Strict Mode's double-invoke).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (isRestoring) return

    async function writeThrough() {
      const prevMap = lastPersistedRef.current
      const currentIds = new Set(photos.map((p) => p.id))

      // Removed: present in lastPersistedRef but no longer in `photos`.
      async function runDeletes() {
        for (const id of prevMap.keys()) {
          if (currentIds.has(id)) continue
          try {
            await deletePhotoRecord(id)
          } catch {
            // Deletion failure isn't recoverable by retry logic here (there's
            // no "pending delete" list) — leaving the stale record behind is
            // the safe failure mode; it just won't be surfaced in the UI
            // again since `photos` no longer contains it.
          }
          lastPersistedRef.current.delete(id)
          thumbnailCacheRef.current.delete(id)
        }
      }

      // New or changed: compare against the last-known-persisted record,
      // using the photo's ACTUAL current array index (not its own
      // possibly-stale `uploadIndex` field — see hooks/usePhotos.ts's
      // renumberByPosition doc comment) as the value to persist.
      async function runWrites() {
        const pending: { photo: PhotoEntry; actualUploadIndex: number }[] = []
        photos.forEach((photo, actualUploadIndex) => {
          const prevRecord = lastPersistedRef.current.get(photo.id)
          if (!prevRecord || hasChangedSincePersisted(photo, actualUploadIndex, prevRecord)) {
            pending.push({ photo, actualUploadIndex })
          }
        })

        const batches = chunkArray(pending, WRITE_CHUNK_SIZE)
        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i]
          await Promise.all(
            batch.map(async ({ photo, actualUploadIndex }) => {
              let thumbnail: Blob | null
              if (thumbnailCacheRef.current.has(photo.id)) {
                thumbnail = thumbnailCacheRef.current.get(photo.id) ?? null
              } else {
                const base64 = await generateThumbnail(photo.file)
                thumbnail = base64 === null ? null : dataURLtoBlob(`data:image/jpeg;base64,${base64}`)
                thumbnailCacheRef.current.set(photo.id, thumbnail)
              }

              const record: PhotoRecord = {
                id: photo.id,
                blob: photo.file,
                filename: photo.filename,
                type: photo.file.type,
                lastModified: photo.file.lastModified,
                capturedAt: photo.capturedAt === null ? null : photo.capturedAt.getTime(),
                source: photo.source,
                uploadIndex: actualUploadIndex,
                thumbnail,
                ...(photo.mediaItemId !== undefined ? { mediaItemId: photo.mediaItemId } : {}),
              }

              try {
                await putPhotoRecord(record)
                lastPersistedRef.current.set(photo.id, record)
                if (!hasRequestedPersistenceRef.current) {
                  hasRequestedPersistenceRef.current = true
                  void requestPersistence()
                }
              } catch {
                // Quota exceeded or any other failure: don't crash the batch,
                // don't mark it persisted (so the next write-through pass,
                // triggered by any future `photos` change, retries it).
                setStorageWarning(SAVE_FAILURE_MESSAGE)
              }
            }),
          )

          if (i < batches.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
        }
      }

      // Deletions and writes touch disjoint ids (a removed id can never
      // also be a changed id, since `pending` is only ever built from ids
      // still present in `photos`), so there's no correctness reason to
      // serialize them — run both passes concurrently.
      await Promise.all([runDeletes(), runWrites()])
    }

    void writeThrough()
  }, [photos, isRestoring])

  const clearAllPersisted = useCallback(async () => {
    // Invalidate any in-flight restore so its late hydratePhotos/ref-seed
    // can't re-populate what's about to be cleared.
    generationRef.current += 1
    await clearAllPhotoRecords()
    lastPersistedRef.current = new Map()
    thumbnailCacheRef.current.clear()
  }, [])

  return { isRestoring, storageWarning, clearAllPersisted }
}
