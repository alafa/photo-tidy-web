---
title: "PhotoUploadPage 'Keep Best' Comparison Could Strand the Button on Decode Errors and Act on a Stale Selection Snapshot"
date: 2026-09-05
category: logic-errors
module: photo-upload
problem_type: logic_error
component: tooling
symptoms:
  - "The 'Keep best' button (isComparingBest) had no way to recover if getPhotoDimensions ever violated its documented never-throws contract during the async decode phase: unlike the established handleDownloadAll/ZIP pattern it was modeled after (try/catch/finally, PhotoUploadPage.tsx:604-619), handleKeepBest's decode step had no try/catch at all, so a thrown rejection would leave isComparingBest/comparingAnchorId stuck true forever with no user-facing recovery"
  - "Deselecting and reselecting photos during the multi-second, batched (KEEP_BEST_DECODE_CONCURRENCY = 5) decode window let a stale click-time selection snapshot survive re-validation: the post-decode check only confirmed the originally-selected photo ids still existed (had not been deleted), not that they were still the currently selected set, so window.confirm could fire and delete losers from a selection the user had already changed"
  - "The 'Comparing…' indicator/button could disappear mid-decode if the live selection count dropped below 2 during the async gap, so window.confirm() could appear to the user with no visible lead-in explaining what was being compared"
root_cause: async_timing
resolution_type: code_fix
severity: high
tags: [keep-best, react, async-timing, race-condition, stale-selection, error-handling, photo-upload, code-review]
---

# PhotoUploadPage 'Keep Best' Comparison Could Strand the Button on Decode Errors and Act on a Stale Selection Snapshot

## Problem

`handleKeepBest` in `components/PhotoUploadPage.tsx` (currently lines 533-594) snapshots the selected photo ids at click time, decodes their pixel dimensions asynchronously (`decodeDimensionsWithConcurrency`, lines 82-101, batched at `KEEP_BEST_DECODE_CONCURRENCY = 5`, line 72), then picks a winner and deletes the losers. In the pre-fix version, the decode-to-confirm flow had no try/catch, and its only post-decode re-validation checked that each click-time id still *existed* in `photosByIdRef` — it never checked that the click-time selection was still the *same* selection.

## Symptoms

- If `getPhotoDimensions` ever rejected (violating its documented "never throws" contract), the rejection was uncaught: `isComparingBest` stayed `true` forever, the "Keep best" button stayed disabled, and there was no error message or way to retry — a permanently stuck control.
- If a user deselected one selected photo and selected a different one during the multi-second decode window, both photos still existed in `photosByIdRef`, so the existence check passed. `window.confirm` would then fire naming the stale, click-time pair, and confirming it would delete photos the user no longer had selected — the dialog and deletion acted on the wrong photos relative to what was currently highlighted on screen.

## What Didn't Work

This wasn't a multi-attempt debugging saga — a `ce-code-review` pass (reliability and adversarial personas, independently) caught both gaps on 2026-09-05, before the code shipped anywhere.

The original implementation already had a real, working piece of async-staleness handling: `decodeDimensionsWithConcurrency`'s doc comment (lines 74-81) explains that `getFile` is called fresh per id at the moment its batch actually runs, so a photo deleted mid-decode "simply yields no entry for that id rather than throwing." The pre-fix `handleKeepBest` then filtered `ids` down to `validIds` that still existed in the live `photosByIdRef` and bailed with `'Selection changed — try again.'` if fewer than two remained. That's a genuine, correctly-reasoned defense against one specific async race (deletion mid-decode), and it's easy to see how implementing it created the impression that "the async re-validation problem" was fully handled — the code even had a bail-out message with the right wording already in place.

The gap is that existence is a strictly weaker check than selection-equality. "Both ids are still in the photo map" says nothing about whether the user still has those exact two (and only those two) photos selected right now. Deselect-and-reselect is a case where nothing gets deleted, so the existence check is fully satisfied while the live selection has already diverged from the snapshot — a case the existence-only re-check structurally cannot see, no matter how carefully it's written. There was no failed attempt to fix this and revert; the review caught it before the narrower check was ever exercised in production.

## Solution

Fixed in commit `315f08e` ("fix(review): harden Keep best against selection races and decode errors") on branch `feat/keep-best-photo-selection`, unmerged as of this writing — no PR has been opened yet for this branch, so there is no PR number to cite in its place; this SHA is local-only and may be rewritten if the branch is later rebased or squash-merged. Prefer diffing `feat/keep-best-photo-selection` against `develop` over trusting this SHA to still resolve once the branch lands.

**1. A second live ref, mirroring the full selection every render**, added alongside the existing `photosByIdRef` (current source, `components/PhotoUploadPage.tsx:230-235`):

```tsx
// Same live-read purpose as `photosByIdRef` above, for `selectedIds`:
// `handleKeepBest` needs to detect not just a deleted photo but any
// selection change (deselect, reselect, clear) during its decode phase,
// by comparing its click-time snapshot against the CURRENT selection.
const selectedIdsRef = useRef(selectedIds)
selectedIdsRef.current = selectedIds
```

**2. Existence-check replaced with exact-equality-check**, and the whole flow wrapped in try/catch/finally (current source, `components/PhotoUploadPage.tsx:533-594`). Before (per `git show 315f08e`):

```tsx
const dimensionsById = await decodeDimensionsWithConcurrency(...)

const validIds = ids.filter((id) => photosByIdRef.current.has(id))
if (validIds.length < 2) {
  setIsComparingBest(false)
  setKeepBestResult('Selection changed — try again.')
  return
}
// ... build candidates from validIds, confirm, delete — no try/catch
```

After:

```tsx
try {
  const dimensionsById = await decodeDimensionsWithConcurrency(...)

  const selectionUnchanged =
    ids.length === selectedIdsRef.current.size &&
    ids.every((id) => selectedIdsRef.current.has(id))
  if (!selectionUnchanged) {
    setKeepBestResult('Selection changed — try again.')
    return
  }
  // ... build candidates from ids, confirm, delete
} catch (err) {
  console.error('Keep best comparison failed', err)
  setKeepBestResult("Couldn't compare photos — try again.")
} finally {
  setIsComparingBest(false)
  setComparingAnchorId(null)
}
```

`ids.length === selectedIdsRef.current.size && ids.every(...)` is a full-equality check (same cardinality, same members), not membership-only — so a deselect-then-reselect, a plain deselect, or a "Clear selection" mid-decode all now abort the same way an outright deletion already did.

The commit also kept the button and "Comparing…" indicator visible for the whole in-flight comparison even if `selectedIds.size` drops below 2 (`(selectedIds.size >= 2 || isComparingBest)` gating the control, plus a frozen `comparingAnchorId` for which card it renders on), so `window.confirm` never appears with no visible lead-in — a UI-continuity fix bundled into the same commit, not a separate bug.

## Why This Works

Two general principles, both visible directly in the diff:

1. **Re-validating an async operation's snapshot against live state must check the specific invariant that matters, not a weaker proxy for it.** "Do the referenced things still exist" and "is this still the exact same set the user asked me to act on" are different questions, and existence is necessary but not sufficient for selection-equality. Whenever code takes an early snapshot before an async gap and later re-checks it against live state before acting on it, the check has to match the granularity of what "the user changed their mind" actually means for that flow — here, exact set equality (`size` match plus full membership), not just "nothing referenced was deleted."

2. **An async multi-step user action that flips a busy/loading boolean before starting must guarantee that flag resets via `finally`, not only on the happy-path returns.** The fix explicitly mirrors the sibling ZIP-download feature's shape: `handleDownloadAll` (`components/PhotoUploadPage.tsx:604-619`) already wraps its async build in `try { ... } catch (err) { console.error(...); setZipWarning(...) } finally { setIsGeneratingZip(false) }`. `handleKeepBest` didn't have that shape before `315f08e` even though it was "modeled after" `handleDownloadAll` per its own doc comment — the try/catch/finally scaffolding was the one piece that hadn't been carried over. Putting `setIsComparingBest(false)` (and here also `setComparingAnchorId(null)`) in `finally` means a stuck-forever disabled button is structurally impossible regardless of how the async body exits.

## Prevention

- When an async user action re-validates a click-time snapshot before acting on it, check exact equality against the live state (`size` match + full membership, or the domain-specific equivalent), not just "the referenced items still exist." Existence checks alone don't catch a user changing their selection to a different-but-still-valid set during the async gap.
- Any async handler that sets a busy/loading boolean to `true` before starting an async operation must reset it in a `finally` block, not only on the success and early-return paths — otherwise an unexpected rejection strands the UI in a permanently-disabled state with no recovery.
- This codebase's established pattern for the first point is the live-ref idiom already in use: a `useRef` whose `.current` is reassigned directly during render (not inside a `useEffect`, which would lag a tick behind), read from inside an async callback to get the true current state instead of a stale closure. `photosByIdRef` (`components/PhotoUploadPage.tsx:227-228`) is the original instance this pattern was drawn from, and `selectedIdsRef` (`components/PhotoUploadPage.tsx:234-235`) is the new one added in this fix. `hooks/useGooglePhotosUpload.ts`'s `removedPhotoIdsRef` (line 128) is a related but not identical instance of "read a ref from inside an async callback to check live state" — it is NOT a full-snapshot mirror like the other two; it's an additive `Set` that only ever grows and is checked with `.has()` guards, so don't assume every ref in this codebase is safe to treat as "the current full state" without checking how it's populated first.
- For the second point, `handleDownloadAll` (`components/PhotoUploadPage.tsx:604-619`) is the established try/catch/finally template for "async multi-step action gated behind a busy boolean" — new handlers with this shape should be checked against it directly rather than reinvented.

## Related Issues

- [`zip-download-warning-banner-unmounted-by-photo-count-render-gate.md`](../logic-errors/zip-download-warning-banner-unmounted-by-photo-count-render-gate.md) — the sibling `handleDownloadAll`/ZIP handler this fix's try/catch/finally hardening was explicitly modeled after. Different specific defect (render-gate/unmount vs. missing error handling + stale re-validation), same file and same "harden the async handler to match an established convention" solution shape.
- [`stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md`](../logic-errors/stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md) — source of the live-ref/read-after-await idiom (`photosByIdRef`/`selectedIdsRef` mirroring live state) reused here. That doc's staleness is caused by a second concurrent invocation of the same hook mutating a shared ref; this bug's staleness is caused by ordinary UI interaction (deselect/reselect) during a single in-flight call — a different trigger for the same general "state read after an await no longer reflects what was true before the await" hazard.
