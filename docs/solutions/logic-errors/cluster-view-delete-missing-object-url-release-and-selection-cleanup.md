---
title: "ClusterView Delete Bypassed Object-URL Release and Selection Pruning Done by Timeline Delete"
date: 2026-08-16
category: logic-errors
module: photo-dedup
problem_type: logic_error
component: tooling
symptoms:
  - "Deleting photos through the cluster/dedup view left their blob: object URLs un-revoked, leaking memory for the rest of the session"
  - "A photo already selected in the timeline view could remain in selectedIds after being deleted via cluster view, leaving a stale/inflated selection that survived into later renders"
  - "ClusterView's delete action called the raw removePhotos mutator directly instead of the existing handleBatchDelete cleanup path the timeline view already used"
  - "Two independent code reviewers (adversarial and correctness) each caught only one of the two symptoms, with neither reviewer flagging both halves of the same root cause"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags: [photo-dedup, cluster-view, object-url-leak, stale-state, shared-mutator, code-review, react]
---

# ClusterView Delete Bypassed Object-URL Release and Selection Pruning Done by Timeline Delete

## Problem

`components/ClusterView.tsx`, a second delete-capable UI surface added alongside the existing timeline photo grid, was wired to `hooks/usePhotos.ts`'s raw `removePhotos(ids: string[])` mutator instead of the timeline view's own delete wrapper — so cluster-view deletes silently skipped the cleanup steps that mutator was never meant to perform alone.

## Symptoms

- Every photo deleted from cluster view leaked its `blob:` object URL: `hooks/useObjectUrls.ts`'s `releaseObjectUrl` (`hooks/useObjectUrls.ts:31-37`) was never called for cluster-view deletions, so the browser held that blob's backing memory for the rest of the page's lifetime — unlike an equivalent timeline-view delete, which did call it.
- If a user selected photo(s) in timeline view (populating `PhotoUploadPage`'s `selectedIds` state) and then deleted one of those same photos from cluster view, `selectedIds` still contained the deleted id after switching back to timeline view — inflating `BatchEditPanel`'s displayed `selectedIds.size` count and any batch action scoped to it with a reference to a photo that no longer existed.
- Found by two independently-run reviewer subagents in a multi-agent code review pass (an "adversarial" persona and a "correctness" persona), each flagging what looked like a different bug, before synthesis recognized both as symptoms of the same root cause.

## What Didn't Work

This was caught directly by code review rather than emerging from a failed debugging attempt, so there's no investigation dead-end to record. There was, however, a rejected alternative fix worth naming: adding a new `releaseObjectUrl` prop directly to `ClusterViewProps` and calling it from inside `ClusterView`'s own `handleDeleteSelected` (`components/ClusterView.tsx:408-417`).

That approach was rejected because it would have widened `ClusterView`'s prop surface and pushed knowledge of "what deleting a photo actually requires" (object-URL release + selection pruning) down into the consumer component — duplicating logic that `PhotoUploadPage` already owns and maintains for the timeline path (`handleBatchDelete`, `components/PhotoUploadPage.tsx:128-134`). The chosen fix instead wraps `removePhotos` at the call site in `PhotoUploadPage`, so `ClusterView` needed no prop-surface or logic changes at all — only its doc comment changed, since it still just calls whatever `removePhotos` function it's handed (`components/ClusterView.tsx:81-87`, `components/ClusterView.tsx:411`).

**(session history)** A near-miss is visible in the session that built this feature: the pattern this bug violates already existed in the same codebase, for the sibling delete path. An earlier code-review item on the (unrelated) Google Photos work had explicitly established the rule — "expose a release function from `useObjectUrls` and wire it into removal" — and `PhotoUploadPage.tsx`'s own `handleBatchDelete` was built to follow it. Later, while wiring `ClusterView` into `PhotoUploadPage` during a clustering-algorithm rewrite, the assistant building the feature explicitly re-verified the prop wiring and confirmed "Props match exactly (`photos`, `metrics`, `getObjectUrl`, `removePhotos`, `batchSetTimestamps`)" — a type-shape check that passed because `removePhotos` (the raw hook function) and `handleClusterDelete`-shaped wrapper have the identical `(ids: string[]) => void` signature. The check confirmed the prop was the right *type*; it could not have caught that it was the wrong *function*. No review pass between that point and the final code review — including a five-persona plan review — questioned whether the new delete path should reuse the existing release-and-prune wrapper.

## Solution

Before, `PhotoUploadPage.tsx` passed the raw hook function straight through:

```tsx
<ClusterView
  photos={photos}
  metrics={metrics}
  getObjectUrl={getObjectUrl}
  removePhotos={removePhotos}          // <-- raw hooks/usePhotos.ts mutator
  batchSetTimestamps={batchSetTimestamps}
/>
```

The fix adds a new wrapper, `handleClusterDelete`, that mirrors the two follow-up steps `handleBatchDelete` already performs for the timeline path, and passes that wrapper to `ClusterView` instead:

```ts
// components/PhotoUploadPage.tsx:136-159
function handleClusterDelete(ids: string[]) {
  const idSet = new Set(ids)
  for (const photo of photos) {
    if (idSet.has(photo.id)) releaseObjectUrl(photo.file)
  }
  removePhotos(ids)
  setSelectedIds((prev) => {
    if (prev.size === 0) return prev
    const next = new Set(prev)
    let changed = false
    for (const id of idSet) {
      if (next.delete(id)) changed = true
    }
    return changed ? next : prev
  })
}
```

```tsx
<ClusterView
  photos={photos}
  metrics={metrics}
  getObjectUrl={getObjectUrl}
  removePhotos={handleClusterDelete}   // components/PhotoUploadPage.tsx:329
  batchSetTimestamps={batchSetTimestamps}
/>
```

Confirmed against the underlying primitives: `releaseObjectUrl` (`hooks/useObjectUrls.ts:31-37`) revokes the file's cached blob URL and removes it from the internal `Map`, and `removePhotos` (`hooks/usePhotos.ts:142-145`) is a bare `setPhotos` filter with no side effects of its own — so without a wrapper, nothing in the cluster-view path would ever call `releaseObjectUrl` or touch `selectedIds`.

`ClusterView.tsx` itself required no logic changes — only its `removePhotos` prop doc comment was updated to state that the caller wraps the raw mutator with cleanup (`components/ClusterView.tsx:81-87`).

**Verification:** new tests in `components/PhotoUploadPage.test.tsx` (describe block `PhotoUploadPage — cluster-view delete cleanup`, lines 747-832) extend the existing `ClusterView` mock to capture its `removePhotos` prop (`components/PhotoUploadPage.test.tsx:35-42`), then invoke it directly: one test selects two photos in timeline view, switches to cluster view, invokes the captured wrapper with one of those ids, and asserts `releaseObjectUrl` was called exactly once with that photo's `file`, the real `removePhotos` was called exactly once with that id, and after switching back to timeline view the selection count reflects the prune (`1 photo selected`, not `2`); a second test asserts the wrapper is a no-op on `selectedIds` when nothing was selected beforehand. Full suite (332 tests / 25 files), `npm run lint`, and `npm run build` all passed. The fix is part of commit `f3572fc` ("fix(review): plug object-URL leak on cluster delete, stale selection, dendrogram rebuild storm, decode hangs, dead code") on `feat/photo-similarity-dedup`, confirmed present on `origin/feat/photo-similarity-dedup` as of this writing — that branch has not yet merged to `main`, and no PR is open for it, so this SHA may be superseded by a rebase/squash before merge; treat it as a locator into the feature branch's current history, not a permanent reference. Note that commit bundles several review-driven fixes together, not solely this one.

## Why This Works

The general shape of the bug: a single shared, side-effect-free state mutator (`removePhotos`) had accumulated required "escort" behavior (object-URL release, selection pruning) that lived entirely in one caller (`handleBatchDelete`) rather than in the mutator itself. When a second UI surface was added and handed the mutator directly, it inherited none of that escort behavior, because the escort behavior was never actually part of the mutator's contract — it was bolted onto one specific call site.

Wrapping at the call site in `PhotoUploadPage` (rather than inside `ClusterView`) fixes this structurally rather than patching the two observed symptoms individually, because `PhotoUploadPage` is where the data (`photos`), the object-URL cache (`getObjectUrl`/`releaseObjectUrl`), and the page-level `selectedIds` state all already live together. Centralizing "what a delete requires" in the same place that owns all three inputs means any future delete path wired up from that component gets correctness by simply being handed the right wrapper, rather than by every new component remembering to re-derive and re-implement the same two steps.

## Prevention

- **Review checklist / grep signal**: when a hook returns a raw setter or mutator (e.g. anything named `removeX`, `setX`, `deleteX` returned from a `useX()` hook) and it is passed as a prop to *more than one* component, treat that as a signal to check whether the *first* consumer's usage was ever wrapped with side effects the second consumer doesn't get. A quick way to find these: grep the hook's returned mutator name across all `.tsx` files under `components/` and confirm every call site either uses it raw consistently, or every non-raw usage is wrapped identically.
- **Type checks alone won't catch this class of bug (session history).** A prop-shape/type verification ("does the signature match?") passed for this exact bug, because the raw mutator and the correct wrapper share an identical `(ids: string[]) => void` type. When adding a new consumer of an existing hook mutator, explicitly check *which function reference* sibling consumers pass, not just that the type lines up.
- **Test pattern**: the regression coverage added here — mocking the second UI surface, capturing whatever mutator prop it's handed, invoking it directly, and asserting both the cleanup side effects and the underlying real mutator call — is a reasonable template for any future delete-capable (or otherwise side-effect-requiring) UI surface added to this app. See `components/PhotoUploadPage.test.tsx:35-42` (the capture) and the two tests at `components/PhotoUploadPage.test.tsx:779-831` (asserting object-URL release + `selectedIds` pruning, and the no-op case when nothing was pre-selected).
- **Structural alternative for future work (not implemented here)**: a single `useDeletePhotos()` hook that internally owns object-URL release, `selectedIds` pruning, and the underlying `removePhotos` call, returning one `deletePhotos(ids)` function for every UI surface to consume unchanged, would remove the need to remember to wrap at all — every consumer gets full correctness by construction rather than by convention. Worth considering if a third delete-capable surface is ever added.

## Related Issues

- `docs/residual-review-findings/2026-08-16-001-photo-similarity-dedup.md` — the prior structured code-review record for this same branch/feature. This bug is not among that review's applied or deferred findings: the current `ClusterView` delete wiring was introduced by a later rewrite ("radically simplify to pure grouping + manual delete", commit `a1a2f5f` on `feat/photo-similarity-dedup` as of this writing, not yet merged to `main`) than the one that review covered, so it wasn't yet present to catch.
- `docs/solutions/logic-errors/stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md` — a different root cause (concurrent async re-entrancy into one hook instance, fixed with a generation token), but the same broader shape: a new consumer of shared hook state introduced without auditing what the existing consumer already does around the same call.
