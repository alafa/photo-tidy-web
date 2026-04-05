---
title: "feat: Drag-and-Drop Photo Reordering with EXIF Timestamp Rewriting"
type: feat
status: completed
date: 2026-04-05
---

# feat: Drag-and-Drop Photo Reordering with EXIF Timestamp Rewriting

## Overview

Users can drag photos in the grid to any position. On reorder, `DateTimeOriginal` is reassigned across all photos using 1-second intervals so the new sequence survives a re-sort by any gallery app. Modified JPEG files can be downloaded individually or all at once.

## Problem Frame

The upload-and-display feature shows photos sorted by EXIF timestamp, but users often have photos out of order (different cameras, wrong clocks, screenshots mixed in). This feature lets users drag photos into the correct sequence and export the corrected files.

## Requirements Trace

- R1. Drag any photo card to a new position; the grid reorders immediately.
- R2. On reorder, reassign `DateTimeOriginal` (and `DateTime`, `DateTimeDigitized` for compatibility) across all photos using 1-second intervals, starting from the earliest non-null `capturedAt` in the pre-reorder set. If all timestamps are null, use `new Date()` at reorder time as the anchor.
- R3. Each photo in the new sequence consumes one slot (including PNG/TIFF), keeping position-to-timestamp mapping gapless.
- R4. `capturedAt` in state is updated to the newly assigned timestamp after every reorder so cards display the current assigned date.
- R5. Modified JPEG files can be downloaded (individual or "Download all"). PNG/TIFF files are downloaded as-is (no EXIF write).
- R6. A second call to `processFiles` (re-upload) replaces all photos and resets to EXIF-sorted order, discarding any manual reordering.

## Scope Boundaries

- No undo/redo.
- No append-to-existing-grid (re-upload always replaces).
- No EXIF write for PNG/TIFF — download as-is at original file content.
- No export of a ZIP — individual downloads only.
- No sub-second precision (`DateTimeOriginal` is `YYYY:MM:DD HH:MM:SS`; no `SubSecTimeOriginal`).

## Context & Research

### Relevant Code and Patterns

- `hooks/usePhotos.ts` — owns `PhotoEntry[]` state and `processFiles`; needs `reorderPhotos(from, to)` added
- `components/PhotoGrid.tsx` — pure presentational, needs sortable context wrapping
- `components/PhotoCard.tsx` — pure presentational, needs `useSortable` affordance
- `components/PhotoUploadPage.tsx` — `'use client'` boundary; will host `DndContext` and download button
- `lib/exif.ts` — read-only EXIF; new `lib/exif-write.ts` for writing
- `docs/solutions/ui-bugs/drag-and-drop-upload-missing-event-handlers-2026-04-05.md` — `onDragOver`/`onDrop` must be paired; dnd-kit manages its own event layer, but any custom native drop zones still need `preventDefault`

### External References

- `@dnd-kit/core` v6.x + `@dnd-kit/sortable` v10.x + `@dnd-kit/utilities` v3.x — React 19 compatible since v6.3.1; use `rectSortingStrategy` for 2D grid; avoid new `@dnd-kit/react` v0.x (unstable)
- `piexif-ts` — TypeScript fork of piexifjs; operates on base64 DataURL strings; only JPEG; wrap load/dump/insert in try/catch per file
- Download: `URL.createObjectURL` + anchor `.click()` + `setTimeout(revokeObjectURL, 100)` (Firefox needs the delay)
- base64 inflation: ~33% memory overhead per file; process download sequentially not in parallel

## Key Technical Decisions

- **`piexif-ts` over raw piexifjs**: TypeScript types, more recent maintenance (March 2024). Accept the maintenance caveat; it's the best available browser JPEG writer.
- **1-second intervals**: Simplest reassignment that guarantees strict ordering in all gallery apps. Anchor = earliest non-null `capturedAt` pre-reorder; fallback = `new Date()`.
- **Update all three date fields**: `DateTimeOriginal`, `DateTime`, `DateTimeDigitized` for maximum gallery compatibility.
- **`capturedAt` updated in state after reorder**: Cards show assigned timestamp immediately; no separate `assignedAt` field needed.
- **`sortPhotos` never called after `reorderPhotos`**: The manual order becomes the authoritative state. Re-sort only happens via `processFiles`.
- **`DndContext` lives in `PhotoUploadPage`**: Keeps the sortable boundary co-located with the state owner; `PhotoGrid` and `PhotoCard` remain importable outside drag context.
- **`DragOverlay` for visual fidelity**: Renders a floating card at pointer position during drag; prevents layout shift.
- **PNG/TIFF consume a timestamp slot**: Position-to-time mapping is gapless by grid index, even for non-writable files.

## Open Questions

### Resolved During Planning

- **Timestamp anchor when all null**: Use `new Date()` at reorder time. Predictable; avoids epoch timestamps.
- **Second upload**: Replace (current behavior). No merge path in this feature.
- **Should PNG/TIFF consume a slot**: Yes. Gapless by grid position.
- **EXIF write scope**: JPEG only. piexif-ts does not support TIFF or PNG.

### Deferred to Implementation

- **`piexif-ts` load behavior on JPEG with no existing EXIF**: Library may throw when loading. Wrap in try/catch; if load fails, provide an empty seed EXIF object before writing.
- **Sequential vs. batch download for large sets**: Start sequential with a small delay (~60ms) between programmatic clicks. If browser throttles, investigate Blob URL queue approach.
- **Download button placement on `PhotoCard`**: Inline icon or hover-reveal — decide during UI implementation based on feel.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
PhotoUploadPage ('use client')
  ├─ DndContext (onDragEnd → reorderPhotos)
  │    └─ SortableContext (photos[], rectSortingStrategy)
  │         └─ PhotoGrid
  │              └─ SortablePhotoCard × N   (useSortable wraps PhotoCard)
  │                   └─ PhotoCard (unchanged props)
  ├─ DragOverlay → floating PhotoCard clone
  └─ "Download all" button → downloadAll(photos)
                              ├─ for each photo:
                              │    ├─ JPEG → writeTimestamp(file, assignedDate) → Blob
                              │    └─ PNG/TIFF → original File as-is
                              └─ triggerDownload(blob, filename)

usePhotos:
  reorderPhotos(from, to):
    1. arrayMove(photos, from, to)        // new display order
    2. assignTimestamps(reordered)        // 1-second intervals from anchor
    3. setPhotos(reordered with new capturedAt)
```

## Implementation Units

- [ ] **Unit 1: Install dnd-kit and piexif-ts**

**Goal:** Add the two new runtime dependencies so subsequent units can import them.

**Requirements:** Prerequisite for all other units.

**Dependencies:** None.

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Approach:**
- Install `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` (classic packages, not `@dnd-kit/react`)
- Install `piexif-ts`
- Verify there are no peer-dep conflicts with React 19; if `SortableContext` JSX errors occur, add `skipLibCheck: true` to `tsconfig.json`

**Test expectation: none** — dependency installation only; no behavioral change.

**Verification:**
- Both packages appear in `package.json` dependencies
- `npm run build` succeeds

---

- [ ] **Unit 2: EXIF write utility**

**Goal:** Implement `writeTimestamp(file, newDate)` that returns a modified JPEG Blob with updated EXIF date fields. PNG/TIFF pass through unchanged.

**Requirements:** R2, R5.

**Dependencies:** Unit 1.

**Files:**
- Create: `lib/exif-write.ts`
- Test: `lib/exif-write.test.ts`

**Approach:**
- For JPEG (`file.type === 'image/jpeg'`): use `FileReader.readAsDataURL` → `piexif.load` → set `DateTimeOriginal`, `DateTime`, `DateTimeDigitized` to EXIF format string `YYYY:MM:DD HH:MM:SS` → `piexif.dump` → `piexif.insert` → convert DataURL back to Blob.
- If `piexif.load` throws (no existing EXIF), start with an empty EXIF seed object and write the date tags directly.
- For PNG/TIFF: return the original `File` (typed as `Blob`) unchanged.
- EXIF date format helper: `formatExifDate(date: Date): string` → `"YYYY:MM:DD HH:MM:SS"` (no timezone, always display value).
- Wrap entire JPEG path in try/catch; on error return original `File` as fallback.

**Patterns to follow:**
- `lib/exif.ts` — same try/catch/null pattern for error handling

**Test scenarios:**
- Happy path: JPEG File → returns Blob with updated `DateTimeOriginal` readable by exifr
- All three date fields: Blob contains `DateTime` and `DateTimeDigitized` matching the written value
- No existing EXIF: JPEG with no EXIF segment → Blob gets the new timestamp inserted without throwing
- PNG pass-through: PNG File → returned Blob is identical to the original file bytes
- TIFF pass-through: TIFF File → returned Blob is identical to the original file bytes
- Error recovery: malformed JPEG → returns original File (no throw)

**Verification:**
- Function signature: `(file: File, newDate: Date) => Promise<Blob>`
- All test scenarios pass

---

- [ ] **Unit 3: `reorderPhotos` action in `usePhotos`**

**Goal:** Add a `reorderPhotos(fromIndex, toIndex)` action that reorders the photo array and reassigns `capturedAt` with 1-second intervals.

**Requirements:** R1, R2, R3, R4, R6.

**Dependencies:** Unit 2 (shares timestamp assignment logic with EXIF write, but state update is independent).

**Files:**
- Modify: `hooks/usePhotos.ts`
- Test: `hooks/usePhotos.test.ts`

**Approach:**
- Import `arrayMove` from `@dnd-kit/sortable` to compute new order.
- `assignTimestamps(photos: PhotoEntry[]): PhotoEntry[]` — pure function:
  - Anchor = earliest non-null `capturedAt` in the array; if all null, use `new Date()`.
  - For each photo at index `i`: `capturedAt = new Date(anchor.getTime() + i * 1000)`.
  - Returns new array with updated `capturedAt` (never mutates in place).
- `reorderPhotos(from: number, to: number)`: calls `arrayMove` then `assignTimestamps` then `setPhotos`.
- `processFiles` continues to call `setPhotos(sortPhotos(entries))` — no change; re-upload still re-sorts.

**Patterns to follow:**
- `hooks/usePhotos.ts` — existing `useCallback` + `setPhotos` pattern

**Test scenarios:**
- Happy path: reorder index 2 to index 0 → first photo in new array was at index 2, `capturedAt` values are 1-second sequential from anchor
- Timestamp anchor: array with mixed null/non-null `capturedAt` → anchor is the minimum non-null value
- All-null anchor: all `capturedAt` null → new `capturedAt` values are set to sequential seconds from a Date close to `new Date()` (test with a time range check, not exact equality)
- Single photo: reorder(0, 0) → no change in order, timestamp reassignment still runs
- Re-upload after reorder: `processFiles` called after `reorderPhotos` → state is fully replaced with EXIF-sorted order (manual order discarded)
- No mutation: original `PhotoEntry` objects are not mutated; `photos` array before and after reorder are different references

**Verification:**
- All test scenarios pass
- `usePhotos` exports `{ photos, processFiles, reorderPhotos }`

---

- [ ] **Unit 4: Sortable grid components**

**Goal:** Wrap `PhotoGrid` and `PhotoCard` with dnd-kit to enable visual drag reordering.

**Requirements:** R1.

**Dependencies:** Units 1, 3.

**Files:**
- Create: `components/SortablePhotoCard.tsx`
- Modify: `components/PhotoGrid.tsx`
- Modify: `components/PhotoUploadPage.tsx`
- Test: `components/PhotoGrid.test.tsx` (new file)

**Approach:**
- `SortablePhotoCard`: thin wrapper using `useSortable(id)` from `@dnd-kit/sortable`. Sets `transform` and `transition` via `CSS.Transform.toString`. Passes `listeners` and `attributes` to a drag handle (the image itself, or a grip icon). Renders `PhotoCard` with existing props.
- `PhotoGrid`: add `onReorder?: (from: number, to: number) => void` prop. When provided, wrap children in `SortableContext` with `rectSortingStrategy`. Use `SortablePhotoCard` instead of `PhotoCard` when `onReorder` is present. When absent, render exactly as before (no breaking change).
- `PhotoUploadPage`: wrap `PhotoGrid` in `DndContext`. Implement `handleDragEnd(event)` using `arrayMove` index lookup; call `reorderPhotos`. Render `DragOverlay` showing a floating `PhotoCard` clone during drag.
- Stable IDs for `SortableContext`: use `${filename}-${file.lastModified}-${uploadIndex}` (same as existing React key).

**Patterns to follow:**
- `components/PhotoCard.tsx` — prop interface pattern
- `components/PhotoUploadPage.tsx` — existing `'use client'` handler pattern

**Test scenarios:**
- Happy path: `PhotoGrid` with `onReorder` renders `SortablePhotoCard` elements
- No `onReorder` prop: `PhotoGrid` renders plain `PhotoCard` elements (backward compatible)
- `handleDragEnd` with valid over/active IDs → calls `reorderPhotos` with correct from/to indices
- `handleDragEnd` when `over` is null (drop outside grid) → `reorderPhotos` is not called
- `DragOverlay` active item: when `activeId` is set, an additional floating `PhotoCard` is rendered

**Verification:**
- Dragging a card in the browser visually reorders it and updates dates shown below cards
- `PhotoGrid` without `onReorder` passes existing tests unchanged

---

- [ ] **Unit 5: File download**

**Goal:** Add download functionality — a "Download all" button that writes updated EXIF to all JPEG photos and triggers individual file downloads.

**Requirements:** R5.

**Dependencies:** Units 2, 3, 4.

**Files:**
- Create: `lib/download.ts`
- Modify: `components/PhotoUploadPage.tsx`
- Test: `lib/download.test.ts`

**Approach:**
- `lib/download.ts` exports `triggerDownload(blob: Blob, filename: string): void` — creates anchor, sets `download`, programmatic click, `setTimeout(revokeObjectURL, 100)`.
- `lib/download.ts` exports `downloadPhoto(entry: PhotoEntry): Promise<void>` — calls `writeTimestamp(entry.file, entry.capturedAt ?? new Date())` then `triggerDownload`.
- `PhotoUploadPage`: "Download all" button appears when `photos.length > 0`. On click, iterates `photos` sequentially with a ~60ms delay between downloads to avoid browser throttling.
- Individual download: small download icon on each `PhotoCard` (or `SortablePhotoCard`). Optional for MVP — include if straightforward, skip if it complicates the drag handle.

**Patterns to follow:**
- `lib/exif.ts` — async/await with try/catch; no throws to UI

**Test scenarios:**
- Happy path: `triggerDownload` creates and clicks an anchor with correct `download` attribute set to filename
- Cleanup: `revokeObjectURL` is called after the timeout
- `downloadPhoto` JPEG: calls `writeTimestamp` then `triggerDownload` with the modified Blob
- `downloadPhoto` PNG: calls `triggerDownload` with original File (no `writeTimestamp` call)
- Sequential batch: "Download all" with 3 photos triggers `downloadPhoto` 3 times in order

**Verification:**
- Clicking "Download all" produces one file download per photo with the original filename
- JPEG files opened in a viewer show the reassigned timestamp in metadata

## System-Wide Impact

- **Interaction graph:** `DndContext` in `PhotoUploadPage` intercepts pointer events across the entire grid. Existing `onDragOver`/`onDrop` file-upload handlers on the `<label>` are unaffected — they handle OS file drops, not dnd-kit pointer events.
- **State lifecycle:** `reorderPhotos` produces a new array with updated `capturedAt` values. `processFiles` (re-upload) always replaces state entirely — no partial merge.
- **`useObjectUrls` unchanged:** Object URLs are keyed by `File` reference. `arrayMove` moves `PhotoEntry` objects without replacing the `file` reference, so existing URLs remain valid after reorder.
- **`PhotoCard` key stability:** Key is `${filename}-${lastModified}-${uploadIndex}`. `uploadIndex` is set at `processFiles` time and never changes on reorder; keys remain stable through drags.
- **Unchanged invariants:** The `lib/exif.ts` read path, `PhotoCard`/`PhotoGrid` rendering, and `useObjectUrls` cleanup are all unchanged. `PhotoGrid` without `onReorder` behaves identically to today.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `piexif-ts` silently corrupts JPEG on certain camera brands | Wrap entire write path in try/catch; fall back to original file on error |
| base64 inflation causes memory pressure for large batches | Process download sequentially; document 100-photo practical limit |
| dnd-kit `SortableContext` JSX type error with React 19 strict types | Add `skipLibCheck: true` to `tsconfig.json` if needed |
| Browser throttles sequential programmatic downloads | Use ~60ms delay between downloads; increase if throttling observed |
| `piexif.load` throws on JPEG with no EXIF segment | Catch and seed with empty EXIF object before writing date tags |

## Sources & References

- Related code: `hooks/usePhotos.ts`, `components/PhotoGrid.tsx`, `lib/exif.ts`
- Institutional learning: `docs/solutions/ui-bugs/drag-and-drop-upload-missing-event-handlers-2026-04-05.md`
- External: dnd-kit React 19 compatibility — https://github.com/clauderic/dnd-kit/issues/1511
- External: piexif-ts — https://github.com/holwech/piexif-ts
- External: JPEG EXIF binary manipulation — https://getaround.tech/exif-data-manipulation-javascript/
- External: URL.createObjectURL download pattern — https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static
