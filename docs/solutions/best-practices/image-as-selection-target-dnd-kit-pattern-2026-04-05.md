---
title: "Use the Image Itself as the Selection Target in Draggable Photo Grids"
date: 2026-04-05
category: best-practices
module: photo-tidy-web
problem_type: best_practice
component: frontend_stimulus
severity: medium
applies_when:
  - "Implementing multi-select in a photo grid that also supports drag-and-drop reordering"
  - "dnd-kit PointerSensor is active and must coexist with clickable image cards"
  - "Wanting to follow the established photo-app UX pattern (Google Photos, Apple Photos)"
tags:
  - ui-patterns
  - image-selection
  - drag-and-drop
  - dnd-kit
  - pointer-sensor
  - react
  - tailwind
---

# Use the Image Itself as the Selection Target in Draggable Photo Grids

## Context

An initial implementation of photo card selection used an explicit `<label><input type="checkbox">` element positioned above each photo in the grid. The checkbox was a small, separate UI element requiring precise clicking — poor UX for a photo grid where clicking the image itself is the natural selection gesture. The element also clashed visually with the grid layout and made the cards taller than necessary.

The challenge is that the grid uses dnd-kit's `PointerSensor` for drag-and-drop reordering, which begins tracking the pointer on `pointerdown`. Without explicit event handling, a click on the image would be intercepted by the sensor before the selection toggle could fire.

## Guidance

Wrap the `<img>` in a relative-positioned `<div>` that acts as the selection target. Handle two pointer events to coexist with dnd-kit:

1. **`onPointerDown`**: call `e.stopPropagation()` to prevent dnd-kit's PointerSensor from capturing the pointer event and beginning drag tracking.
2. **`onClick`**: call `e.stopPropagation()` and toggle the selection state.

Show visual feedback with:
- A **ring border** on the wrapper when selected (`ring-2 ring-zinc-900`)
- An **absolute-positioned checkmark overlay** in a corner when selected

The `PointerSensor` must also have `activationConstraint: { distance: 8 }` on the parent drag context. Without this, a 0-pixel pointer movement registers as a drag — the distance threshold ensures clicks (no significant movement) never become drags.

```tsx
// components/PhotoCard.tsx
<div
  className={`relative rounded-md overflow-hidden ${onSelect ? 'cursor-pointer' : ''} ${checked ? 'ring-2 ring-zinc-900 dark:ring-zinc-100' : ''}`}
  onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(!checked) } : undefined}
  onPointerDown={onSelect ? (e) => e.stopPropagation() : undefined}
>
  {/* eslint-disable-next-line @next/next/no-img-element */}
  <img
    src={objectUrl}
    alt={filename}
    loading="lazy"
    className="w-full aspect-square object-cover bg-zinc-100"
  />
  {checked && (
    <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center">
      <svg className="w-3 h-3 text-white dark:text-zinc-900" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2 6l3 3 5-5" />
      </svg>
    </div>
  )}
</div>

// In the parent that sets up DndContext (e.g., PhotoUploadPage.tsx):
const sensors = useSensors(
  useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
)
```

Other interactive elements inside the card (inline text inputs, datetime inputs) must also call `e.stopPropagation()` on `onPointerDown` to prevent the sensor from capturing their pointer events.

## Why This Matters

- **Larger target**: Clicking anywhere on the image selects it — no need for precise small-target hits. Critical on touchscreen / mobile.
- **Familiar mental model**: Google Photos, Apple Photos, and most modern gallery apps use full-image click for selection. Meeting this expectation reduces cognitive load.
- **Layout stability**: An overlaid checkmark doesn't shift the grid — no extra vertical space for a label row.
- **dnd-kit compatibility**: Without the `stopPropagation` + `activationConstraint` combination, clicks are either silently swallowed by the sensor or register as zero-distance drags, breaking selection entirely.

## When to Apply

- Any draggable media grid where items must be selectable (photos, videos, documents with thumbnails).
- When both drag-reorder and batch selection must work in the same grid.
- When targeting mobile or touch-first users where small checkbox targets cause friction.

Do not use if selection is not a feature (read-only gallery), or if multiple independent per-card controls compete for the image area — in that case, evaluate a different card layout.

## Examples

**Before — separate checkbox element:**

```tsx
<div className="flex flex-col gap-1">
  {onSelect && (
    <label
      className="flex items-center gap-1.5 cursor-pointer"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={checked ?? false}
        onChange={(e) => onSelect(e.target.checked)}
        className="w-3.5 h-3.5 accent-zinc-900"
      />
    </label>
  )}
  <img src={objectUrl} alt={filename} className="w-full aspect-square object-cover rounded-md" />
</div>
```

Drawbacks: small click target, extra vertical space, visual clutter, doesn't match photo-app conventions.

**After — image wrapper as selection target:**

```tsx
<div
  className={`relative rounded-md overflow-hidden cursor-pointer ${checked ? 'ring-2 ring-zinc-900 dark:ring-zinc-100' : ''}`}
  onClick={(e) => { e.stopPropagation(); onSelect(!checked) }}
  onPointerDown={(e) => e.stopPropagation()}
>
  <img src={objectUrl} alt={filename} className="w-full aspect-square object-cover bg-zinc-100" />
  {checked && (
    <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-zinc-900 flex items-center justify-center">
      <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M2 6l3 3 5-5" />
      </svg>
    </div>
  )}
</div>
```

## Related

- [`docs/solutions/best-practices/exif-timestamp-rewriting-for-drag-reorder-persistence-2026-04-05.md`](./exif-timestamp-rewriting-for-drag-reorder-persistence-2026-04-05.md) — covers the broader drag-and-drop reorder + EXIF write pattern; also discusses dnd-kit sensor configuration.
- [`docs/solutions/ui-bugs/drag-and-drop-upload-missing-event-handlers-2026-04-05.md`](../ui-bugs/drag-and-drop-upload-missing-event-handlers-2026-04-05.md) — illustrates the broader pattern of requiring explicit `onDragOver`/`onDrop` handlers on the file-upload drop zone; related event-handling discipline.
- [`docs/solutions/best-practices/scope-escape-key-handling-with-stoppropagation-not-cross-component-state.md`](./scope-escape-key-handling-with-stoppropagation-not-cross-component-state.md) — the same `stopPropagation` isolation convention (`CardOverlayButton`, same file) applied to a second event type: `keydown`/Escape bubbling to a document-level listener, instead of `pointerdown`/`click` reaching dnd-kit's `PointerSensor`.
