---
title: "Persist Drag-and-Drop Photo Order by Rewriting EXIF Timestamps with Slot-Based Assignment"
date: 2026-04-05
last_updated: 2026-08-17
category: best-practices
module: photo-reorder
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - "Users drag photos into a custom order that must survive re-sort by any gallery app or re-upload"
  - "Photos have heterogeneous or unreliable original EXIF timestamps (multiple cameras, wrong clocks)"
  - "Browser-only pipeline — no server-side storage; EXIF must be modified client-side before download"
tags:
  - exif
  - drag-and-drop
  - dnd-kit
  - piexif-ts
  - timestamp-rewriting
  - photo-ordering
  - browser-exif
  - next-js
---

# Persist Drag-and-Drop Photo Order by Rewriting EXIF Timestamps with Slot-Based Assignment

## Context

Photos uploaded from multiple cameras, phones, or sources frequently arrive with mismatched or wrong EXIF timestamps — different camera clocks, screenshots mixed in, or images that never had timestamps at all. The app displays photos sorted by `DateTimeOriginal`, so display order is entirely driven by EXIF data. When users drag photos into a corrected sequence, that new order must survive not just the current session but also any future re-import into this app or any other gallery tool that sorts by EXIF date. Storing display order only in UI state would mean the corrected sequence is lost the moment files are exported and re-opened.

## Guidance

On every drag-and-drop reorder, update only the moved photo's `capturedAt` timestamp so it slots chronologically between its new neighbors. Do **not** reassign timestamps for unmoved photos — that would discard their original EXIF dates. The moved photo gets:

- **Midpoint** between its new previous and next neighbors if both exist
- **Previous neighbor + 1 second** if moved to the last position
- **Next neighbor − 1 second** if moved to the first position
- **Unchanged** if no neighbors have timestamps

This slotting strategy (called `slotTimestamp`) is O(1) per drag and preserves all other photos' timestamps intact.

> **Supersedes earlier approach**: An earlier version used `assignTimestamps()` which recalculated ALL photos' timestamps as `anchor + index * 1000ms` after every drag. That approach destroyed original EXIF timestamps of every untouched photo and caused all photos to receive the same timestamp if dragged in rapid succession. Replace any `assignTimestamps` usage with `slotTimestamp`.

The timestamp update happens in two places:

1. **State** — the slotting algorithm (midpoint between new neighbors, or a ±1-second edge offset) computes the new `capturedAt` for the moved photo. `hooks/usePhotos.ts`'s `slotTimestamp()`/`reorderPhotos(from, to)` is the original implementation of this algorithm and remains live, tested code — but as of the unified timeline/cluster grid, it is **not** the function the interactive drag handler actually calls. Once photos can be grouped into similarity clusters that render as visual blocks, the flat array position `reorderPhotos` operates on can diverge from what the user actually sees and drops onto (see Related below). The interactive path now runs the *same* slotting algorithm — ported as `computeDroppedTimestamp` in `components/PhotoUploadPage.tsx` — against the true rendered-neighbor pair, then applies it via `updatePhotoTimestamp(id, newDate)` rather than `reorderPhotos`. `reorderPhotos`/`slotTimestamp` is kept because it's still correct for what it does (splicing a flat array) and is still exercised by its own unit tests, but treat it as the algorithm's reference implementation, not the live call path, when tracing an actual user drag.

2. **File (`lib/exif-write.ts`)** — `writeTimestamp(file, newDate)` physically writes `DateTimeOriginal`, `DateTime`, and `DateTimeDigitized` into the JPEG's EXIF segment at download time using `piexif-ts`. PNG/TIFF files pass through unchanged (no writable EXIF format for those types).

Key decisions baked into the implementation:
- All three date tags are written for maximum gallery-app compatibility.
- `capturedAt` in state is updated after every reorder so card labels show the slotted timestamp.
- `reorderPhotos` itself never calls `sortPhotos` after slotting. The live interactive path (`updatePhotoTimestamp`) does call `sortPhotos` after applying the new timestamp — but since the slotted value is deliberately chosen to fall between the photo's real neighbors, the re-sort is a no-op in practice: the photo already belongs exactly where the sort would place it.
- `piexif-ts` operates on base64 DataURLs. If `load()` throws (JPEG with no pre-existing EXIF), the code catches and seeds an empty EXIF object before writing.
- Downloads are triggered sequentially with ~60ms delay to avoid browser throttling from rapid programmatic anchor clicks.

## Why This Matters

Persisting order in EXIF timestamps rather than application state means the corrected sequence travels with the files. A user who downloads and re-imports, shares with someone else, or opens in any third-party viewer gets the same order. Storing order only in React state would make the feature cosmetic — it would fix display within the session but produce no durable artifact. The EXIF write converts a UI gesture into a persistent editorial decision.

## When to Apply

- Any browser-based image tool where users define a custom sort order and need to export files that preserve it.
- When the target consumers of the exported files are gallery apps, camera roll viewers, or any software that sorts by EXIF date rather than filename or filesystem mtime.
- When files may be opened by multiple applications or people — state-only ordering cannot be shared, but EXIF data is universal.
- When PNG/TIFF are in the mix: only write EXIF to JPEG; pass other formats through unchanged but still assign them a timestamp slot in state so grid-position-to-time mapping remains gapless.
- When timestamps may be null: always define an anchor fallback (`new Date()`) so epoch dates or crashes never result.

## Examples

**Current live path** — `computeDroppedTimestamp` (`components/PhotoUploadPage.tsx`) runs the same slotting algorithm shown below against the dragged photo's true visual neighbors (not necessarily its flat-array neighbors — see Related), then applies the result via `updatePhotoTimestamp(id, newDate)`. See `docs/solutions/logic-errors/cluster-drag-timestamp-visual-order-divergence.md` for why the neighbor pair has to come from the rendered order once similarity clustering is in the picture, and why `reorderPhotos` below is no longer the function that runs on a real drag.

**`slotTimestamp` — reference implementation of the slotting algorithm (`hooks/usePhotos.ts`, still live and tested, no longer the interactive drag-end path):**

```ts
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

const reorderPhotos = useCallback((from: number, to: number) => {
  // arrayMove first, then slotTimestamp with the destination index in the moved array
  setPhotos((prev) => slotTimestamp(arrayMove(prev, from, to), to))
  // reorderPhotos does NOT set hasEdits — drag is not treated as a user text edit
}, [])
```

After drag: only the moved photo's timestamp changes. All other photos keep their original `capturedAt`. The moved photo is chronologically positioned between its new neighbors.

**❌ Old approach (do not use):**

```ts
// assignTimestamps — REPLACED because it destroyed all timestamps on every drag
function assignTimestamps(photos: PhotoEntry[]): PhotoEntry[] {
  const nonNull = photos.map((p) => p.capturedAt).filter((d): d is Date => d !== null)
  const anchor = nonNull.length > 0 ? new Date(Math.min(...nonNull.map((d) => d.getTime()))) : new Date()
  return photos.map((p, i) => ({ ...p, capturedAt: new Date(anchor.getTime() + i * 1000) }))
}
// Bug: every photo got a new timestamp, not just the moved one
```

**`writeTimestamp` — file-level EXIF write (`lib/exif-write.ts`):**

```ts
export async function writeTimestamp(file: File, newDate: Date): Promise<Blob> {
  if (file.type !== 'image/jpeg') return file   // PNG/TIFF: pass through

  try {
    const dataURL = await readAsDataURL(file)
    let exifObj: IExif
    try {
      exifObj = load(dataURL)
    } catch {
      exifObj = {}   // no existing EXIF — seed empty object
    }
    if (!exifObj['0th']) exifObj['0th'] = {}
    if (!exifObj.Exif) exifObj.Exif = {}

    const exifDateStr = formatExifDate(newDate)   // "YYYY:MM:DD HH:MM:SS"
    exifObj['0th'][TagValues.ImageIFD.DateTime] = exifDateStr
    exifObj.Exif[TagValues.ExifIFD.DateTimeOriginal] = exifDateStr
    exifObj.Exif[TagValues.ExifIFD.DateTimeDigitized] = exifDateStr

    const exifBinary = dump(exifObj)
    const modifiedDataURL = insert(exifBinary, dataURL)
    return dataURLtoBlob(modifiedDataURL)
  } catch {
    return file   // malformed JPEG: fall back to original
  }
}
```

**Before drag:** photos appear in EXIF timestamp order; timestamps reflect camera-assigned values (possibly wrong or inconsistent).

**After drag + download:** JPEG files contain updated `DateTimeOriginal`/`DateTime`/`DateTimeDigitized` that exactly encode the user's chosen sequence at 1-second intervals anchored to the original earliest date.

## Related

- [`docs/solutions/ui-bugs/drag-and-drop-upload-missing-event-handlers-2026-04-05.md`](../ui-bugs/drag-and-drop-upload-missing-event-handlers-2026-04-05.md) — covers the file-upload drag surface (distinct from the reorder drag surface handled here); both are drag-and-drop in the same app but use separate mechanisms (HTML5 drop zone vs. dnd-kit sortable).
- [`docs/solutions/logic-errors/cluster-drag-timestamp-visual-order-divergence.md`](../logic-errors/cluster-drag-timestamp-visual-order-divergence.md) — once photos can be grouped into similarity clusters that render as visual blocks, the flat array position this doc's original `reorderPhotos`/`slotTimestamp` path used to find "new neighbors" can diverge from what the user actually sees and drops onto. That doc covers the resulting bug and the fix (`computeDroppedTimestamp`, resolving neighbors from the true rendered order); this doc's core slotting algorithm is unaffected and still the right approach — only which neighbor pair feeds it had to change.
