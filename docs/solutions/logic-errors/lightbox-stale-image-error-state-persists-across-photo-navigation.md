---
title: "PhotoLightbox Reused Stale imageFailed State Across Navigated Photos, Stuck on the Broken-Image Fallback for Every Subsequent Photo"
date: 2026-08-30
category: logic-errors
module: photo-viewer
problem_type: logic_error
component: tooling
related_components:
  - photo-upload
symptoms:
  - "Once any single photo in a lightbox session failed to load, every subsequently-navigated-to photo showed the 'Unable to load this image.' fallback instead of rendering, even photos that loaded fine"
  - "PhotoUploadPage.tsx renders <PhotoLightbox> without a key prop, so the same component instance (and its local imageFailed state) persists across zoomedPhotoId navigation instead of remounting"
  - "imageFailed, set true by the <img> onError handler, was never reset when the displayed photo (objectUrl) changed"
  - "Caught by an automated ce-code-review pass on the PR that introduced navigation, not by manual testing or a user bug report"
root_cause: logic_error
resolution_type: code_fix
severity: medium
tags:
  - react
  - react-hooks
  - state-management
  - stale-state
  - persisted-component-instance
  - adjust-state-during-render
  - useeffect-avoidance
  - photo-lightbox
  - code-review
---

# Stale `imageFailed` State Survives Navigation in the Non-Remounting Lightbox

## Problem

`components/PhotoLightbox.tsx` was extended to support in-place navigation between photos (left/right arrow keys, click-through prev/next controls) without closing and reopening the lightbox. To make that navigation feel seamless — no flash, no lost focus-trap state — the same `PhotoLightbox` component instance is now kept mounted across a `zoomedPhotoId` change in `components/PhotoUploadPage.tsx`; nothing forces a remount between photos (no `key` prop keyed to the photo id).

That's a deliberate, reasonable design choice on its own. But the component also holds local state that implicitly means "something about the *currently displayed* photo": `const [imageFailed, setImageFailed] = useState(false)`, flipped to `true` by the `<img>` element's `onError` handler (`components/PhotoLightbox.tsx:299`) when a photo's blob URL fails to decode or load, and used to swap the `<img>` for an "Unable to load this image." fallback (`components/PhotoLightbox.tsx:286-292`). Nothing reset that state when the underlying photo changed, because before navigation existed, "the underlying photo changes while the component instance survives" was never a case that could happen — every previous photo view was a fresh mount, so `imageFailed` starting at `false` was implicitly correct by construction, not by any explicit reset logic. Navigation broke that hidden invariant without touching the line that reads `imageFailed` at all.

This was caught by an automated `ce-code-review` pass over the same change that added navigation on the `develop` branch — not by manual testing or a user report. It's a good example of review catching a bug that a correct, structural decision elsewhere (making the component persist across prop changes) silently introduced in a completely different part of the component.

## Symptoms

- After any single photo failed to load in the lightbox (broken blob URL, decode failure, etc.), every subsequent photo viewed in that same session — including perfectly valid, loadable photos — showed the "Unable to load this image." fallback instead of the actual image.
- The bug was sticky for the rest of the viewing session: closing and reopening the lightbox on a *different* photo (a fresh mount) cleared it, but navigating prev/next from within an already-open lightbox never did.
- No console error, no failed network/blob request for the subsequent photos — the images were fine; the component simply never gave them a chance to render.

## What Didn't Work

The first fix attempt reset `imageFailed` from inside a `useEffect` keyed on `objectUrl`:

```tsx
// Attempt 1 — functionally correct, but adds lint debt
useEffect(() => {
  setImageFailed(false)
}, [objectUrl])
```

This worked — the fallback did clear when navigating to a new photo. But it tripped this repo's `react-hooks/set-state-in-effect` ESLint rule ("Calling setState synchronously within an effect can trigger cascading renders"), and would have been a *third* instance of that exact lint violation in the codebase. Two pre-existing, unaddressed instances of the same pattern — a `useEffect` that syncs a local draft value back to an external prop, guarded by an "am I currently editing" flag — already exist:

- `components/PhotoCard.tsx:96-98` — syncs the draft `nameValue` back to the external `filename` prop whenever `filename` changes and the user isn't mid-edit of the name:
  ```tsx
  // Keep draft values in sync with external prop changes (e.g. batch operations)
  useEffect(() => {
    if (!isEditingName) setNameValue(filename)
  }, [filename, isEditingName])
  ```
- `hooks/useTimestampEdit.ts:41-43` — the same shape, extracted out of `PhotoCard` so `PhotoLightbox` could reuse it, this time syncing the draft `tsValue` back to the external `capturedAt` prop while not editing:
  ```tsx
  useEffect(() => {
    if (!isEditing) setTsValue(capturedAt ? toDatetimeLocal(capturedAt) : '')
  }, [capturedAt, isEditing])
  ```

Rather than adding a third occurrence of a lint pattern that's already unaddressed twice, the fix was reshaped to avoid the effect entirely.

## Solution

The reset now happens during render, comparing the incoming `objectUrl` prop against a tracked previous value, following React's documented "adjust state during render" pattern rather than `useEffect` (`components/PhotoLightbox.tsx:104-117`):

```tsx
const [imageFailed, setImageFailed] = useState(false)
// Reset the failed-to-load flag when navigating to a different photo --
// this component instance persists across a `zoomedPhotoId` change (no
// `key` prop forces a remount), so without this a broken image on one
// photo would leave every subsequent, perfectly-loadable photo stuck
// behind the "Unable to load this image." fallback. Adjusted during
// render (React's documented pattern for resetting state on a prop
// change) rather than in a useEffect, since useEffect for a same-render
// reset trips this repo's react-hooks/set-state-in-effect lint rule.
const [prevObjectUrl, setPrevObjectUrl] = useState(objectUrl)
if (objectUrl !== prevObjectUrl) {
  setPrevObjectUrl(objectUrl)
  setImageFailed(false)
}
```

`setState` calls made directly in the render body during a render where the compared values differ are a documented, supported React pattern (React bails out of continuing that render pass with stale values and re-renders immediately with the updated state, before commit/paint) — see https://react.dev/learn/you-might-not-need-an-effect, "Adjusting some state when a prop changes."

## Why This Works

- **Correct scope, correct timing.** `imageFailed` is conceptually scoped to "the current photo," and the fix ties its reset directly to the one signal that means "the current photo changed" (`objectUrl`, which is per-photo and changes on every navigation). The reset now happens in the *same* render/commit as the prop change, not one render later via an effect — so there is no intermediate frame where the fallback is briefly shown (or hidden) for the wrong photo.
- **No new lint debt.** The pattern isn't inside a `useEffect` at all, so `react-hooks/set-state-in-effect` doesn't apply to it — it neither fixes nor worsens the two pre-existing violations, but it avoids planting a third instance of the same debt while fixing an unrelated bug.
- **Doesn't fight the navigation design.** The fix works entirely within the "component instance persists across photos" model instead of undermining it (e.g. by forcing a `key`-based remount, which would have silently regressed the focus-trap and smooth-navigation behavior the feature was built for).

## Prevention

The general lesson: **any local state that implicitly represents "something about the current item" is a latent bug the moment its owning component can persist, unmounted-free, across an item change** — not just for image-load flags, but for any per-item local `useState`. The implicit correctness that comes from "every item gets a fresh mount" silently disappears once a parent stops keying/remounting the component, and nothing about the local state declaration itself signals that its scoping assumption just broke.

Checklist to apply when building or reviewing a component that can persist across a changing "current item" prop (no `key` forcing remount):

1. **List every local `useState`/`useRef` in the component.** For each one, ask: "does this value only make sense in the context of the current item, or is it genuinely instance-level (spans items on purpose, e.g. focus-trap bookkeeping, previously-focused-element)?" Flag every "current item" one.
2. **For each flagged piece of state, identify the one prop/value that uniquely identifies the current item** (an id, a URL, a key — not something derived or debounced) and make sure a reset is tied to *that* value changing, not to some proxy for it.
3. **Prefer resetting during render over `useEffect`** when the reset must be visible in the same paint as the item change (React's "adjust state during render" pattern: track a `prev<Value>` state, compare against the incoming prop at the top of the render body, `setState` conditionally if they differ). Reach for `useEffect` only when the reset genuinely needs to run after commit (e.g. it depends on the DOM, or on an external subscription) — and check the repo's lint config first, since a same-render reset inside an effect is exactly what `react-hooks/set-state-in-effect` flags.
4. **Search the codebase for the same shape before adding a new `useEffect`-based sync.** If you find yourself writing `useEffect(() => { setX(deriveFromProp(prop)) }, [prop, ...])`, grep for existing instances of that pattern first (as this fix should have, and as this doc now records for `PhotoCard.tsx:96-98` and `useTimestampEdit.ts:41-43`) — a third copy of a known-flagged pattern is a cue to either fix all three or switch shape, not to add debt quietly.
5. **When a component moves from "always remounts on item change" to "can persist across item change"** (as `PhotoLightbox` did when navigation was added), treat that as a scoping-invalidation event: re-run step 1 against the component's existing state, not just the state touched by the new feature's diff. The bug here shipped because navigation touched routing/focus/keyboard code, and nothing about that diff mentioned `imageFailed` — the audit has to be state-first, not diff-first.

## Related

- [`cluster-view-delete-missing-object-url-release-and-selection-cleanup.md`](cluster-view-delete-missing-object-url-release-and-selection-cleanup.md) — a different bug in the same general area (object-URL lifecycle around cluster/lightbox delete), unrelated root cause, but useful adjacent context if working on `PhotoLightbox.tsx` or its object-URL handling.
