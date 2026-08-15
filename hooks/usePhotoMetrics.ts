'use client'

import { useEffect, useRef, useState } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import { computePhotoMetrics, type PhotoMetrics } from '@/lib/perceptual-hash'

// Mirrors UPLOAD_CONCURRENCY in hooks/useGooglePhotosUpload.ts — bounds how
// many createImageBitmap decodes run at once so a large batch doesn't try
// to decode hundreds of images simultaneously.
const METRICS_CONCURRENCY = 5

/**
 * Computes and caches width/height/size/perceptual-hash metrics for every
 * photo's underlying `File`, keyed by `File` identity — mirrors
 * `useObjectUrls`'s `Map<File, T>`-in-a-ref cache shape, so re-renders (or a
 * batch that re-includes a previously-seen File) never redo work already
 * done.
 *
 * Unlike `useObjectUrls`'s synchronous reads, metrics arrive asynchronously,
 * so the ref cache is paired with a version counter (`useState`) bumped
 * each time a result lands, purely to trigger a re-render in consumers.
 *
 * Metrics compute EAGERLY whenever `photos` changes (KTD12) — call this
 * unconditionally on the full batch from wherever it's mounted, the same
 * way `usePhotos`'s `processFiles` eagerly reads EXIF dates on add. Do not
 * gate the call behind any UI state (e.g. "cluster view is open").
 *
 * Returned map is keyed by photo `id`. A photo whose metrics are still
 * being computed maps to `undefined`; a photo whose file failed to decode
 * maps to `{ hash: null, ... }` — the two are distinguishable so callers
 * can tell "not ready yet" apart from "permanently no hash".
 */
export function usePhotoMetrics(photos: PhotoEntry[]): Map<string, PhotoMetrics | undefined> {
  const cacheRef = useRef<Map<File, PhotoMetrics>>(new Map())

  // The id-keyed map is the only thing read during render. It's rebuilt
  // from `photos` + the ref cache inside the effect below — never read
  // directly off the ref during render, since a ref read at render time
  // isn't something React (or its compiler) can treat as reactive.
  const [metricsById, setMetricsById] = useState<Map<string, PhotoMetrics | undefined>>(new Map())

  // Generation token guarding the computation loop against a batch change
  // mid-computation: bumped every time this effect (re-)runs, i.e. every
  // time the input file list changes. A loop started for an earlier
  // `photos` value checks isCurrent() before writing each chunk's results
  // into the cache, so a decode that resolves after its batch was
  // superseded never lands. Mirrors the fix documented in
  // docs/solutions/logic-errors/stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md.
  const generationRef = useRef(0)

  useEffect(() => {
    const myGeneration = ++generationRef.current
    const isCurrent = () => generationRef.current === myGeneration

    const rebuild = () => {
      const next = new Map<string, PhotoMetrics | undefined>()
      for (const photo of photos) {
        next.set(photo.id, cacheRef.current.get(photo.file))
      }
      setMetricsById(next)
    }

    // Reflect the current photos list right away — picks up files already
    // in the cache (e.g. after a reorder that doesn't add new files) and
    // drops removed photos from the map even when nothing new needs
    // computing below.
    rebuild()

    const pending = photos.map((p) => p.file).filter((file) => !cacheRef.current.has(file))
    if (pending.length === 0) return

    async function run() {
      for (let i = 0; i < pending.length; i += METRICS_CONCURRENCY) {
        if (!isCurrent()) return
        const chunk = pending.slice(i, i + METRICS_CONCURRENCY)
        const results = await Promise.all(
          chunk.map(async (file) => ({ file, metrics: await computePhotoMetrics(file) }))
        )
        if (!isCurrent()) return
        for (const { file, metrics } of results) {
          cacheRef.current.set(file, metrics)
        }
        rebuild()
      }
    }

    run()
    // No cleanup needed beyond the generation bump above: a superseded
    // run's remaining awaits will each find isCurrent() false and stop
    // before writing or scheduling further work.
  }, [photos])

  return metricsById
}
