---
title: "PhotoUploadPage ZIP-Download Failure Banner Was Unreachable After Deleting the Last Photo Mid-Build"
date: 2026-09-01
category: logic-errors
module: photo-upload
problem_type: logic_error
component: tooling
related_components:
  - photo-viewer
symptoms:
  - "Deleting the last remaining photo (or clicking Clear all) while a single-ZIP 'Download all' build was still in flight caused any subsequent build failure to produce no visible warning at all"
  - "The zipWarning banner and isGeneratingZip/zipDoneCount progress indicator were nested inside the pre-existing `{photos.length > 0 && (...)}` conditional that gated the whole photo grid + button row, so the entire block -- including the not-yet-rendered failure banner -- unmounted the instant photos.length reached 0"
  - "When the in-flight ZIP build's promise later rejected and called setZipWarning(...), there was no mounted DOM left to display it: a real error became a silent no-op, directly contradicting an explicit code comment (citing plan item KTD7) that the warning must always render, 'never an uncaught rejection or a silent no-op'"
  - "Found by an adversarial-reviewer persona in a parallel 8-persona ce-code-review pass on the feature branch before merge, not by manual testing or a user bug report -- specifically by attacking the combination of 'entry list snapshots once at click time' plus the deliberate prior design decision that rename/delete/reorder controls are NOT locked during a build"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags:
  - react
  - conditional-rendering
  - render-gate
  - state-lifecycle
  - silent-failure
  - zip-download
  - photo-upload
  - code-review
---

# ZIP-Build Warning Banner Silently Disappears When the Last Photo Is Deleted Mid-Build

## Problem

`PhotoUploadPage`'s "Download all" ZIP feature (`handleDownloadAll`, `components/PhotoUploadPage.tsx:369-384`) nested its progress indicator and failure banner inside a pre-existing `{photos.length > 0 && (...)}` conditional that was originally scoped only to "does the grid have anything to show." If the user deleted the last remaining photo — or clicked "Clear all" — while a ZIP build was still in flight, that wrapper unmounted at `photos.length === 0`, so a subsequent build failure had no mounted DOM left to report itself into.

## Symptoms

- A ZIP build started with photos present, then the user deleted the last photo (or clicked "Clear all") before the build settled.
- `buildPhotoZipBlob` later rejected (network error, corrupt EXIF write, etc.), and `handleDownloadAll`'s `catch` block called `setZipWarning("Couldn't build the ZIP — try again.")` exactly as designed.
- No error banner ever appeared on screen. The failure was swallowed from the user's point of view — a silent no-op — even though the code's own error-handling path had run and set state correctly. Only a `console.error('ZIP build failed', err)` line in devtools revealed anything had gone wrong.
- This directly contradicted the explicit design intent recorded in the `handleDownloadAll` doc comment (`components/PhotoUploadPage.tsx:361-368`), which cites "KTD7" and states a rejection must be surfaced "instead of an uncaught rejection or a silent no-op."

## What Didn't Work

There was no rejected alternative fix here — the bug was never caught in a first attempt. It shipped clean because of how it was introduced during implementation, and that path is worth naming explicitly:

When the ZIP feature was built, the new progress/warning state (`isGeneratingZip`, `zipDoneCount`, `zipTotal`, `zipWarning`, declared at `components/PhotoUploadPage.tsx:111-114`) needed a place to render. The button row it belongs next to ("Clear all" / "Download all") already lived inside the pre-existing `{photos.length > 0 && (...)}` block (originally added to gate the selection controls, upload panel, batch panel, and photo grid — none of which make sense with zero photos). Nesting the new UI inside that same wrapper was the path of least resistance: the JSX was already there, already indented one level in, and the button row visually belongs next to the grid it controls.

What made this wrong wasn't a coding mistake in the narrow sense — the `try/catch/finally` in `handleDownloadAll` is correct, `setZipWarning` is called correctly, the JSX renders `zipWarning` correctly when mounted. What didn't work was the implicit assumption that "the grid has photos to show" and "there is a pending async operation whose outcome still needs to be reported" are the same condition, or at least that the first always implies the second holds true for as long as it needs to. They don't: a build can outlive the very data set that seeded it, because two of this feature's own deliberate design decisions compound to make that possible — entries are snapshotted once at click time (`buildOrderedZipEntries`, called at the top of `handleDownloadAll`, comment at `components/PhotoUploadPage.tsx:361-368`, "KTD10"), and no other control (delete, Clear all) is locked while a build runs (same comment, `components/PhotoUploadPage.tsx:108-110`, also "KTD10"). Reusing the existing wrapper was invisible at review time because nothing about it looks broken in isolation — it only fails on the specific interleaving where the async operation's lifetime crosses the data-presence gate's transition to false, which single-persona review and normal manual testing (start a build, watch it finish) don't naturally hit.

It took an adversarial-reviewer persona, in a parallel multi-persona `ce-code-review` pass (8 reviewers — correctness, project-standards, testing, maintainability, learnings-researcher, performance, reliability, adversarial), deliberately attacking the combination of "snapshot at click time" and "other controls stay unlocked during a build," to surface this as a concrete, code-verifiable P1 finding quoting the KTD7 comment back against the code. No manual test run and no user bug report found it first.

## Solution

Fixed on branch `feat/zip-download-all`, commit `fix(review): keep ZIP warning reachable at zero photos, log build errors, close test gaps`, merged into `develop`.

**Before** — the progress indicator and warning banner were both nested inside the grid-visibility gate:

```tsx
{photos.length > 0 && (
  <>
    {/* selection controls, upload panel, batch panel, PhotoGrid/DndContext ... */}
  </>
)}

{/* button row containing isGeneratingZip progress text, Clear all,
    Download all, and the zipWarning banner — all still inside the
    photos.length > 0 gate above */}
```

**After** (`components/PhotoUploadPage.tsx:602-644`) — the grid-related block keeps its original `photos.length > 0` gate unchanged (`components/PhotoUploadPage.tsx:513`, closing `)}` at `components/PhotoUploadPage.tsx:600`), but the button row's gate is widened, and the warning banner is pulled out as a fully independent sibling that isn't gated on photo presence at all:

```tsx
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
    <button onClick={handleClearAll} disabled={isRestoring} /* ... */>
      Clear all
    </button>
    <button onClick={handleDownloadAll} disabled={isRestoring || isGeneratingZip} /* ... */>
      Download all
    </button>
  </div>
)}

{zipWarning && (
  <div className="bg-red-50 border border-red-200 text-red-800 dark:bg-red-900/20 dark:border-red-700 dark:text-red-300 rounded-lg px-3 py-2 text-sm mt-3 flex items-center justify-between gap-3">
    <span>{zipWarning}</span>
    <button onClick={() => setZipWarning(null)} className="text-xs underline shrink-0">
      Dismiss
    </button>
  </div>
)}
```

(`handleDownloadAll`'s control flow and its `catch` block's warning-setting logic, at `components/PhotoUploadPage.tsx:369-384`, were not changed by this fix — `setZipWarning` was already being called correctly, it just had nowhere to render into. The same commit did add a `console.error('ZIP build failed', err)` diagnostic line to that `catch` block, but that's an unrelated, incidental addition — not part of the render-gate fix itself.)

A new test, `describe('PhotoUploadPage — Download all (ZIP build, U2)', ...)` (`components/PhotoUploadPage.test.tsx:1982`), covers the regression directly: `it('P1: deleting the last remaining photo (Clear all) while a ZIP build is in flight still shows the warning banner once the build rejects, even though photos.length has dropped to 0', ...)` (`components/PhotoUploadPage.test.tsx:2257`). It starts a build with a single photo, clicks "Clear all" mid-build, then rejects the captured `buildPhotoZipBlob` promise and asserts the warning banner still renders with `photos.length === 0`.

## Why This Works

The fix treats "should this UI still be mounted" as the union of every reason it might need to be — data to show (`photos.length > 0`) OR an operation in flight that owns this UI (`isGeneratingZip`) OR unresolved output from that operation still waiting to be dismissed (`zipWarning`) — rather than conflating them into one condition. That union is exactly and only as broad as it needs to be: once `isGeneratingZip` goes false and `zipWarning` is null again (success, or the user dismissed the warning), the button row gate collapses back to plain `photos.length > 0` with no residual state keeping it artificially mounted.

Two alternative fixes were available and both would have been worse:

- **A separate always-mounted wrapper just for the ZIP UI.** This would work but duplicates the gating logic in a second place and invites the same bug again the next time someone adds another piece of async-outcome state near this UI — it treats the symptom (this one banner) rather than the actual shape of the problem (a presence-gate silently doubling as a lifecycle gate for unrelated async state).
- **Locking delete/Clear all while a build is running.** This was explicitly rejected as a design decision before this bug even existed — the "KTD10" comment at `components/PhotoUploadPage.tsx:108-110` states other controls are deliberately NOT locked during a build, and `handleDownloadAll`'s entry snapshot (`buildOrderedZipEntries`, called before any `await`) exists specifically so the in-flight build is immune to concurrent edits. Disabling delete to work around this bug would have quietly reversed that intentional UX decision (blocking a fast, unrelated action — deleting a photo — for the entire duration of an unrelated slow one) just to patch a rendering gap, and it wouldn't even fully fix the problem: `zipWarning` still needs to survive after `isGeneratingZip` goes false and the operation genuinely completes, which locking other controls during the build does nothing to address.

Widening the gate is strictly additive and local: it changes only when the button-row wrapper renders, doesn't touch `handleDownloadAll`'s control flow, doesn't touch what triggers a delete, and doesn't reintroduce any coupling between the grid's visibility and the ZIP feature's lifecycle beyond what's necessary for the banner to be reachable.

## Prevention

Whenever new UI state is added to *report the outcome of a pending or in-flight async operation*, and that UI is being placed inside an existing conditional block, treat the block's existing gate condition as untrustworthy for the new state until proven otherwise. Concretely:

1. **Identify what the existing gate actually means**, not what it happens to currently correlate with. `{photos.length > 0 && ...}` here meant "is there a grid to show," which is a data-presence check — it was never designed to mean "is there outstanding async work the user still needs to see the result of."
2. **Ask whether the new state's lifetime is bounded by the same thing the gate is bounded by.** `isGeneratingZip` and `zipWarning` are bounded by "when does this specific async call resolve/reject and get dismissed" — a lifetime with no necessary relationship to `photos.length`, especially once you allow (as this codebase deliberately does) other controls to mutate that count while the operation is still running.
3. **If the two lifetimes can diverge, don't nest — gate independently**, using an explicit union of "the normal reason this block exists" OR "the async operation this new state tracks is still unresolved." A `zipWarning` (or any dismissible error banner tied to an async result) is often best pulled out as its own top-level sibling entirely, gated only on its own `!= null` check, exactly as done here.
4. **Rule of thumb**: any time you're about to add `useState` for a not-yet-resolved async operation's progress or outcome, and the JSX you're about to drop it into sits inside `{someUnrelatedCondition && (...)}`, explicitly ask "does this new state need to outlive `someUnrelatedCondition` going false?" If the answer is yes — or even "maybe, under some interleaving" — widen the gate or hoist the new UI out, before writing a test, not after. Treat "can the data this gate checks disappear while my operation is still pending" as a mandatory question, not an edge case to circle back to.
5. **Test the interleaving, not just the two conditions independently.** A test that checks "build succeeds with photos present" and a test that checks "grid hides when photos.length is 0" can both pass while the combination — data goes to zero *during* the pending operation — is never exercised. When adding async-outcome UI, write at least one test that changes the surrounding gate's condition mid-flight, the way `components/PhotoUploadPage.test.tsx:2257` now does for this feature.

## Related

- [`stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md`](stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md) — the generation-token/async-guard pattern this doc's fix deliberately did *not* need. The ZIP feature's plan explicitly considered and rejected that pattern ("not adopted here since this is a single manually-triggered action, not concurrent-hook-invocation-prone"), since the bug that actually shipped was a render-gate/unmount issue, not a concurrent-invocation race.
- [`lightbox-stale-image-error-state-persists-across-photo-navigation.md`](lightbox-stale-image-error-state-persists-across-photo-navigation.md) — a different bug in the same component tree, also a React rendering/lifecycle assumption quietly breaking, also caught by `ce-code-review` rather than manual testing. Different mechanism (stale state surviving a non-remount vs. UI hidden by an unmet render-gate condition), same broader pattern of this codebase's review pipeline catching lifecycle assumptions manual testing doesn't naturally exercise.
