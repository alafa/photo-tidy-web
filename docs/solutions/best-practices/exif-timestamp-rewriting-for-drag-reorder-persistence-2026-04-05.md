---
title: "Persist Drag-and-Drop Photo Order by Rewriting EXIF Timestamps with 1-Second Intervals"
date: 2026-04-05
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

# Persist Drag-and-Drop Photo Order by Rewriting EXIF Timestamps with 1-Second Intervals

## Context

Photos uploaded from multiple cameras, phones, or sources frequently arrive with mismatched or wrong EXIF timestamps — different camera clocks, screenshots mixed in, or images that never had timestamps at all. The app displays photos sorted by `DateTimeOriginal`, so display order is entirely driven by EXIF data. When users drag photos into a corrected sequence, that new order must survive not just the current session but also any future re-import into this app or any other gallery tool that sorts by EXIF date. Storing display order only in UI state would mean the corrected sequence is lost the moment files are exported and re-opened.

## Guidance

On every drag-and-drop reorder, immediately reassign `DateTimeOriginal`, `DateTime`, and `DateTimeDigitized` across the entire photo set using 1-second intervals. The anchor for the sequence is the earliest non-null `capturedAt` timestamp found in the pre-reorder set; if all timestamps are null, `new Date()` at reorder time is used. Every photo in the new grid order gets `anchor + (index * 1000ms)`, making the position-to-timestamp mapping gapless regardless of file type.

The reassignment happens in two places:

1. **State (`hooks/usePhotos.ts`)** — `assignTimestamps()` computes new `capturedAt` values in memory and `reorderPhotos(from, to)` applies them immediately so the UI reflects the assigned date.

2. **File (`lib/exif-write.ts`)** — `writeTimestamp(file, newDate)` physically writes `DateTimeOriginal`, `DateTime`, and `DateTimeDigitized` into the JPEG's EXIF segment at download time using `piexif-ts`. PNG/TIFF files pass through unchanged (no writable EXIF format for those types).

Key decisions baked into the implementation:
- All three date tags are written for maximum gallery-app compatibility.
- `capturedAt` in state is updated after every reorder so card labels show the assigned timestamp, not the original EXIF date.
- `sortPhotos` is never called after `reorderPhotos` — the manual order becomes authoritative until the user re-uploads.
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

**`assignTimestamps` — state-level reassignment (`hooks/usePhotos.ts`):**

```ts
function assignTimestamps(photos: PhotoEntry[]): PhotoEntry[] {
  const nonNull = photos
    .map((p) => p.capturedAt)
    .filter((d): d is Date => d !== null)
  const anchor =
    nonNull.length > 0
      ? new Date(Math.min(...nonNull.map((d) => d.getTime())))
      : new Date()
  return photos.map((p, i) => ({
    ...p,
    capturedAt: new Date(anchor.getTime() + i * 1000),
  }))
}

const reorderPhotos = useCallback((from: number, to: number) => {
  setPhotos((prev) => assignTimestamps(arrayMove(prev, from, to)))
}, [])
```

After drag: photo at index 0 gets `anchor`, index 1 gets `anchor + 1s`, index 2 gets `anchor + 2s`, etc. The original timestamps are discarded; the drag order is now the canonical order.

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
