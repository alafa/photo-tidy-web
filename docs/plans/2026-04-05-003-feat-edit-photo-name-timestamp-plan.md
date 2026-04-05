---
title: "feat: Add inline and batch editing of photo name and timestamp"
type: feat
status: active
date: 2026-04-05
---

# feat: Add inline and batch editing of photo name and timestamp

## Overview

Users can currently upload photos and reorder them by drag-and-drop, but name and timestamp fields on each card are read-only. This plan adds:

- **Individual editing**: click a card's filename or date label to edit it inline
- **Batch editing**: checkbox selection across cards, with a panel to rename or set timestamps for all selected photos at once

All edits stay in browser state and are applied to downloaded files at export time — consistent with the existing browser-only, no-server architecture.

## Problem Frame

Photo names default to the original filename (often `IMG_1234.jpg`) and timestamps default to EXIF data (often from a camera clock that is wrong or inconsistent). Users need to correct both before downloading. The lack of editability is a gap between what the app displays and what a user can meaningfully act on.

## Requirements Trace

### Individual Editing
- R1. User can click a photo card's filename to edit it inline; change is committed on Enter or blur, cancelled on Escape.
- R2. User can click a photo card's date label (or "No date") to edit it inline with a datetime-local input; change is committed on Enter or blur, cancelled on Escape; empty input reverts capturedAt to null.
- R3. After a timestamp edit, the grid re-sorts by capturedAt (same as on upload).
- R4. Empty filename is rejected on commit; the edit field reverts to the previous value.

### Batch Operations
- R5. User can check one or more photo cards; a batch edit panel appears with the selected count.
- R6. Batch rename: user enters a base name; selected photos are renamed `basename-01.ext`, `basename-02.ext`, … (zero-padded to selection-count digit length, each file keeps its own extension) in current display order.
- R7. Batch timestamp: user picks a start datetime; selected photos receive timestamps at 1-second intervals from the anchor in current display order; grid re-sorts afterwards.

### Safety & Interactions
- R8. Before replacing photo state on re-upload, if any edits have been made the user is prompted to confirm.
- R9. Dragging a photo after timestamp edits overwrites all timestamps (drag wins — existing behavior, documented visually to the user).

## Scope Boundaries

- No undo/redo history.
- No multi-card drag (drag moves one card at a time, same as today).
- No rename-to-match-timestamp or auto-numbering beyond the batch pattern.
- No persistence across sessions — edits live only until the page is refreshed.
- EXIF timestamps are not written eagerly on edit; they are written at download time (existing `writeTimestamp` path).

## Context & Research

### Relevant Code and Patterns

- `hooks/usePhotos.ts` — sole state owner; `PhotoEntry` type lives here; all new edit actions will be added here following the existing `useCallback` + functional `setPhotos` updater pattern
- `components/PhotoCard.tsx` — renders filename and date labels; will gain inline edit inputs; uses `timeZone: 'UTC'` for display (datetime-local input must parse as UTC for consistency)
- `components/PhotoGrid.tsx` — `photoId()` currently uses `filename` in the composite key; must change to a stable UUID before name editing is implemented
- `components/SortablePhotoCard.tsx` — attaches `{...listeners}` to the outer div; checkbox must call `e.stopPropagation()` to avoid triggering drag sensor on checkbox clicks
- `components/PhotoUploadPage.tsx` — owns `processFiles` call sites (both `handleChange` and `handleDrop`); re-upload guard added here
- `lib/exif-write.ts` — `writeTimestamp(file, newDate)` writes all three EXIF date tags; called at download time; no changes needed
- `lib/download.ts` — `downloadAll` already uses `entry.filename` from state for the download filename; renamed photos will download correctly with no changes

### Institutional Learnings

- `docs/solutions/best-practices/exif-timestamp-rewriting-for-drag-reorder-persistence-2026-04-05.md` — all three EXIF date tags must be written together; `piexif-ts load()` throws on JPEGs with no EXIF segment (catch and seed `{}`); PNG/TIFF pass through; EXIF writing happens at download time, not on every state change
- `docs/solutions/ui-bugs/drag-and-drop-upload-missing-event-handlers-2026-04-05.md` — `onDrop` requires a paired `onDragOver` with `preventDefault()`; checkbox inside a dnd-kit listener surface must stop propagation

### External References

None gathered — local patterns are sufficient.

## Key Technical Decisions

- **Stable photo IDs**: Add `id: string` (assigned via `crypto.randomUUID()` in `processFiles`) to `PhotoEntry`. Update `photoId()` to return `entry.id` directly. Removes the current key fragility where renaming a photo would cause React to unmount and remount its card mid-edit.

- **`hasEdits` flag in usePhotos**: A `boolean` state variable (default `false`) set to `true` by any edit action, reset to `false` by `processFiles`. Drives the re-upload confirmation guard without needing to diff against original EXIF data.

- **Drag wins**: `reorderPhotos` continues to call `assignTimestamps` unconditionally, overwriting all `capturedAt` values. Manual timestamp edits made before a drag are lost. This keeps the existing behavior and avoids introducing a "pinned" timestamp concept. A tooltip or banner warns users when edits are present that a drag will reset timestamps.

- **UTC-safe datetime-local parsing**: `datetime-local` inputs produce strings like `"2024-06-01T10:30"` which the browser's `new Date()` parses in local time. The app stores EXIF clock times as UTC values. New dates from the input must be constructed with `Date.UTC()` treating the input string as UTC clock time (e.g., `"2024-06-01T10:30"` → `new Date(Date.UTC(2024, 5, 1, 10, 30, 0))`).

- **Batch rename format**: `basename-N.ext` where `N` is zero-padded to `String(selectionCount).length` digits and each file keeps its own extension from `entry.file.name`. The general formula handles all counts: for 5 selected → `"-1"` through `"-5"` (1 digit); for 15 selected → `"-01"` through `"-15"` (2 digits). No special-casing needed — the formula produces the correct result for any count including 1.

- **Batch timestamp applies to selection in display order**: The `photos` array in state reflects the current grid order. `batchSetTimestamps` filters to the selected IDs in the order they appear in `photos`, assigns `anchor + i * 1000ms`, then re-sorts the full array.

- **Selection state lives in PhotoUploadPage**: A simple `useState<Set<string>>` alongside the existing `activeId` state. Not worth a dedicated hook given its limited complexity; selection is purely UI concern, not tied to photo data logic.

## Open Questions

### Resolved During Planning

- **Interaction between drag and manual timestamp edits**: Drag wins (see Key Technical Decisions above). Keeping `assignTimestamps` unchanged is the simplest correct behavior.
- **UTC semantics for datetime-local input**: Parse input string as UTC using `Date.UTC()` (see Key Technical Decisions).
- **Batch rename suffix format**: Zero-padded to selection digit count, each file keeps its own extension (see Key Technical Decisions).
- **Selection after batch operation**: Persists — user can chain rename then timestamp set without re-selecting.
- **Re-upload behavior when edits exist**: `window.confirm()` dialog in `handleChange` and `handleDrop` before calling `processFiles`.
- **"No date" edit affordance**: Clicking the "No date" label opens the same `datetime-local` input with no pre-fill. Saving empty reverts to null.

### Deferred to Implementation

- **Exact CSS for inline edit inputs**: Match existing card typography (font-size, color) — implementation detail.
- **Batch panel exact layout and positioning**: Fixed bottom bar or floating panel above the download button — implementation judgment call.
- **Drag-warning visual**: Tooltip vs. inline banner vs. none — implementation judgment call, keep it minimal.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
PhotoUploadPage
├── selectedIds: Set<string>            ← new
├── hasEdits (via usePhotos)            ← new
│
├── upload label (handleChange + handleDrop)
│   └── re-upload guard: if hasEdits → window.confirm()  ← new
│
├── DndContext (unchanged)
│   └── PhotoGrid
│       └── SortablePhotoCard (per photo)
│           └── PhotoCard
│               ├── <img>
│               ├── filename label → inline <input type="text">    ← new
│               ├── date label    → inline <input type="datetime-local">  ← new
│               └── checkbox (stopPropagation on pointer down)  ← new
│
├── BatchEditPanel (visible when selectedIds.size > 0)  ← new
│   ├── "{N} selected" count
│   ├── Rename: [base name input] [Apply]
│   └── Set timestamp: [datetime-local input] [Apply]
│
└── Download all button (unchanged)

usePhotos additions:
  updatePhotoName(id, newName)
  updatePhotoTimestamp(id, newDate | null)   → triggers re-sort
  batchUpdateNames(ids, baseName)
  batchSetTimestamps(ids, anchorDate)        → triggers re-sort
  hasEdits: boolean
```

## Implementation Units

- [ ] **Unit 1: Stable photo IDs**

**Goal:** Add a stable `id` field to `PhotoEntry` so photo keys are not fragile against name changes; update all usages of the composite `photoId()` function.

**Requirements:** Prerequisite for all editing work (R1–R7).

**Dependencies:** None.

**Files:**
- Modify: `hooks/usePhotos.ts`
- Modify: `components/PhotoGrid.tsx`
- Modify: `components/PhotoUploadPage.tsx`
- Test: `hooks/usePhotos.test.ts`

**Approach:**
- Add `id: string` to the `PhotoEntry` type.
- Assign `crypto.randomUUID()` to each entry inside the `processFiles` loop.
- Update `photoId()` in `PhotoGrid.tsx` to return `entry.id` directly.
- Update `PhotoUploadPage.tsx`: `activeEntry` lookup uses `p.id === activeId`; drag start/end already use the string returned by `photoId`, so they pick up the change transparently.

**Patterns to follow:**
- `hooks/usePhotos.ts` — existing `processFiles` loop where `PhotoEntry` objects are constructed.

**Test scenarios:**
- Happy path: after `processFiles`, every photo in `photos` has a unique non-empty `id` string.
- Happy path: two photos from the same file (same `file.lastModified`, same name) get distinct IDs.
- Happy path: `photoId(entry)` returns the same value as `entry.id`.
- Edge case: calling `processFiles` twice produces two fully distinct sets of IDs (no ID reuse).

**Verification:**
- All existing drag-and-drop tests pass unchanged.
- `photoId` no longer references `entry.filename`.

---

- [ ] **Unit 2: Edit actions in usePhotos**

**Goal:** Add `updatePhotoName`, `updatePhotoTimestamp`, `batchUpdateNames`, `batchSetTimestamps`, and `hasEdits` to the hook.

**Requirements:** R1–R4, R6, R7, R8.

**Dependencies:** Unit 1 (stable IDs).

**Files:**
- Modify: `hooks/usePhotos.ts`
- Modify: `hooks/usePhotos.test.ts`

**Approach:**
- `hasEdits: boolean` — a separate `useState(false)`, set to `true` by any edit action (`updatePhotoName`, `updatePhotoTimestamp`, `batchUpdateNames`, `batchSetTimestamps`), reset to `false` inside `processFiles`. `reorderPhotos` does **not** set `hasEdits` — drag reordering rewrites timestamps but is not treated as a user edit for guard purposes.
- `updatePhotoName(id, newName)` — spreads the matched entry with new `filename`; no re-sort needed. Sets `hasEdits`.
- `updatePhotoTimestamp(id, newDate | null)` — spreads the matched entry with new `capturedAt`, then runs `sortPhotos` on the full array. Sets `hasEdits`.
- `batchUpdateNames(ids: string[], baseName: string)` — iterates `photos` in array order, filters to those whose `id` is in `ids`, assigns `${baseName}-${paddedIndex}.${ext}` (zero-padded to `String(ids.length).length` digits, extension from `entry.file.name`). The `ids` parameter is a lookup set only — the function must iterate `photos` and filter, never iterate `ids` directly, to guarantee display order. Extension always comes from `entry.file.name` (the original file type), not `entry.filename` (which may have been renamed by the user). Updates matching entries immutably. Sets `hasEdits`.
- `batchSetTimestamps(ids: string[], anchorDate: Date)` — iterates `photos` in array order, assigns `anchorDate + i * 1000ms` to entries whose `id` is in `ids` (i is the rank among selected entries), then runs `sortPhotos` on the full array. Sets `hasEdits`.
- All actions use functional `setPhotos` updater. No mutation of existing `PhotoEntry` objects.
- Export `hasEdits` from the hook return value.

**Patterns to follow:**
- Existing `reorderPhotos` — `useCallback` + functional `setPhotos` + spreading entries.
- Existing `sortPhotos` pure function — called directly after timestamp mutations.

**Test scenarios:**
- Happy path: `updatePhotoName` changes only the target entry's `filename`; all other entries are unchanged.
- Happy path: `updatePhotoTimestamp` changes the target entry's `capturedAt` and the resulting array is sorted ascending by timestamp.
- Happy path: `updatePhotoTimestamp(id, null)` sets `capturedAt` to null and moves the entry to the end.
- Happy path: `batchUpdateNames(["id1","id2","id3"], "beach")` produces `"beach-1.jpg"`, `"beach-2.png"`, `"beach-3.jpg"` (each preserving its own extension), and no other entries are changed.
- Happy path: `batchUpdateNames` with 10 photos selected uses zero-padding (`"beach-01"` through `"beach-10"`).
- Happy path: `batchSetTimestamps(ids, anchor)` assigns `anchor`, `anchor+1s`, `anchor+2s` in display-array order for the selected IDs; full array re-sorts; unselected entries' `capturedAt` values are unchanged.
- Happy path: `hasEdits` is `false` initially, becomes `true` after any edit action, and resets to `false` after `processFiles`.
- Edge case: `updatePhotoName` with an ID not in `photos` → no state change, no error.
- Edge case: `batchSetTimestamps` with a single ID → that entry is rank 0 among selected, so it gets `anchorDate + 0ms = anchorDate` exactly.
- Edge case: `batchUpdateNames` with a single ID → `String(1).length = 1` digit, so suffix is `"-1"` (the formula produces this without special-casing).
- Edge case: `batchUpdateNames` called with `ids` in reverse display order still assigns suffixes in display order (because the function iterates `photos`, not `ids`).
- Integration: does not mutate any `PhotoEntry` object in place (spread test).

**Verification:**
- All new actions exported from `usePhotos`.
- No regression in `reorderPhotos` or `processFiles` tests.

---

- [ ] **Unit 3: Inline editing on PhotoCard**

**Goal:** Make the filename and date labels on each card click-to-edit with inline inputs. Individual editing calls `updatePhotoName` / `updatePhotoTimestamp`.

**Requirements:** R1, R2, R3, R4.

**Dependencies:** Unit 2.

**Files:**
- Modify: `components/PhotoCard.tsx`
- Test: `components/PhotoCard.test.tsx`

**Approach:**
- `PhotoCard` receives two new optional props: `onNameChange(newName: string)` and `onTimestampChange(newDate: Date | null)`.
- When props are absent (e.g., the `DragOverlay` preview), the card renders read-only (current behavior preserved).
- **Name editing**: local `isEditingName: boolean` state; clicking the filename paragraph switches it to a controlled `<input type="text">`; Enter or blur commits (validate non-empty before calling `onNameChange`; if empty, revert and clear edit state); Escape clears edit state without calling the callback.
- **Timestamp editing**: local `isEditingTimestamp: boolean` state; clicking the date paragraph (or "No date") switches it to a `<input type="datetime-local">`; pre-filled with the current `capturedAt` value formatted as `"YYYY-MM-DDTHH:MM"` using UTC components; Enter or blur commits — if value is non-empty, parse as UTC (`Date.UTC(year, month, day, hour, min)`), call `onTimestampChange(newDate)`; if empty, call `onTimestampChange(null)`; Escape reverts without calling callback.
- Only one field is in edit mode at a time (opening one closes the other).
- Inputs inherit the same typography as the labels they replace to avoid layout shift.

**Patterns to follow:**
- Existing label rendering in `PhotoCard.tsx` — `<p>` for filename and date; `dateFormatter` with `timeZone: 'UTC'`.
- Controlled input pattern common in the codebase's test files.

**Test scenarios:**
- Happy path: clicking the filename renders a text input pre-filled with the current filename.
- Happy path: typing a new name and pressing Enter calls `onNameChange` with the new value.
- Happy path: typing a new name and blurring calls `onNameChange`.
- Happy path: pressing Escape discards the edit and shows the original filename without calling `onNameChange`.
- Error path: clearing the input and pressing Enter does NOT call `onNameChange`; the original name is shown.
- Happy path: clicking the date label renders a datetime-local input pre-filled with the UTC value.
- Happy path: setting a new date and pressing Enter calls `onTimestampChange(Date)` with a correctly UTC-interpreted date.
- Happy path: clearing the datetime-local input and pressing Enter calls `onTimestampChange(null)`.
- Happy path: clicking "No date" label opens the datetime-local input with an empty pre-fill.
- Happy path: pressing Escape on the timestamp input discards the edit.
- Edge case: when `onNameChange` and `onTimestampChange` are absent, clicking labels does nothing (read-only mode for DragOverlay).
- Integration: `onTimestampChange` is called with a `Date` where `date.getUTCHours()` matches the hours typed in the input (not shifted by local timezone).

**Verification:**
- `DragOverlay` preview (`PhotoCard` without callbacks) renders correctly with no interactive elements.
- Layout does not shift visibly when entering or exiting edit mode.

---

- [ ] **Unit 4: Selection state and checkboxes**

**Goal:** Add per-card checkboxes and a shared selection state; wire selection into `PhotoGrid` and `PhotoUploadPage`.

**Requirements:** R5.

**Dependencies:** Unit 1 (stable IDs needed for selection keys).

**Files:**
- Modify: `components/PhotoCard.tsx`
- Modify: `components/PhotoGrid.tsx`
- Modify: `components/PhotoUploadPage.tsx`

**Approach:**
- **Selection state in PhotoUploadPage**: `const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())`. No dedicated hook — this is a straightforward UI state. Reset to empty on `processFiles`.
- `toggleSelect(id)` helper in PhotoUploadPage: toggles the ID in and out of the set.
- **Checkbox in PhotoCard**: rendered when an `onSelect?: (checked: boolean) => void` prop is provided. Checkbox calls `e.stopPropagation()` on `pointerdown` to prevent dnd-kit's `PointerSensor` from treating the click as a drag start.
- Pass `checked={selectedIds.has(entry.id)}` and `onSelect` down through `PhotoGrid` → `SortablePhotoCard` → `PhotoCard`.
- **Select all / Clear** controls: rendered in `PhotoUploadPage` above the grid when `photos.length > 0`. A "Select all" button sets `selectedIds` to all photo IDs; a "Clear selection" button empties it. Show only when photos are present.
- When `processFiles` replaces photo state, also call `setSelectedIds(new Set())`.

**Patterns to follow:**
- Existing prop-threading pattern through `PhotoGrid` → `SortablePhotoCard` → `PhotoCard`.
- `SortablePhotoCard` is a thin wrapper — it should forward the new props without logic.

**Test scenarios:**
- Happy path: checking a card's checkbox adds its ID to `selectedIds`.
- Happy path: unchecking removes it.
- Happy path: "Select all" adds every photo's ID to selection.
- Happy path: "Clear selection" empties the set.
- Edge case: checkbox `pointerdown` stops propagation — drag sensor is not activated by a checkbox interaction.
- Edge case: after `processFiles`, `selectedIds` is empty regardless of prior selection.

**Verification:**
- Drag-and-drop still works correctly when checkboxes are present.
- No checkbox renders in the `DragOverlay` preview (PhotoCard without `onSelect`).

---

- [ ] **Unit 5: Batch edit panel**

**Goal:** Show a panel when at least one photo is selected, offering batch rename and batch timestamp controls.

**Requirements:** R6, R7.

**Dependencies:** Units 2, 4.

**Files:**
- Create: `components/BatchEditPanel.tsx`
- Modify: `components/PhotoUploadPage.tsx`
- Test: `components/BatchEditPanel.test.tsx`

**Approach:**
- `BatchEditPanel` props: `selectedCount: number`, `onBatchRename(baseName: string): void`, `onBatchSetTimestamp(anchor: Date): void`.
- Panel is rendered in `PhotoUploadPage` between the grid and the download button, visible only when `selectedIds.size > 0`.
- **Rename section**: a text input for base name + "Apply" button. Button disabled while input is empty. On apply: calls `batchUpdateNames(Array.from(selectedIds), baseName)`.
- **Timestamp section**: a `datetime-local` input + "Apply" button. Button disabled while input is empty. On apply: parse input as UTC → call `batchSetTimestamps(Array.from(selectedIds), anchorDate)`.
- Display `"{N} selected"` with a "Clear" link to reset selection.
- UTC parsing for datetime-local follows the same convention as Unit 3 (treat input string as UTC clock time).

**Patterns to follow:**
- Existing button styling in `PhotoUploadPage.tsx` — `bg-zinc-900 text-white rounded-lg`.
- Controlled input pattern from Unit 3.

**Test scenarios:**
- Happy path: panel renders when `selectedCount > 0`, hidden when 0.
- Happy path: filling in a base name and clicking Apply calls `onBatchRename` with the typed value.
- Happy path: filling in a datetime and clicking Apply calls `onBatchSetTimestamp` with a correctly UTC-parsed Date.
- Error path: Apply for rename is disabled/no-op when base name input is empty.
- Error path: Apply for timestamp is disabled/no-op when datetime input is empty.
- Happy path: selected count is displayed correctly.
- Integration: after `onBatchRename` is called, selected filenames in the parent's state are updated and cards reflect new names.
- Integration: after `onBatchSetTimestamp` is called, grid re-sorts and selected cards show new timestamps.
- Integration: after `onBatchSetTimestamp`, cards that were checked remain checked at their new grid positions after re-sort (stable-ID invariant holds end-to-end).

**Verification:**
- Panel does not render when no photos are selected.
- Download all still works correctly after batch operations.

---

- [ ] **Unit 6: Re-upload confirmation guard**

**Goal:** Warn users before a new upload replaces their edited photos.

**Requirements:** R8.

**Dependencies:** Unit 2 (`hasEdits` from usePhotos), Unit 4 (`selectedIds` state and reset on `processFiles`).

**Files:**
- Modify: `components/PhotoUploadPage.tsx`

**Approach:**
- Destructure `hasEdits` from `usePhotos()`.
- In both `handleChange` and `handleDrop`, before calling `processFiles`, check: if `hasEdits`, call `window.confirm("Uploading new photos will discard your edits. Continue?")`. If the user cancels, return early. If confirmed (or no edits), proceed to `processFiles`.
- Also clear `selectedIds` when `processFiles` is called (already covered in Unit 4).

**Patterns to follow:**
- Existing `handleChange` and `handleDrop` guard patterns in `PhotoUploadPage.tsx`.

**Test scenarios:**
- Happy path: when `hasEdits` is false, `processFiles` is called without a confirm dialog.
- Happy path: when `hasEdits` is true and user confirms, `processFiles` is called.
- Happy path: when `hasEdits` is true and user cancels, `processFiles` is NOT called and current state is preserved.
- Integration: applies to both the file-input `onChange` path and the drag-drop path.

**Verification:**
- Without edits, uploading proceeds immediately (no spurious dialog).
- With edits, user gets one confirm dialog and can back out.

## System-Wide Impact

- **Interaction graph**: `processFiles` now resets `hasEdits` and clears `selectedIds` — both callers (`handleChange`, `handleDrop`) go through the guard before calling it. `reorderPhotos` / `assignTimestamps` continue to overwrite all `capturedAt` values, including manually edited ones (drag wins).
- **Error propagation**: validation errors (empty name) are handled locally in `PhotoCard`; no error surfaces to the parent hook.
- **State lifecycle risks**: `id` is assigned once at upload and never changes; a second `processFiles` call generates fresh IDs for the new file set. Selection IDs referencing the old set are cleared before the new set arrives.
- **API surface parity**: `lib/download.ts` and `lib/exif-write.ts` are unchanged — they already consume `entry.filename` and `entry.capturedAt` from state, so edits flow through correctly.
- **Unchanged invariants**: drag-and-drop reordering behavior is fully preserved; `sortPhotos` is still only called on upload and after timestamp edits; the EXIF write-at-download-time pattern is unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `crypto.randomUUID()` not available in older browsers | Next.js 16 targets modern evergreen browsers; acceptable. |
| `datetime-local` input format varies across browsers (Safari partially supports it) | Test in Safari; if unsupported, inline edit degrades gracefully to read-only (callbacks absent). |
| Drag after manual edit silently overwrites timestamps | UI warning near grid when `hasEdits` is true; documented in scope boundaries. |
| `window.confirm()` blocked in some embedded contexts | Acceptable for this single-page browser app; no server or iframe context. |

## Sources & References

- Related code: `hooks/usePhotos.ts`, `components/PhotoCard.tsx`, `components/PhotoGrid.tsx`, `components/PhotoUploadPage.tsx`
- Institutional: `docs/solutions/best-practices/exif-timestamp-rewriting-for-drag-reorder-persistence-2026-04-05.md`
- Institutional: `docs/solutions/ui-bugs/drag-and-drop-upload-missing-event-handlers-2026-04-05.md`
