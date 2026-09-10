'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragStartEvent, DragEndEvent } from '@dnd-kit/core'
import { usePhotos, compareByCapturedAt } from '@/hooks/usePhotos'
import type { PhotoEntry } from '@/hooks/usePhotos'
import { useObjectUrls } from '@/hooks/useObjectUrls'
import { useGoogleAuth } from '@/hooks/useGoogleAuth'
import { useGooglePhotosPicker } from '@/hooks/useGooglePhotosPicker'
import { useGooglePhotosUpload } from '@/hooks/useGooglePhotosUpload'
import { usePhotoPersistence } from '@/hooks/usePhotoPersistence'
import { chunkArray } from '@/lib/chunk-array'
import { getPhotoDimensions, pickBestPhoto } from '@/lib/photo-quality'
import PhotoCard from './PhotoCard'
import PhotoGrid from './PhotoGrid'
import PhotoLightbox from './PhotoLightbox'
import BatchEditPanel from './BatchEditPanel'
import GoogleAuthStatus from './GoogleAuthStatus'
import GooglePhotosUploadPanel from './GooglePhotosUploadPanel'
import { formatDate } from '@/lib/datetime-local'
import {
  buildPhotoZipBlob,
  buildOrderedZipEntries,
  buildZipFilename,
  triggerDownload,
} from '@/lib/download'

/**
 * Computes `count` new timestamps for a whole dragged group dropped between
 * `prevTs` and `nextTs` — the group's TRUE final visual boundary neighbors
 * after the drop, not neighbors resolved from the flat, purely-chronological
 * `photos` array (which can disagree with visual order whenever a cluster
 * isn't array-contiguous; see `hooks/useClusteredPhotos.ts`'s `visualOrder`
 * doc). `handleDragEnd` below feeds it `effectiveGroupIds.length` for
 * `count` and zips the result 1:1 against `effectiveGroupIds`, which is
 * already in the group's pre-drag chronological order (`computeDragGroupIds`,
 * U1) — so index 0 of the returned array is the earliest-moving photo.
 *
 * N-item generalization (U3, KTD3) of the single-item algorithm
 * `hooks/usePhotos.ts`'s `slotTimestamp` (and this file's own prior
 * `computeDroppedTimestamp`) already used, generalizing its exact 3-branch
 * shape rather than inventing a new scheme:
 *
 * - Both boundaries present: evenly space `count` values strictly inside the
 *   open interval `(prevTs, nextTs)`. Reduces to byte-identical output at
 *   `count === 1` (the single midpoint). Because the values are strictly
 *   inside an open interval and evenly spaced, they come out distinct even
 *   when the interval is as tight as 1 second and `count` is 10 or more
 *   (R7) — no special-casing needed.
 * - Only `prevTs` present ("moved to the end"): `count` values spaced 1
 *   second apart starting just after `prevTs`, preserving relative order —
 *   generalizing the single-item `prevTs + 1000ms` edge offset the same way
 *   `hooks/usePhotos.ts`'s `batchSetTimestamps` staggers its own per-id
 *   writes by `rank * 1000ms`.
 * - Only `nextTs` present ("moved to the start"): the mirror image, ending
 *   1 second before `nextTs`.
 * - Neither boundary present: returns `null` for every slot. Unlike the
 *   single-item version (which had a `currentCapturedAt` parameter to fall
 *   back to), this function has no per-item "current" value to return —
 *   `null` is a sentinel `handleDragEnd` resolves back to each photo's own
 *   existing `capturedAt`, which reproduces the exact same "keep as-is"
 *   end result.
 */
export function interpolateTimestamps(
  prevTs: Date | null,
  nextTs: Date | null,
  count: number
): (Date | null)[] {
  if (prevTs !== null && nextTs !== null) {
    const step = (nextTs.getTime() - prevTs.getTime()) / (count + 1)
    return Array.from({ length: count }, (_, i) =>
      new Date(Math.round(prevTs.getTime() + step * (i + 1)))
    )
  }
  if (prevTs !== null) {
    return Array.from({ length: count }, (_, i) => new Date(prevTs.getTime() + (i + 1) * 1000))
  }
  if (nextTs !== null) {
    return Array.from({ length: count }, (_, i) => new Date(nextTs.getTime() - (count - i) * 1000))
  }
  return Array(count).fill(null)
}

/**
 * Computes the frozen drag-group membership for a drag that just started
 * (U1, KTD1). Called exactly once, synchronously, from `handleDragStart`, and
 * its result is stored in `dragGroupIds` state rather than re-derived later —
 * so a selection change mid-drag (Esc, deselect) can't retroactively change
 * which photos move (R1/R2/R3).
 *
 * - If the dragged photo is itself part of a >=2-member selection (R1), the
 *   WHOLE selection moves together, ordered by current chronological order
 *   (`compareByCapturedAt`, `hooks/usePhotos.ts`) -- deliberately NOT `Set`
 *   iteration order, which is click/selection order and is exactly what R5
 *   says the post-drop relative order must NOT follow.
 * - Otherwise (dragging a photo outside the selection, R2; or 0/1 photos
 *   selected, R3) -- today's single-photo drag: only the dragged photo
 *   moves.
 *
 * Pure and side-effect-free: mutating the `selectedIds` Set passed in after
 * this returns has no effect on the array already returned (arrays are
 * returned by value, not as a live view over the Set).
 */
export function computeDragGroupIds(
  activeId: string,
  selectedIds: Set<string>,
  photos: PhotoEntry[]
): string[] {
  if (selectedIds.has(activeId) && selectedIds.size >= 2) {
    return photos
      .filter((p) => selectedIds.has(p.id))
      .sort(compareByCapturedAt)
      .map((p) => p.id)
  }
  return [activeId]
}

// A small fixed concurrency bound for decoding selected photos' dimensions,
// mirroring `UPLOAD_CONCURRENCY` in `hooks/useGooglePhotosUpload.ts` — not an
// unbounded `Promise.all`.
const KEEP_BEST_DECODE_CONCURRENCY = 5

/**
 * Decodes `getPhotoDimensions` for each id in `ids`, in fixed-size batches
 * (mirrors `uploadWithConcurrency` in `hooks/useGooglePhotosUpload.ts`).
 * `getFile` is called fresh for each id at the moment its batch runs, so a
 * photo removed mid-decode simply yields no entry for that id rather than
 * throwing — callers re-validate `ids` against the live photo map after
 * this resolves and don't need this to fail loudly.
 */
async function decodeDimensionsWithConcurrency(
  ids: string[],
  getFile: (id: string) => File | undefined
): Promise<Map<string, { width: number; height: number }>> {
  const result = new Map<string, { width: number; height: number }>()
  for (const batch of chunkArray(ids, KEEP_BEST_DECODE_CONCURRENCY)) {
    const decoded = await Promise.all(
      batch.map(async (id) => {
        const file = getFile(id)
        if (!file) return null
        const dims = await getPhotoDimensions(file)
        return { id, dims }
      })
    )
    for (const entry of decoded) {
      if (entry) result.set(entry.id, entry.dims)
    }
  }
  return result
}

export default function PhotoUploadPage() {
  const {
    photos,
    processFiles,
    addPhotos,
    reorderPhotos,
    updatePhotoName,
    updatePhotoTimestamp,
    updatePhotoTimestamps,
    batchUpdateNames,
    batchSetTimestamps,
    setPhotosTimestamp,
    removePhotos,
    hydratePhotos,
    setPhotoMediaItemId,
  } = usePhotos()
  const { getObjectUrl, releaseObjectUrl } = useObjectUrls()
  const { isSignedIn, accountEmail, isExpiringSoon, accessToken, signIn, signOut } = useGoogleAuth()
  const {
    status: pickerStatus,
    error: pickerError,
    startImport,
    cancelImport,
  } = useGooglePhotosPicker({ accessToken, addPhotos })
  const { uploadState, photoStates, startUpload, retryFailed, reset, seedPhotoStates, notifyPhotoRemoved } =
    useGooglePhotosUpload({ onMediaItemIdSet: setPhotoMediaItemId })
  const { isRestoring, storageWarning, clearAllPersisted } = usePhotoPersistence(
    photos,
    hydratePhotos,
    seedPhotoStates
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // The drag group frozen at drag-start (U1, KTD1) -- see
  // `computeDragGroupIds`'s doc above. Read by `DragOverlay`/`handleDragEnd`
  // in later units; never re-derived from `selectedIds` at drop time.
  const [dragGroupIds, setDragGroupIds] = useState<string[]>([])
  const [albumName, setAlbumName] = useState('')
  const [isNamePromptOpen, setIsNamePromptOpen] = useState(false)
  const [namePromptValue, setNamePromptValue] = useState('')
  // Which photo (if any) the lightbox is currently showing, set by a card's
  // zoom icon and cleared by PhotoLightbox's onClose. PhotoLightbox
  // captures document.activeElement on its own mount to handle focus
  // return, so no extra ref is needed here -- the triggering zoom icon
  // still has focus at the moment this state update causes the lightbox to
  // mount.
  const [zoomedPhotoId, setZoomedPhotoId] = useState<string | null>(null)

  // Copy-mode source id (U2, R2) -- an independent sibling of `selectedIds`
  // and `zoomedPhotoId` (KTD1), never derived from or coupled to the
  // selection. The copied timestamp itself is deliberately NOT snapshotted
  // here or anywhere else; `copiedEntry`/`isCopyModeActive` below re-derive
  // it live from `photosById` on every render instead (see their doc).
  const [copySourceId, setCopySourceId] = useState<string | null>(null)

  // ZIP-build state (U2). Snapshotted once per click (KTD10) -- edits made
  // to photos after a build starts do not affect the in-flight build, and
  // no other control is locked while it runs.
  const [isGeneratingZip, setIsGeneratingZip] = useState(false)
  const [zipDoneCount, setZipDoneCount] = useState(0)
  const [zipTotal, setZipTotal] = useState(0)
  const [zipWarning, setZipWarning] = useState<string | null>(null)

  // Keep-best state. `keepBestResult` is an independent, own-gated sibling
  // banner — never nested inside a `photos.length > 0`-style conditional, so
  // it stays visible even if this action reduces `photos.length` to its
  // minimum (1, the sole survivor). The same slot carries both the
  // completion message and the selection-changed-mid-decode abort message;
  // the two never overlap in time, so one field is enough.
  const [isComparingBest, setIsComparingBest] = useState(false)
  const [keepBestResult, setKeepBestResult] = useState<string | null>(null)
  // The card the floating "Keep best" trigger renders on while a comparison
  // is in flight, frozen at click time -- kept distinct from the live
  // "last-selected" derivation below so the button stays anchored to the
  // same photo for the whole operation even if the selection changes mid
  // decode (that change itself is what the operation's own re-validation
  // later aborts on), rather than jumping to a different card or vanishing.
  const [comparingAnchorId, setComparingAnchorId] = useState<string | null>(null)

  // Add distance constraint so short clicks don't trigger drag (allows checkboxes + inputs to work)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  const activeEntry = activeId ? photos.find((p) => p.id === activeId) : null

  // The true flattened visual order `PhotoGrid` last rendered (see
  // `hooks/useClusteredPhotos.ts`'s `visualOrder` doc) — reactive state, both
  // for the lightbox's prev/next navigation (which needs to re-render when
  // the order changes) and for `handleDragEnd` below, which reads it
  // directly: `handleDragEnd` is a plain function (not a hook, not wrapped
  // in `useCallback`), redefined fresh on every render, so it always closes
  // over this state's latest value with no staleness risk.
  const [visualOrder, setVisualOrder] = useState<string[]>([])

  // Stable identity (empty dep array, only touches setState) so PhotoGrid's
  // `useEffect([visualOrder, onVisualOrderChange])` fires only when
  // `visualOrder` itself changes, not on every PhotoUploadPage render.
  const handleVisualOrderChange = useCallback((order: string[]) => {
    // `useClusteredPhotos`'s `visualOrder` is useMemo'd and reference-stable
    // across unrelated re-renders, but recomputes to a fresh-reference
    // (same-content) array whenever `photos` itself changes identity for ANY
    // reason -- including a rename or timestamp edit that doesn't actually
    // change order. Without this guard, a naive unconditional setState here
    // would cause one unnecessary extra re-render of this component per such
    // content-preserving `photos` mutation (not an unbounded loop -- the
    // resulting re-render doesn't itself change `photos`' identity again).
    // Comparing by content, not reference, avoids that wasted render while
    // still updating state whenever the order actually changes.
    setVisualOrder((prev) => {
      if (
        prev.length === order.length &&
        prev.every((id, i) => id === order[i])
      ) {
        return prev
      }
      return order
    })
  }, [])

  const photosById = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos])

  // Live-read mirror of `photosById`, kept current every render (assigned
  // directly during render, not in a `useEffect` — an effect would still
  // lag one tick behind a synchronous read). `handleKeepBest` below is
  // async and needs to re-check the selection against photos as they
  // actually are at the moment its decode phase resolves, not whatever
  // `photosById` closure it captured back at click time. Same "live ref
  // read from inside an async callback" idiom as `removedPhotoIdsRef` in
  // `hooks/useGooglePhotosUpload.ts`, though that ref tracks removed ids
  // additively rather than mirroring a full snapshot every render.
  const photosByIdRef = useRef(photosById)
  photosByIdRef.current = photosById

  // Same live-read purpose as `photosByIdRef` above, for `selectedIds`:
  // `handleKeepBest` needs to detect not just a deleted photo but any
  // selection change (deselect, reselect, clear) during its decode phase,
  // by comparing its click-time snapshot against the CURRENT selection.
  const selectedIdsRef = useRef(selectedIds)
  selectedIdsRef.current = selectedIds

  // Which card the floating "Keep best" trigger renders on. `selectedIds` is
  // a `Set`, and `Set` preserves insertion order -- re-adding a previously
  // removed id moves it to the end -- so its last element is already
  // "whichever photo was most recently selected" with no extra bookkeeping.
  // While a comparison is in flight, `comparingAnchorId` (frozen at click
  // time) wins instead, so the button doesn't jump to a different card or
  // disappear if the live selection changes before the operation resolves.
  const liveAnchorId = selectedIds.size >= 2 ? Array.from(selectedIds).at(-1)! : null
  const keepBestAnchorId = isComparingBest ? comparingAnchorId : liveAnchorId

  // Live-derived, never snapshotted (KTD1): recomputed from `photosById`
  // fresh every render, so if the source photo is deleted while copy mode is
  // active, `photosById.get` naturally returns `undefined` on the very next
  // render and `isCopyModeActive` goes false with no separate cleanup path
  // (R4). `copiedEntry.capturedAt` is still checked defensively at the
  // render site below (rather than folded into `isCopyModeActive` itself)
  // in case it's ever cleared to null via an unrelated inline edit while
  // copy mode is active -- copy mode still counts as "active" per this
  // derivation (the source photo still exists), it just has nothing to
  // paste until re-entered.
  const copiedEntry = copySourceId ? photosById.get(copySourceId) ?? null : null
  const isCopyModeActive = copiedEntry != null
  const copiedDate = copiedEntry?.capturedAt ?? null

  // Resolves the currently-zoomed photo (if any) the same way the rest of
  // this component looks up a photo's object URL -- via getObjectUrl
  // (hooks/useObjectUrls.ts), keyed off photosById.
  const zoomedPhoto = zoomedPhotoId ? photosById.get(zoomedPhotoId) ?? null : null

  // The zoomed photo's previous/next neighbors in the TRUE visual order
  // (not the flat, purely-chronological `photos` array -- see
  // `handleDragEnd`'s doc above for why those two orderings can diverge).
  // `indexOf` naturally yields `undefined` at either edge of `visualOrder`
  // via out-of-bounds array access, so no extra edge-case branching is
  // needed beyond guarding the "lightbox isn't open" (-1) case.
  const currentVisualIndex = zoomedPhotoId ? visualOrder.indexOf(zoomedPhotoId) : -1
  const prevZoomedId = currentVisualIndex === -1 ? undefined : visualOrder[currentVisualIndex - 1]
  const nextZoomedId = currentVisualIndex === -1 ? undefined : visualOrder[currentVisualIndex + 1]

  // Memoized so each prop's identity only changes when prevZoomedId/
  // nextZoomedId actually changes, not on every unrelated PhotoUploadPage
  // render -- PhotoLightbox's document keydown effect depends on these
  // props, so a fresh function identity on every render would re-register
  // that listener on every render while the lightbox is open (same
  // mechanism as the keystroke-churn fixed in useTimestampEdit).
  const onNavigatePrev = useMemo(
    () => (prevZoomedId ? () => setZoomedPhotoId(prevZoomedId) : undefined),
    [prevZoomedId]
  )
  const onNavigateNext = useMemo(
    () => (nextZoomedId ? () => setZoomedPhotoId(nextZoomedId) : undefined),
    [nextZoomedId]
  )

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (isRestoring) return
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
    if (isRestoring) return
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setSelectedIds(new Set())
      processFiles(e.dataTransfer.files)
      reset()
    }
  }

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id)
    setActiveId(id)
    // Freeze the drag group now, once, per KTD1 -- see
    // `computeDragGroupIds`'s doc above.
    setDragGroupIds(computeDragGroupIds(id, selectedIds, photos))
  }

  // Resolves from/to against the TRUE visual order (`visualOrder` state),
  // not the flat, purely-chronological `photos` array — dnd-kit's `over.id` is
  // resolved from actual DOM hit-testing (i.e. visual order), and a
  // cluster's members aren't guaranteed to be array-contiguous in `photos`
  // (clustering is by hash similarity, not time), so `photos.findIndex`
  // could silently resolve to the wrong neighbors and corrupt the written-
  // back timestamp. See `hooks/useClusteredPhotos.ts`'s `visualOrder` doc.
  //
  // Deliberately does NOT call `reorderPhotos` (`hooks/usePhotos.ts`) — that
  // machinery computes a dropped photo's new timestamp from ITS OWN
  // flat-array neighbors, which is exactly the wrong thing here. Instead,
  // the true final visual neighbors are resolved locally and the N-item
  // interpolation algorithm (`interpolateTimestamps`, ported from
  // `slotTimestamp`/the old single-item `computeDroppedTimestamp`) is
  // applied across the whole group and written in one batched call via
  // `updatePhotoTimestamps` (U3, KTD3/KTD4).
  //
  // U2 (KTD2): generalized from a single dragged photo to the whole frozen
  // `dragGroupIds` (U1). "Extract every group member out of `visualOrder`,
  // reinsert them as one contiguous block at the drop position, then walk
  // outward from that block to find the nearest non-group id on each side"
  // -- the N-item version of the old single-item `arrayMove` + immediate-
  // neighbor read. `effectiveGroupIds` falls back to just `[active.id]`
  // whenever `dragGroupIds` doesn't actually contain the actively-grabbed
  // id (e.g. a stale/empty freeze, or a test driving `onDragEnd` without
  // first going through `onDragStart`), so this always behaves as *at
  // least* a single-item drag -- never crashes or silently drops the
  // active photo out of the resolved order.
  //
  // Direction (insert the block right after `over.id` vs. right before it)
  // is decided from where the actively-grabbed card itself (`active.id`,
  // not just any group member) sat relative to `over.id` in the ORIGINAL
  // visual order -- exactly mirroring `arrayMove(visualOrder, from, to)`'s
  // own behavior (it lands the moved item immediately after `over.id`'s
  // post-removal position when `from < to`, immediately before it when
  // `from > to`). Because of that, this reduces to byte-identical
  // single-item behavior whenever the group has exactly one member (the
  // existing single-drag regression suite covers this).
  //
  // U3: every member of `effectiveGroupIds` gets its own interpolated
  // timestamp (`interpolateTimestamps`), fed the group's TRUE boundary
  // neighbors resolved here, written in exactly one batched
  // `updatePhotoTimestamps` call -- no other photo, in or out of the group,
  // has its timestamp touched by this function (R8).
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event
    setActiveId(null)
    // Reset unconditionally (including this early-return branch), mirroring
    // `setActiveId(null)` above -- otherwise a non-grabbed selected card's
    // dimmed treatment (U4) would survive a completed or cancelled drag
    // until the next drag-start overwrites `dragGroupIds` (doc-review
    // finding, U1/U4).
    setDragGroupIds([])
    if (!over) return

    const activeId = active.id as string
    const overId = over.id as string
    const effectiveGroupIds = dragGroupIds.includes(activeId) ? dragGroupIds : [activeId]
    const groupIdSet = new Set(effectiveGroupIds)

    // Extended no-op guard (adversarial-reviewer fix, plan review): dnd-kit's
    // `over.id` can resolve to ANY member of the frozen drag group -- not
    // just `active.id` -- since a different selected-but-dimmed card is
    // still a valid drop target as far as DOM hit-testing is concerned.
    // Dropping on any of them is a no-op, exactly like dropping on yourself
    // (the old `active.id === over.id` check, now subsumed by this -- every
    // group always contains `active.id`) already was.
    if (groupIdSet.has(overId)) return

    const activeIndex = visualOrder.indexOf(activeId)
    const overIndex = visualOrder.indexOf(overId)
    if (activeIndex === -1 || overIndex === -1) return

    const withoutGroup = visualOrder.filter((id) => !groupIdSet.has(id))
    const overIndexInRest = withoutGroup.indexOf(overId)
    const insertAt = activeIndex < overIndex ? overIndexInRest + 1 : overIndexInRest

    const reordered = [
      ...withoutGroup.slice(0, insertAt),
      ...effectiveGroupIds,
      ...withoutGroup.slice(insertAt),
    ]
    const blockEnd = insertAt + effectiveGroupIds.length - 1
    const prevEntry = photosById.get(reordered[insertAt - 1])
    const nextEntry = photosById.get(reordered[blockEnd + 1])

    // N-item interpolation across the whole group (U3, KTD3/KTD4).
    // `effectiveGroupIds` is already in the group's pre-drag chronological
    // order (`computeDragGroupIds`, U1), so zipping it 1:1 against
    // `interpolateTimestamps`' output assigns each dragged photo a new
    // timestamp that preserves that same relative order. A `null` slot (the
    // "neither boundary has a usable timestamp" branch) is resolved back to
    // that photo's OWN current `capturedAt` -- exactly reproducing the old
    // single-item `computeDroppedTimestamp`'s "keep as-is" behavior, which
    // `interpolateTimestamps` itself can't do since it has no per-item
    // "current" value to fall back to.
    const interpolated = interpolateTimestamps(
      prevEntry?.capturedAt ?? null,
      nextEntry?.capturedAt ?? null,
      effectiveGroupIds.length
    )
    const updates = effectiveGroupIds.map((id, i) => ({
      id,
      date: interpolated[i] ?? photosById.get(id)?.capturedAt ?? null,
    }))
    updatePhotoTimestamps(updates)
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

  // R1: entering copy mode from a card's own copy-timestamp button
  // (rendered by `PhotoCard`/`PhotoGrid` only when that card is the sole
  // selected photo with a non-null `capturedAt` -- see `PhotoGrid.tsx`'s
  // `isSoleSelected` derivation). Toggles off when clicked again on the
  // photo that's already the copy source, so the clipboard icon doubles as
  // an entry/exit control and Esc isn't the only way out of copy mode.
  function handleCopyTimestamp(id: string) {
    setCopySourceId((prev) => (prev === id ? null : id))
  }

  // Esc resolves the "deepest" active state first, one state per keypress:
  // exit copy mode if it's active (R3); otherwise, if nothing is left to
  // exit, clear the selection instead. A second Esc after the first closed
  // copy mode naturally falls into the clear-selection branch, since
  // `isCopyModeActive` is false by the time that keypress is handled.
  // Scoped narrowly to only attach while there's actually something to
  // clear, so it can never interfere with any other keyboard handling when
  // both are already empty. `PhotoCard.tsx`'s own Escape handlers (name-edit
  // and timestamp-edit inputs) call `stopPropagation` alongside
  // `preventDefault`, so a card's own in-progress inline edit never lets its
  // Escape keypress bubble up to this document-level listener in the first
  // place -- no need to defer to an edit-in-progress registry here.
  useEffect(() => {
    if (!isCopyModeActive && selectedIds.size === 0) return

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Escape') return
      if (isCopyModeActive) {
        setCopySourceId(null)
      } else {
        setSelectedIds(new Set())
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isCopyModeActive, selectedIds])

  // Wired into `PhotoGrid`'s `onPaste`/`onPasteToCluster` props (U4, KTD7)
  // below. Each is a thin wrapper over `setPhotosTimestamp` (U1) using the
  // live-derived `copiedDate`, guarded against a null `copiedDate` (e.g.
  // copy mode ended between the paste control rendering and being clicked).
  const handlePasteToCluster = useCallback(
    (ids: string[]) => {
      if (!copiedDate) return
      setPhotosTimestamp(ids, copiedDate)
    },
    [copiedDate, setPhotosTimestamp]
  )

  const handlePaste = useCallback((id: string) => handlePasteToCluster([id]), [handlePasteToCluster])

  // The current selection's distinct existing capturedAt values, deduped
  // by exact millisecond value and sorted ascending — generalized to the
  // whole selection rather than one cluster's members, so it covers a
  // selection spanning multiple clusters or plain timeline photos alike.
  // Recomputed from `photos`/`selectedIds` on every render rather than
  // memoized — this app's photo counts don't warrant it, and every other
  // selection-derived value here (activeEntry, etc.) does the same.
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

  // Accepts an explicit `ids` list (defaulting to the current selection) so
  // the per-card delete icon can delete a single photo that isn't
  // necessarily selected, independent of batch delete. Prunes only those
  // specific ids out of `selectedIds` -- mirroring `toggleSelect`'s
  // build-a-new-Set pattern above -- rather than unconditionally clearing
  // the whole selection, so deleting an unselected photo can't silently
  // wipe out an unrelated multi-photo selection the user already made.
  const handleBatchDelete = useCallback(
    (ids: string[] = Array.from(selectedIds)) => {
      for (const id of ids) {
        const photo = photosById.get(id)
        if (photo) releaseObjectUrl(photo.file)
        notifyPhotoRemoved(id)
      }
      removePhotos(ids)
      setSelectedIds((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
    },
    [selectedIds, photosById, releaseObjectUrl, removePhotos, notifyPhotoRemoved]
  )

  const handleDeletePhoto = useCallback((id: string) => handleBatchDelete([id]), [handleBatchDelete])
  const handleCloseLightbox = useCallback(() => setZoomedPhotoId(null), [])

  // Deletes the currently-zoomed photo and advances the lightbox to its
  // visual neighbor (next preferred, falling back to prev), or closes it if
  // none remain. `prevZoomedId`/`nextZoomedId` are captured from THIS
  // render's pre-delete `visualOrder` state before anything else runs here,
  // per the same visual-order reasoning as `handleDragEnd` above. The
  // `visualOrder` state mirror is spliced immediately (a filter, not
  // mutated in place) so it doesn't wait on the next async recluster
  // round-trip -- `handleDeletePhoto` below still does the real work
  // (object URL release, notifyPhotoRemoved, removePhotos, selectedIds
  // pruning) via the existing, unmodified handleBatchDelete wrapper.
  const handleLightboxDelete = useCallback(() => {
    if (!zoomedPhotoId) return
    const neighbor = nextZoomedId ?? prevZoomedId
    const idToDelete = zoomedPhotoId
    setVisualOrder((prev) => prev.filter((id) => id !== idToDelete))
    handleDeletePhoto(idToDelete)
    setZoomedPhotoId(neighbor ?? null)
  }, [zoomedPhotoId, nextZoomedId, prevZoomedId, handleDeletePhoto])

  // Comprehensive reset (KTD9's "Clear all"): a deliberately much larger
  // blast radius than a single-photo delete, so it's gated behind a native
  // confirm() -- this codebase has no modal/dialog component, and a native
  // confirm is the simplest option consistent with its current UI
  // vocabulary. Order matters: object URLs are released (and
  // notifyPhotoRemoved called) against the CURRENT `photos` before
  // removePhotos clears the in-memory list, then IndexedDB is wiped, then
  // useGooglePhotosUpload's own tracking is reset.
  async function handleClearAll() {
    if (!window.confirm('Clear all photos? This cannot be undone.')) return
    for (const photo of photos) {
      releaseObjectUrl(photo.file)
      notifyPhotoRemoved(photo.id)
    }
    removePhotos(photos.map((p) => p.id))
    await clearAllPersisted()
    reset()
    setSelectedIds(new Set())
  }

  // Keep-best action: compares every currently selected photo by pixel
  // resolution, with file size then upload order as tiebreakers, and
  // deletes every loser via the existing `handleBatchDelete` plumbing
  // unchanged. `ids` is snapshotted at click time; dimension decoding then
  // runs at bounded concurrency. Immediately after decode, the snapshot is
  // re-validated against the live `selectedIdsRef` -- not just that each
  // photo still exists, but that the selection itself hasn't changed
  // (deselect, reselect, or clear all count as a change, same as a
  // deletion) -- this is the only re-check needed, since `window.confirm`
  // below blocks synchronously and nothing between building the comparison
  // and showing it yields to the event loop. The whole flow is wrapped in
  // try/finally so an unexpected rejection during decode can't leave
  // `isComparingBest` stuck true with no way to retry, matching
  // `handleDownloadAll`'s try/catch/finally shape for the same reason.
  // Cluster membership plays no role anywhere in this flow -- `selectedIds`/
  // `photosById` are already flat.
  async function handleKeepBest() {
    const ids = Array.from(selectedIds)
    setIsComparingBest(true)
    // Freeze the anchor card at click time (see `keepBestAnchorId`'s doc
    // above) -- `ids.at(-1)` is the same last-selected id `liveAnchorId`
    // would have computed from `selectedIds` at this exact moment.
    setComparingAnchorId(ids.at(-1) ?? null)

    try {
      const dimensionsById = await decodeDimensionsWithConcurrency(
        ids,
        (id) => photosByIdRef.current.get(id)?.file
      )

      const selectionUnchanged =
        ids.length === selectedIdsRef.current.size &&
        ids.every((id) => selectedIdsRef.current.has(id))
      if (!selectionUnchanged) {
        setKeepBestResult('Selection changed — try again.')
        return
      }

      const candidates = ids.map((id) => {
        const photo = photosByIdRef.current.get(id)!
        const dims = dimensionsById.get(id) ?? { width: 0, height: 0 }
        return {
          id,
          width: dims.width,
          height: dims.height,
          size: photo.file.size,
          uploadIndex: photo.uploadIndex,
        }
      })

      const { winnerId, loserIds } = pickBestPhoto(candidates)
      const winnerPhoto = photosByIdRef.current.get(winnerId)!
      const winnerDims = dimensionsById.get(winnerId) ?? { width: 0, height: 0 }
      // A {0, 0} winner means its decode failed -- omit the resolution
      // clause entirely rather than showing "0×0".
      const hasResolution = winnerDims.width !== 0 || winnerDims.height !== 0
      const resolutionClause = hasResolution ? ` (${winnerDims.width}×${winnerDims.height})` : ''

      // Gated behind window.confirm(), naming the winner and loss count --
      // same native-confirm convention as handleClearAll.
      const confirmed = window.confirm(
        `Keep "${winnerPhoto.filename}"${resolutionClause}? This will delete ${loserIds.length} other selected photo(s).`
      )
      if (!confirmed) return

      // Reuse handleBatchDelete unchanged. The winner's id is deliberately
      // left in selectedIds -- handleBatchDelete only prunes the ids it
      // actually deletes.
      handleBatchDelete(loserIds)
      setKeepBestResult(`Kept "${winnerPhoto.filename}"${resolutionClause}. Removed ${loserIds.length} photo(s).`)
    } catch (err) {
      console.error('Keep best comparison failed', err)
      setKeepBestResult("Couldn't compare photos — try again.")
    } finally {
      setIsComparingBest(false)
      setComparingAnchorId(null)
    }
  }

  // Builds a single ZIP of every currently-loaded photo (R1), ordered by the
  // TRUE visual order (KTD2, KTD9) rather than the flat `photos` array, and
  // triggers its download. The entry list is snapshotted once here -- see
  // buildOrderedZipEntries -- so photo edits made after this click don't
  // affect the in-flight build (KTD10). A rejection (including a single
  // entry's writeTimestamp throwing mid-batch inside buildPhotoZipBlob) is
  // caught and surfaced as a dismissible warning instead of an uncaught
  // rejection or a silent no-op (KTD7).
  async function handleDownloadAll() {
    const entries = buildOrderedZipEntries(visualOrder, photosById)
    setZipWarning(null)
    setZipDoneCount(0)
    setZipTotal(entries.length)
    setIsGeneratingZip(true)
    try {
      const blob = await buildPhotoZipBlob(entries, (done) => setZipDoneCount(done))
      triggerDownload(blob, buildZipFilename(albumName))
    } catch (err) {
      console.error('ZIP build failed', err)
      setZipWarning("Couldn't build the ZIP — try again.")
    } finally {
      setIsGeneratingZip(false)
    }
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
      {/* Marked inert while the lightbox is open so its always-visible,
          zero-confirmation delete controls (per-card delete icon,
          BatchEditPanel's "Delete selected") are unreachable by a screen
          reader's browse-mode cursor -- which walks the accessibility tree
          independent of DOM Tab order and isn't constrained by the
          lightbox's Tab-only focus trap. Per the WAI-ARIA APG dialog
          pattern, `aria-modal` on the dialog only signals the boundary;
          `inert` (or `aria-hidden`) on everything else is what actually
          enforces it. */}
      <div className="max-w-6xl mx-auto px-4 py-10" inert={!!zoomedPhoto}>
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

        {isRestoring && (
          <span className="text-xs text-zinc-500 dark:text-zinc-400 mb-2 block">
            Restoring your photos…
          </span>
        )}

        {storageWarning && (
          <div className="bg-red-50 border border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300 rounded-lg px-3 py-2 text-sm mb-3">
            {storageWarning}
          </div>
        )}

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
            disabled={isRestoring}
            className="sr-only"
          />
        </label>

        {isSignedIn && (
          <div className="flex flex-col items-start gap-2 mb-8">
            <button
              onClick={pickerStatus === 'idle' ? handleImportClick : cancelImport}
              disabled={pickerStatus === 'downloading' || isNamePromptOpen || isRestoring}
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

            {/* Copy-mode status banner (R2/R3) -- always visible for the
                duration of copy mode, mirroring `zipWarning`'s dismiss-button
                layout below. `copiedEntry.capturedAt` is checked separately
                from `isCopyModeActive` (see that derivation's doc) so this
                never crashes formatting a null date. */}
            {isCopyModeActive && copiedEntry && (
              <div className="bg-blue-50 border border-blue-200 text-blue-800 dark:bg-blue-900/20 dark:border-blue-700 dark:text-blue-300 rounded-lg px-3 py-2 text-sm mb-4 flex items-center justify-between gap-3">
                <span>
                  Copying timestamp from <strong>{copiedEntry.filename}</strong>:{' '}
                  {copiedEntry.capturedAt ? formatDate(copiedEntry.capturedAt) : 'No date'}
                </span>
                <button
                  onClick={() => setCopySourceId(null)}
                  className="text-xs underline shrink-0"
                >
                  Done
                </button>
              </div>
            )}

            {/* Upload panel */}
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

            {/* Batch panel */}
            {selectedIds.size > 0 && (
              <BatchEditPanel
                selectedCount={selectedIds.size}
                distinctTimestamps={distinctSelectedTimestamps}
                onBatchRename={handleBatchRename}
                onBatchSetTimestamp={handleBatchSetTimestamp}
                // Wrapped, not passed as a bare `handleBatchDelete`
                // reference: BatchEditPanel invokes this prop as
                // `onClick={onBatchDelete}`, so a bare reference would
                // receive the click's SyntheticEvent as its first argument
                // and defeat `handleBatchDelete`'s
                // `ids = Array.from(selectedIds)` default. The zero-arg
                // wrapper always triggers that default, deleting the
                // current selection.
                onBatchDelete={() => handleBatchDelete()}
                onClearSelection={clearSelection}
              />
            )}

            {/* The unified grid always renders here, drag-wired end to end
                — one grid, no separate cluster view or toggle. */}
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
                onDelete={handleDeletePhoto}
                onZoom={setZoomedPhotoId}
                onVisualOrderChange={handleVisualOrderChange}
                isCopyModeActive={isCopyModeActive}
                copySourceId={copySourceId}
                onPaste={handlePaste}
                onPasteToCluster={handlePasteToCluster}
                onCopyTimestamp={handleCopyTimestamp}
                anchorSelectedId={keepBestAnchorId}
                isComparingBest={isComparingBest}
                onKeepBest={handleKeepBest}
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
          </>
        )}

        {/* Kept mounted whenever a ZIP build is in flight or a warning is
            pending, even if `photos` has just dropped to zero (e.g. the last
            photo was deleted, or "Clear all" was clicked, while a build was
            still running) -- otherwise a build's rejection after the fact
            would call setZipWarning into an unmounted banner and the
            failure would be silently invisible, contradicting handleDownloadAll's
            own KTD7 guarantee ("never an uncaught rejection or a silent
            no-op"). */}
        {(photos.length > 0 || isGeneratingZip || zipWarning) && (
          <div className="mt-6 flex items-center justify-end gap-3">
            {isGeneratingZip && (
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                Zipping {zipDoneCount} of {zipTotal}…
              </span>
            )}
            <button
              onClick={handleClearAll}
              disabled={isRestoring}
              className="px-4 py-2 text-sm font-medium bg-white dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-200 rounded-lg hover:bg-zinc-50 dark:hover:bg-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Clear all
            </button>
            <button
              onClick={handleDownloadAll}
              disabled={isRestoring || isGeneratingZip}
              className="px-4 py-2 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 transition-colors dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Download all
            </button>
          </div>
        )}

        {zipWarning && (
          <div className="bg-red-50 border border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300 rounded-lg px-3 py-2 text-sm mt-3 flex items-center justify-between gap-3">
            <span>{zipWarning}</span>
            <button
              onClick={() => setZipWarning(null)}
              className="text-xs underline shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Keep-best result banner -- an independent, own-gated sibling,
            deliberately NOT nested inside the `photos.length > 0` block
            above: this action can reduce `photos.length` down to 1 (the
            minimum possible survivor count), and a prior banner in this
            exact file was nested inside a data-presence gate and silently
            stopped rendering once that gate went false mid-operation. Same
            slot carries both the completion message and the
            "selection changed" abort message. */}
        {keepBestResult && (
          <div className="bg-blue-50 border border-blue-200 text-blue-800 dark:bg-blue-900/20 dark:border-blue-700 dark:text-blue-300 rounded-lg px-3 py-2 text-sm mt-3 flex items-center justify-between gap-3">
            <span>{keepBestResult}</span>
            <button
              onClick={() => setKeepBestResult(null)}
              className="text-xs underline shrink-0"
            >
              Dismiss
            </button>
          </div>
        )}
      </div>

      {zoomedPhoto && (
        <PhotoLightbox
          filename={zoomedPhoto.filename}
          objectUrl={getObjectUrl(zoomedPhoto.file)}
          capturedAt={zoomedPhoto.capturedAt}
          onClose={handleCloseLightbox}
          onDelete={handleLightboxDelete}
          onTimestampChange={(d) => updatePhotoTimestamp(zoomedPhoto.id, d)}
          onNavigatePrev={onNavigatePrev}
          onNavigateNext={onNavigateNext}
        />
      )}
    </div>
  )
}
