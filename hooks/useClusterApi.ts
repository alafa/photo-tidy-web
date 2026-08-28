'use client'

import { useEffect, useRef, useState } from 'react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import { generateThumbnail } from '@/lib/generate-thumbnail'

/**
 * `GET /api/cluster/health` gate (R12, KTD13):
 * - `'checking'` — the health check hasn't resolved yet. Slider stays
 *   disabled, but with no "unavailable" message (a later unit's UI concern).
 * - `'available'` — the service is reachable; the slider is enabled and
 *   cluster requests are allowed.
 * - `'unavailable'` — the initial health check failed, or a mid-session
 *   cluster request failed for a non-photo-specific reason (KTD10/KTD11).
 *   The slider stays disabled and the last successful `clusters` remain on
 *   screen (KTD14).
 */
export type ClusterApiAvailability = 'checking' | 'available' | 'unavailable'

/** One cluster as returned by photo-tidy-api's `POST /api/cluster` (see photo-tidy-api/README.md). */
export interface ApiCluster {
  clusterIndex: number
  photoIds: string[]
}

interface ClusterApiSuccessBody {
  clusters: ApiCluster[]
}

/**
 * Return shape of `useClusterApi`. A later unit (`useClusteredPhotos`)
 * consumes this to build chronologically-ordered render blocks.
 *
 * - `clusters`: the last successful `POST /api/cluster` response, in the
 *   API's raw `{clusterIndex, photoIds}` shape. Never cleared while a new
 *   request is in flight or fails (KTD8/KTD14) — only replaced by a newer,
 *   still-current successful response.
 * - `availability`: see `ClusterApiAvailability` above.
 * - `isLoading`: true while a cluster request (including its single
 *   per-photo-rejection retry) is in flight. Tracked separately from
 *   `clusters` so the caller can show a non-blocking loading indicator
 *   without blanking the grid (R9).
 */
export interface UseClusterApiResult {
  clusters: ApiCluster[]
  availability: ClusterApiAvailability
  isLoading: boolean
}

// R7: debounce slider changes 500ms before calling the API.
const DEBOUNCE_MS = 500

// R4: the slider's 0-100% maps linearly onto the API's 0.0-0.5 threshold.
const MAX_THRESHOLD = 0.5

function percentToThreshold(percent: number): number {
  return (percent / 100) * MAX_THRESHOLD
}

/**
 * Returns `value`, but only updates to a new value after it has stayed the
 * same reference for `delayMs` — except the very first value, which commits
 * immediately. Adapted from `hooks/useClusteredPhotos.ts`'s
 * `useDebouncedValue` (KTD3), which this replaces there once that hook is
 * rewritten to consume this one.
 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  const isFirstRef = useRef(true)

  useEffect(() => {
    if (isFirstRef.current) {
      isFirstRef.current = false
      return
    }
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])

  return debounced
}

/**
 * Extracts the rejected photo id from a `400` body shaped
 * `{"detail": "Photo '<id>': <reason>"}` (photo-tidy-api's documented
 * per-photo-rejection contract — confirmed against photo-tidy-api/main.py
 * and photo-tidy-api/README.md). Returns `null` for any other shape,
 * which callers treat as a non-photo-specific failure (KTD11).
 */
function extractRejectedPhotoId(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('detail' in body)) return null
  const detail = (body as { detail: unknown }).detail
  if (typeof detail !== 'string') return null
  const match = /^Photo '([^']+)':/.exec(detail)
  return match ? match[1] : null
}

/** True when `a` and `b` contain exactly the same members (order-independent). */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false
  for (const item of a) {
    if (!b.has(item)) return false
  }
  return true
}

type AttemptResult =
  | { ok: true; clusters: ApiCluster[] }
  | { ok: false; rejectedId: string | null }

/** Posts one `/api/cluster` request excluding `excludeIds`, built from `thumbnailsByFile`. */
async function postCluster(
  photos: PhotoEntry[],
  excludeIds: Set<string>,
  thumbnailsByFile: Map<File, string | null>,
  threshold: number,
): Promise<AttemptResult> {
  const requestPhotos = photos
    .filter((p) => !excludeIds.has(p.id))
    .map((p) => ({ id: p.id, image: thumbnailsByFile.get(p.file) as string }))

  const res = await fetch('/api/cluster', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ photos: requestPhotos, threshold }),
  })

  if (res.ok) {
    const data = (await res.json()) as ClusterApiSuccessBody
    return { ok: true, clusters: data.clusters }
  }

  if (res.status === 400) {
    // Explicit try/catch, not `.catch(() => fallback)` — see
    // lib/cluster-api-server.ts's parseUpstreamJson comment. Falling back to
    // `null` here still routes to the correct outcome: an unparseable 400
    // body can't name a photo, so it's treated as a non-photo-specific
    // failure below, not laundered into a false success.
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { ok: false, rejectedId: extractRejectedPhotoId(body) }
  }

  return { ok: false, rejectedId: null }
}

/**
 * Owns the health gate, the debounced fetch, race-safety, and the
 * stale-while-loading contract for photo-tidy-api's clustering endpoint.
 * See `UseClusterApiResult` for the returned shape.
 *
 * `similarityPercent` is a live (undebounced) 0-100 value; the caller owns
 * whatever slider produces it.
 */
export function useClusterApi(photos: PhotoEntry[], similarityPercent: number): UseClusterApiResult {
  const [availability, setAvailability] = useState<ClusterApiAvailability>('checking')
  const [clusters, setClusters] = useState<ApiCluster[]>([])
  const [isLoading, setIsLoading] = useState(false)

  // Thumbnail cache keyed by File identity (KTD16) — a base64 thumbnail is
  // expensive to regenerate, so once a File has one it's reused across
  // re-clusters instead of being recomputed every request. `null` records a
  // File whose thumbnail generation failed, so it's excluded rather than
  // retried every tick.
  const thumbnailCacheRef = useRef<Map<File, string | null>>(new Map())

  // The File-identity set and threshold actually sent in the last request
  // this hook fired, so the effect below can skip firing again when neither
  // has changed (see the skip check there). `null` until the first request.
  const lastRequestRef = useRef<{ fileIds: Set<File>; threshold: number } | null>(null)

  // Generation-token guard against a stale response landing after a newer
  // trigger superseded it (KTD4) — mirrors
  // hooks/useGooglePhotosPicker.ts's importGenerationRef/isCurrent(). Bumped
  // once per triggering effect run (debounced-threshold commit or `photos`
  // identity change), NOT on the same-generation per-photo-rejection retry
  // (KTD11), so a concurrent newer trigger can still supersede a retry in
  // flight.
  const generationRef = useRef(0)

  // Mirrors the current `similarityPercent` prop, kept fresh via its own
  // effect (never read/written during render — React flags a ref write
  // during render as an error) rather than being a dependency of the effect
  // below: reading it inside that effect (instead of `debouncedPercent`) is
  // what makes the "> 0" call gate react to the live value — a `photos`
  // identity change that fires the effect while the debounce hasn't yet
  // caught up to a just-dropped-to-0% slider must not fire a spurious call
  // (R5). Only the request's `threshold` uses the debounced value. Declared
  // (and thus committed) before the main effect below, so within a single
  // commit where both `similarityPercent` and, say, `photos` change
  // together, the main effect always reads the up-to-date value.
  const livePercentRef = useRef(similarityPercent)
  useEffect(() => {
    livePercentRef.current = similarityPercent
  }, [similarityPercent])

  const debouncedPercent = useDebouncedValue(similarityPercent, DEBOUNCE_MS)

  // R12: check GET /api/cluster/health once on mount.
  useEffect(() => {
    let cancelled = false

    async function checkHealth() {
      try {
        const res = await fetch('/api/cluster/health')
        if (cancelled) return
        setAvailability(res.ok ? 'available' : 'unavailable')
      } catch (err) {
        if (cancelled) return
        // console.warn, not console.error: Next.js dev mode surfaces
        // console.error as a blocking full-screen overlay, which would
        // hijack this recoverable, in-app availability state.
        console.warn('useClusterApi: health check failed', err)
        setAvailability('unavailable')
      }
    }

    checkHealth().catch(() => {
      // checkHealth never rejects (its own try/catch handles every path);
      // this is a last-resort guard only.
    })

    return () => {
      cancelled = true
    }
    // Intentionally runs once on mount only (R12: "once on app load").
  }, [])

  useEffect(() => {
    // R12/KTD13: no cluster call while checking or unavailable.
    if (availability !== 'available') return

    // R5: at 0% (or once every photo is gone), invalidate whatever request
    // was previously in flight rather than leaving its generation valid --
    // otherwise a stale response computed for the old threshold/photo-set
    // could still land and get applied after this point, since nothing else
    // bumps generationRef on this path. Also reset isLoading here: the
    // invalidated request's own run() will see isCurrent() go false and
    // return without touching isLoading, and no replacement request is
    // fired on this path to reset it later, so it would otherwise get stuck
    // true. Deferred to a microtask (not called synchronously in the effect
    // body) to match this file's existing convention of only ever calling
    // the state setters from inside an async callback -- see checkHealth()
    // and run() above.
    if (livePercentRef.current <= 0 || photos.length === 0) {
      generationRef.current += 1
      queueMicrotask(() => setIsLoading(false))
      return
    }

    const threshold = percentToThreshold(debouncedPercent)
    const currentFileIds = new Set(photos.map((p) => p.file))

    // `photos` also gets a new array identity on a rename/timestamp-edit/
    // reorder (see hooks/usePhotos.ts), none of which change which Files are
    // present. Only an actual add/delete (changing the File set) or a real
    // threshold change (R10) should fire a new request — so skip when
    // neither differs from the last request this hook actually sent.
    if (
      lastRequestRef.current !== null &&
      lastRequestRef.current.threshold === threshold &&
      setsEqual(lastRequestRef.current.fileIds, currentFileIds)
    ) {
      return
    }
    lastRequestRef.current = { fileIds: currentFileIds, threshold }

    // KTD4/KTD9: bump the generation once per trigger (debounced-threshold
    // commit or `photos` identity change) — this effect's own dependency
    // array is exactly those two triggers (plus `availability`).
    const myGeneration = ++generationRef.current
    const isCurrent = () => generationRef.current === myGeneration

    async function run() {
      setIsLoading(true)

      // Drop cache entries for Files no longer present in `photos` (KTD16).
      for (const file of thumbnailCacheRef.current.keys()) {
        if (!currentFileIds.has(file)) thumbnailCacheRef.current.delete(file)
      }

      // Generate a thumbnail only for a File not already cached (KTD16).
      const pending = photos.filter((p) => !thumbnailCacheRef.current.has(p.file))
      if (pending.length > 0) {
        const results = await Promise.all(
          pending.map(async (p) => ({ file: p.file, thumbnail: await generateThumbnail(p.file) })),
        )
        if (!isCurrent()) return
        for (const { file, thumbnail } of results) {
          thumbnailCacheRef.current.set(file, thumbnail)
        }
      }
      if (!isCurrent()) return

      // R16: a File whose thumbnail generation failed is excluded from the
      // request rather than blocking the whole batch.
      const failedIds = new Set<string>()
      for (const p of photos) {
        if (thumbnailCacheRef.current.get(p.file) === null) failedIds.add(p.id)
      }

      let excludeIds = failedIds
      let result: AttemptResult
      try {
        result = await postCluster(photos, excludeIds, thumbnailCacheRef.current, threshold)
      } catch (err) {
        if (isCurrent()) {
          console.warn('useClusterApi: cluster request failed', err)
          setAvailability('unavailable')
          setIsLoading(false)
        }
        return
      }
      if (!isCurrent()) return

      // R15/KTD11: a 400 naming one photo excludes it and resubmits once,
      // within the SAME generation (myGeneration/isCurrent above are not
      // re-bumped for this retry).
      if (!result.ok && result.rejectedId !== null) {
        excludeIds = new Set(excludeIds)
        excludeIds.add(result.rejectedId)
        try {
          result = await postCluster(photos, excludeIds, thumbnailCacheRef.current, threshold)
        } catch (err) {
          if (isCurrent()) {
            console.warn('useClusterApi: cluster retry request failed', err)
            setAvailability('unavailable')
            setIsLoading(false)
          }
          return
        }
        if (!isCurrent()) return
      }

      if (result.ok) {
        setClusters(result.clusters)
        setAvailability('available')
        setIsLoading(false)
      } else {
        // R13/KTD10/KTD11: any failure other than a single-photo rejection
        // resolved by the retry above — network error, timeout, unparseable
        // body, a non-2xx not naming one photo, or a second rejection on the
        // retry — becomes 'unavailable'. `clusters` is left untouched
        // (KTD14).
        setAvailability('unavailable')
        setIsLoading(false)
      }
    }

    run().catch((err: unknown) => {
      if (!isCurrent()) return
      console.warn('useClusterApi: unexpected cluster fetch error', err)
      setAvailability('unavailable')
      setIsLoading(false)
    })
  }, [availability, debouncedPercent, photos])

  return { clusters, availability, isLoading }
}
