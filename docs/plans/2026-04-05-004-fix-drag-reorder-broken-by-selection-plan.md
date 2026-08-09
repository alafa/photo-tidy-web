---
title: "fix: Restore drag-reorder timestamp slotting broken by image selection"
type: fix
status: completed
date: 2026-04-05
---

# fix: Restore drag-reorder timestamp slotting broken by image selection

## Overview

Drag-and-drop reordering stopped updating the moved photo's `capturedAt` timestamp
when the image wrapper was made selectable. The root cause is a `stopPropagation()`
call on the image wrapper's `onPointerDown` that prevents dnd-kit's `PointerSensor`
from ever receiving the pointer-down event, so drag tracking never initializes.

## Problem Frame

`PhotoCard.tsx` was updated to make clicking the image toggle photo selection. To
prevent a selection click from being misinterpreted as a drag, `e.stopPropagation()`
was added to the image wrapper's `onPointerDown`. This over-blocked: the dnd-kit
`PointerSensor` receives drag events via the outer wrapper in `SortablePhotoCard.tsx`,
and `stopPropagation()` prevents the pointer-down from ever reaching that wrapper.
Consequently dnd-kit never starts tracking movement and `handleDragEnd` never fires,
so `reorderPhotos` / `slotTimestamp` never runs.

The `PointerSensor` in `PhotoUploadPage.tsx` already has
`activationConstraint: { distance: 8 }`, which distinguishes taps (< 8 px movement →
normal click → selection toggle) from intentional drags (≥ 8 px → drag activates,
suppresses the `click` event). The `stopPropagation` on `onPointerDown` was
solving a problem that the activation constraint already solves.

## Requirements Trace

- R1. Dragging a photo to a new position must update that photo's `capturedAt` to
  slot between its new neighbors (via `slotTimestamp` in `hooks/usePhotos.ts`).
- R2. Clicking the image must still toggle photo selection without accidentally
  triggering a reorder.
- R3. Existing interactions (name edit, timestamp edit, batch select) must be
  unaffected.

## Scope Boundaries

- No changes to `slotTimestamp`, `reorderPhotos`, or any hook logic.
- No changes to the `PointerSensor` configuration.
- Selection UI (ring, checkmark overlay) and `onClick` handler remain unchanged.

## Context & Research

### Relevant Code and Patterns

- `components/PhotoCard.tsx:130-134` — image wrapper with the offending `onPointerDown`
- `components/SortablePhotoCard.tsx:36` — dnd-kit `listeners` on the outer wrapper
- `components/PhotoUploadPage.tsx:36` — `PointerSensor` with `distance: 8` constraint
- `hooks/usePhotos.ts:77-80` — `reorderPhotos` calls `slotTimestamp`

### Institutional Learnings

- `docs/solutions/best-practices/image-as-selection-target-dnd-kit-pattern-2026-04-05.md`
  documents that `onPointerDown` stopPropagation on interactive card elements is
  required to prevent the sensor from stealing events — but this applies to elements
  that should never initiate a drag (text inputs, buttons). The image wrapper both
  selects *and* drags, so it must not stop propagation.
- `docs/solutions/best-practices/exif-timestamp-rewriting-for-drag-reorder-persistence-2026-04-05.md`
  confirms `slotTimestamp` is the correct post-drag hook.

## Key Technical Decisions

- **Remove `onPointerDown` from the image wrapper entirely** rather than changing its
  implementation. The `distance: 8` activation constraint is the correct mechanism for
  separating tap-to-select from drag-to-reorder; no secondary guard is needed.
- **Do not move dnd-kit listeners into `PhotoCard`**. The current architecture
  (listeners on the `SortablePhotoCard` outer wrapper, `PhotoCard` unaware of dnd-kit)
  is a clean separation that should be preserved.

## Implementation Units

- [ ] **Unit 1: Remove `onPointerDown` from image wrapper in `PhotoCard`**

**Goal:** Allow pointer-down events on the image to reach the dnd-kit `PointerSensor`
on the outer `SortablePhotoCard` wrapper, restoring drag detection while keeping
tap-to-select working via `onClick`.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `components/PhotoCard.tsx`

> **Test coverage note:** No automated test covers the pointer-event path (PointerSensor →
> handleDragEnd → reorderPhotos). `hooks/usePhotos.test.ts` exercises `slotTimestamp`
> in isolation but cannot verify that removing `stopPropagation` actually allows the
> sensor to fire. Verification is manual (see Verification below).

**Approach:**
- Remove the `onPointerDown` prop from the image wrapper `<div>` at line 133 of
  `components/PhotoCard.tsx`. The `onClick` handler and all other props remain.
- The `distance: 8` constraint on `PointerSensor` already handles the
  tap-vs-drag distinction: short taps fire `onClick` (selection); movements ≥ 8 px
  activate a drag and suppress `click`.
- The `e.stopPropagation()` call inside the `onClick` handler is intentionally
  retained. Its purpose is unrelated to drag: it prevents a click on the image
  from bubbling to any ancestor click handler (e.g., a future card-level wrapper).
  It does not interfere with dnd-kit because dnd-kit's `click` suppression operates
  at the event-dispatch level, not via bubbling.
- No other file changes needed.

**Patterns to follow:**
- The text inputs in `PhotoCard` (`name`, `datetime-local`) retain their own
  `onPointerDown={(e) => e.stopPropagation()}` — those elements must never start a
  drag and do not need click detection, so they are correctly guarded. The image
  wrapper is different: it needs both click and drag.

**Test scenarios:**
- Happy path: drag photo from position A to position B → `capturedAt` of moved photo
  updates to midpoint between new neighbors; all other photos' timestamps unchanged.
- Happy path: short tap on image (< 8 px movement) → selection toggles; no reorder fires.
- Regression: clicking the filename or timestamp fields still opens inline edit without
  triggering drag.

**Verification:**
- Dragging any photo updates the timestamp shown on its card to a value between its
  new neighbors.
- Clicking any photo image toggles the selection ring and checkmark with no reorder side effect.
- The `usePhotos.test.ts` suite passes without modification.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| dnd-kit `click` suppression may not fire in all browsers after a drag | The `distance: 8` constraint is the standard dnd-kit pattern; no known browser gaps. Manual test on Safari. |
| Touch devices: long-press ambiguity between select and drag | Existing `distance: 8` constraint applies to touch too; accepted as a known UX trade-off documented in the image-as-selection-target solution doc. |

## Sources & References

- Related code: `components/PhotoCard.tsx`, `components/SortablePhotoCard.tsx`, `components/PhotoUploadPage.tsx`, `hooks/usePhotos.ts`
- Institutional: `docs/solutions/best-practices/image-as-selection-target-dnd-kit-pattern-2026-04-05.md`
- Institutional: `docs/solutions/best-practices/exif-timestamp-rewriting-for-drag-reorder-persistence-2026-04-05.md`
