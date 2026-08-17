---
title: "Cluster Drag-Drop Resolved Neighbors From the Flat Chronological Array Instead of True Visual Order, Silently Misfiling EXIF Timestamps"
date: 2026-08-17
category: logic-errors
module: photo-dedup
problem_type: logic_error
component: tooling
symptoms:
  - "Dragging a photo within a cluster whose members were not array-contiguous in the flat photos array silently wrote the wrong EXIF timestamp, with no error, crash, or visual indicator"
  - "handleDragEnd resolved drop indices via photos.findIndex (flat, purely-chronological array order) while dnd-kit's over.id reflects actual DOM hit-testing against the cluster-grouped visual render order, so the two orders could disagree and corrupt the computed midpoint timestamp"
  - "A cluster containing one dated photo and one null-capturedAt duplicate reliably triggered the divergence: earliestCapturedAtMs excludes nulls from a cluster's display position while sortPhotos/compareByCapturedAt sorts null-timestamp photos to the very end of the flat array, guaranteeing the two orderings disagree"
  - "Found in code review (correctness + adversarial reviewers, independently corroborated, then independently validated by a fresh validator subagent) as a P0 silent-data-corruption bug, not from a user-visible crash or failing test"
root_cause: logic_error
resolution_type: code_fix
severity: critical
tags: [photo-dedup, drag-and-drop, dnd-kit, visual-order-vs-array-order, exif-timestamp, silent-data-corruption, clustering, code-review]
---

# Cluster Drag-Drop Resolved Neighbors From the Flat Chronological Array Instead of True Visual Order, Silently Misfiling EXIF Timestamps

## Problem

Dragging a photo in the unified timeline/cluster grid could write the **wrong timestamp** back into its EXIF data — silently, with no error and no visual sign — whenever the drop happened near a similarity-cluster whose members were not contiguous in the app's flat, chronologically-sorted `photos` array.

## Symptoms

This is a silent-corruption bug, not a crash or visible failure:

- No error, exception, or console warning at drag time.
- The drag animation, drop, and grid re-render all look completely normal.
- The only observable symptom is a **wrong final timestamp** on the dragged photo — discoverable only by inspecting the photo's EXIF data after the fact, or by noticing on a later reload that the photo re-sorted into an unexpected chronological position (because the app always re-derives grid order from `capturedAt`).
- Because the bug depends on specific data shapes (a non-array-contiguous cluster, or a cluster containing a null-`capturedAt` member), it would not reproduce on every drag — only on drops that happened to interact with one of these configurations, making it especially easy to miss in ad hoc manual testing.

## What Didn't Work

This wasn't caught by failed debugging attempts — no one hit it in the running app first. It was caught by code review before shipping, but it's worth recording as a near-miss because the plan's own design reasoning believed it had already closed this exact risk class, and because the tension it comes from predates this refactor entirely.

**(session history)** The chronological-vs-similarity ordering question for this same cluster view was already contested once before, in the session that originally built `ClusterView.tsx` (branch `fix/google-photos-sync`, spanning 2026-08-09 through 2026-08-16). Its evolution: the original plan settled cross-cluster ordering as "chronological, not by cluster size"; a later pivot in the same session deliberately introduced **similarity-based ordering** — both cross-cluster position (via a centroid/`hierarchicalOrder` traversal) and within-cluster member order (most-similar-adjacent) — at the user's request; a subsequent pivot then reverted *cross-cluster* ordering back to chronological after the user reported "everything jumps around when I move the slider," but explicitly left **within-cluster member ordering by mutual similarity untouched** at that point ("only the cross-cluster/cross-photo positioning was reverted"). That the two ordering dimensions (cross-cluster vs. within-cluster) were tracked and reverted separately, with one left on similarity-order after the other was fixed, is the same shape of gap that let this bug through later: fixing one ordering dimension without verifying every other dimension the render layer depends on.

The refactor that unified the timeline and cluster views (`docs/plans/2026-08-17-001-refactor-unify-timeline-cluster-views-plan.md`) picked up from that state and believed it had now closed the gap for good. Its **KTD3** changed within-cluster member ordering from similarity-based (`hierarchicalOrder`) to chronological, specifically to protect `handleDragEnd`'s correctness:

> "Chronological member order keeps visual order, `SortableContext` order, and array order identical everywhere, which is what actually keeps `reorderPhotos` correct inside a cluster, not merely simpler."

**KTD2** then built on that guarantee to justify leaving `handleDragEnd`'s existing flat-array index resolution untouched:

> "`PhotoUploadPage`'s existing `handleDragEnd` already resolves `from`/`to` via `photos.findIndex`, which only depends on array order, not DOM nesting — so `reorderPhotos`/`slotTimestamp` need no changes. This correctness claim depends on KTD3: the sortable items array, the rendered visual order, and the chronologically-sorted `photos` array must all agree at every position, including inside a cluster — if a cluster's members were ordered any other way, the id a user visually drops onto would not be the id `slotTimestamp` treats as chronologically adjacent, silently misfiling the timestamp."

That reasoning fixed ordering *within* a cluster's own members but missed a level: KTD3 never established that a cluster's member *block* sits at the same position in the rendered sequence as it does in the flat array. Clustering groups photos by perceptual-hash similarity, which is unrelated to time, so nothing guarantees a cluster's members are array-contiguous relative to the *other*, non-member photos around them. The render layer (`renderBlocks` in `hooks/useClusteredPhotos.ts`) places a whole cluster as one block at its earliest member's chronological position — but any non-member singleton whose own timestamp falls between the cluster's earliest and latest member still renders *after* the cluster block, even though it sorts *between* those members in the flat array. Two ways this actually manifested, both later turned into regression tests:

1. **Non-contiguous cluster.** Photos A (t=1) and C (t=3) hash-match and cluster; B (t=2) does not. Flat `photos` order: `A, B, C`. Visual render order: `A, C, B` (the cluster block, anchored at A's earliest timestamp, renders as one unit before B's singleton run). A drop resolved via `photos.findIndex` against the visually-adjacent id lands on the wrong flat-array neighbors.
2. **Null-timestamp cluster-mate.** A cluster has one dated member and one member with a null `capturedAt` (e.g. a hash-matched duplicate that lost its EXIF data on re-export). The cluster's render position (`earliestCapturedAtMs`) excludes null members from that calculation, so the cluster still renders mid-grid at the dated member's position — but the flat array's `sortPhotos`/`compareByCapturedAt` sorts null-timestamp photos to the very tail. The null member's visual position (mid-grid) and its flat-array position (tail) are guaranteed to diverge.

The finding came from a multi-persona code review: `correctness-reviewer` traced it directly from the array/index logic in `handleDragEnd`; `adversarial-reviewer`, working independently, constructed the null-timestamp scenario from first principles. Both landed on the same root cause via different techniques. A separate validator subagent then constructed a third, independent counter-example before the fix was trusted.

## Solution

The fix adds a second, explicitly "visual" ordering alongside the existing flat chronological array, and moves `handleDragEnd`'s neighbor resolution onto that visual ordering instead.

**`hooks/useClusteredPhotos.ts`** — `UseClusteredPhotosResult` gained a `visualOrder: string[]` field, computed by flattening `renderBlocks` into the exact id sequence the grid actually renders (cluster block members in their already-chronological within-cluster order, singleton runs in their chronological order):

```ts
// hooks/useClusteredPhotos.ts:271-281
const visualOrder = useMemo(() => {
  const order: string[] = []
  for (const block of renderBlocks) {
    if (block.type === 'cluster') {
      order.push(...block.cluster.members)
    } else {
      for (const cluster of block.clusters) order.push(cluster.members[0])
    }
  }
  return order
}, [renderBlocks])
```

**`components/PhotoGrid.tsx`** — `SortableContext`'s `items` now uses `visualOrder` instead of the old flat `photos.map(p => p.id)` (this also fixes a secondary drag-ghost-animation concern, since dnd-kit's rect-based collision detection wants `items` to match actual DOM order):

```tsx
// components/PhotoGrid.tsx:315
<SortableContext items={visualOrder} strategy={rectSortingStrategy}>
```

A new optional prop, `onVisualOrderChange`, reports the order up via an effect keyed on the order actually changing (`components/PhotoGrid.tsx:107-109`):

```tsx
useEffect(() => {
  onVisualOrderChange?.(visualOrder)
}, [visualOrder, onVisualOrderChange])
```

**`components/PhotoUploadPage.tsx`** — stores the reported order in a `useRef` rather than state, so receiving updates doesn't force extra renders; `handleDragEnd` is a plain function that reads the ref fresh on every call (`components/PhotoUploadPage.tsx:100-107, 152-173`):

```ts
const visualOrderRef = useRef<string[]>([])
const handleVisualOrderChange = useCallback((order: string[]) => {
  visualOrderRef.current = order
}, [])

// ...

function handleDragEnd(event: DragEndEvent) {
  const { active, over } = event
  setActiveId(null)
  if (!over || active.id === over.id) return

  const visualOrder = visualOrderRef.current
  const from = visualOrder.indexOf(active.id as string)
  const to = visualOrder.indexOf(over.id as string)
  if (from === -1 || to === -1) return

  const reordered = arrayMove(visualOrder, from, to)
  const prevEntry = photosById.get(reordered[to - 1])
  const nextEntry = photosById.get(reordered[to + 1])
  const currentEntry = photosById.get(active.id as string)

  const newTimestamp = computeDroppedTimestamp(
    prevEntry?.capturedAt ?? null,
    nextEntry?.capturedAt ?? null,
    currentEntry?.capturedAt ?? null
  )
  updatePhotoTimestamp(active.id as string, newTimestamp)
}
```

`from`/`to` are now resolved against the ref's visual order, not `photos`. After computing the post-drop visual neighbor pair, the new timestamp is computed using the *same* midpoint/edge-offset algorithm `hooks/usePhotos.ts`'s `slotTimestamp` already used — ported as `computeDroppedTimestamp` (`components/PhotoUploadPage.tsx:39-58`) rather than reinvented — and applied via the existing `updatePhotoTimestamp(id, newTimestamp)` call instead of the old `reorderPhotos(from, to)`.

`hooks/usePhotos.ts`'s `reorderPhotos`/`slotTimestamp`/`arrayMove` machinery was deliberately left unchanged and unremoved. It is still correct for what it does — splicing a flat array and slotting a timestamp from that array's own neighbors — it's just no longer the right tool for this call site once visual and flat order can diverge. It's kept because `PhotoGrid`'s `onReorder` prop still uses it as a stable "dragging enabled" flag reference, and because removing well-tested code with no behavioral gain was judged not worth it.

Two regression tests were added to `components/PhotoUploadPage.test.tsx` (in the `describe('non-contiguous cluster and null-timestamp visual-order fix (P0)', ...)` block, lines 455-573), each exercising the real, unmocked `useClusteredPhotos`/`PhotoGrid` pipeline rather than mocks:

- `'non-contiguous cluster: resolves the dropped timestamp from the true visual neighbors, not the flat-array neighbors'` (line 467) — builds A/B/C exactly as in scenario 1 above, confirms the rendered visual order is really `['a.jpg', 'c.jpg', 'b.jpg']` diverging from the flat `[A, B, C]`, drags B onto C, and asserts the resulting timestamp is the midpoint of A/C's true visual neighbors — while explicitly asserting it is **not** `c.capturedAt + 1000ms`, the value the old flat-array-`findIndex` bug would have produced.
- `"null-timestamp cluster-mate: resolves the dropped timestamp from the true visual neighbor, not the null-dated member's flat-array tail position"` (line 518) — builds D1/D2/D3/N1 exactly as in scenario 2, confirms the rendered order is `['d2.jpg', 'd1.jpg', 'n1.jpg', 'd3.jpg']` (cluster mid-grid) versus the flat array's `[d2, d1, d3, n1]` (n1 at the tail), drags D3 onto N1, and asserts the result is `d1.capturedAt + 1000ms` — while explicitly asserting it is **not** `d3.capturedAt` unchanged, the "keep as-is" fallback the old bug would have hit by treating N1 (a null-timestamp id) as D3's sole flat-array neighbor.

## Why This Works

Once photos can be grouped into similarity clusters that render as visual blocks, there are genuinely **two different orderings** of the same photo set:

1. The **flat chronological array** (`photos`, sorted purely by `capturedAt`/`uploadIndex`) — the canonical data ordering the rest of the app (EXIF writing, list rendering when unclustered, etc.) relies on.
2. The **rendered visual order** — cluster blocks rendered as a unit at their earliest member's position, singleton runs interspersed — which only equals the flat order when every cluster happens to be array-contiguous and has no null-timestamp members skewing its anchor position.

dnd-kit's `over.id` in `onDragEnd` is resolved via actual DOM hit-testing against whatever is visually on screen — i.e., ordering (2). Any code that turns `over.id` into "the neighbors to average" is implicitly promising to reason in that same ordering. The old code broke that promise: `photos.findIndex((p) => p.id === over.id)` looked the id up correctly, but then used its position in ordering (1) to pick neighbors — a lookup into the wrong ordering that only coincidentally matched ordering (2) in the common case (no clusters, or array-contiguous clusters with no null timestamps). The fix's `visualOrder` array is the first ordering ever computed that is *provably* identical to what dnd-kit's hit-testing sees, because it's derived directly from the same `renderBlocks` structure the grid renders — so resolving `from`/`to` against it, and then computing neighbors from the post-`arrayMove` result on that same array, keeps every step of the computation inside ordering (2), matching what the user actually saw and dropped onto.

## Prevention

- **General rule**: whenever a rendered sequence can diverge from a canonical data array's order — via grouping, filtering, or any display-only reordering — any code deriving positional information from a user interaction (click, drop, drag) must resolve indices and neighbors against the *rendered* order, not the canonical array, unless it can be proven the two are always identical. "Proven identical" needs to account for every dimension display order can vary by, not just the one dimension a given change happens to touch (here: within-cluster member order was fixed by KTD3, but cross-block/cluster-vs-singleton interleaving — a different dimension of the same problem — was not).
- When a correctness argument depends on two orderings staying in sync (as KTD2 explicitly depended on KTD3), treat that as a standing invariant that needs its own dedicated test coverage proving the two orderings are identical in the specific cases where they're least likely to be — not just an inference chained from a nearby, narrower fix.
- **Reusable regression-test pattern for this bug class**: construct a fixture where the rendered/visual order and the canonical data-array order provably diverge (don't rely on it happening to differ — assert it explicitly, e.g. `expect(imgs).toEqual([...])` against the rendered DOM before triggering the interaction), perform the interaction, and assert two things: (a) the result matches what the *visual* order predicts, and (b) the result explicitly does **not** match what the old, buggy canonical-array-order computation would have produced. Asserting the negative case (b) is what turns the test into a true regression guard — without it, a future refactor could silently reintroduce the flat-array lookup and still pass a test that only checks the positive case, since a wrong-but-plausible-looking timestamp can still exist.
- **(session history)** This is not the first time this codebase has had a secondary ordering signal drift out of sync with the authoritative flat `photos` array — an earlier fix in `hooks/usePhotos.ts`'s `appendWithIndex` corrected a case where `uploadIndex` wasn't renumbered to a photo's current array position before appending, so a manual drag-reorder among undated photos could silently revert after a later upload. Both bugs are the same shape (a secondary positional signal — an index field, or a visually-reordered render list — getting out of sync with the array that's actually authoritative) recurring in two different features of the same app. Worth treating as a standing repo-level review question: "does this change introduce or touch a second representation of photo order, and if so, what keeps it in sync with `photos` itself?"

## Related Issues

- `docs/plans/2026-08-17-001-refactor-unify-timeline-cluster-views-plan.md` — the plan whose KTD2/KTD3 design decisions asserted the invariant this bug violates (see What Didn't Work above). Not yet merged to `main` as of this writing.
- `docs/solutions/logic-errors/cluster-view-delete-missing-object-url-release-and-selection-cleanup.md` — a different, unrelated-root-cause bug (a second delete surface bypassing a cleanup wrapper) in the same feature area and primary file (`components/PhotoUploadPage.tsx`). Related by module, not by mechanism.
- `docs/solutions/best-practices/exif-timestamp-rewriting-for-drag-reorder-persistence-2026-04-05.md` — documents the `slotTimestamp` midpoint/edge-offset algorithm this fix's `computeDroppedTimestamp` reuses in spirit. That doc currently describes `reorderPhotos`/`slotTimestamp` as the live drag-end code path; as of this fix, it no longer is (see the doc for the recommended refresh — `computeDroppedTimestamp` is now the mechanism exercised by real user drags in the unified grid).
- `docs/solutions/best-practices/image-as-selection-target-dnd-kit-pattern-2026-04-05.md` — establishes dnd-kit sensor/pointer conventions used by the same grid components; no overlap on ordering/index-resolution correctness, only shared library surface.
