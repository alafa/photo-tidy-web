---
title: "Concurrent Ref Mutation Orphaned Uploaded Photos and Resurrected Cancelled Picker Imports"
date: 2026-08-11
category: logic-errors
module: google-photos
problem_type: logic_error
component: tooling
related_components:
  - google-photos-upload
  - google-photos-picker
symptoms:
  - "Uploading photos to Google Photos while adding more local files mid-upload silently created the media items outside any album — no error, no warning, upload appeared to succeed"
  - "retryFailed() could commit retried photos with no albumId if a reset() happened after the retry started but before its own upload loop finished"
  - "Cancelling a Google Photos picker import and immediately starting a new one could let the cancelled import's poll loop keep running, clobber the new import's session/status state, or call addPhotos() with photos from the session the user explicitly cancelled"
  - "cancelImport() set a shared cancelledRef boolean to true, but a subsequent startImport() call reset that same shared ref to false, un-cancelling the old, supposedly-dead loop iteration"
root_cause: async_timing
resolution_type: code_fix
severity: high
tags:
  - google-photos
  - react-hooks
  - useref
  - race-condition
  - async-timing
  - concurrent-invocation
  - generation-token
  - stale-closure
---

# Concurrent Ref Mutation Orphaned Uploaded Photos and Resurrected Cancelled Picker Imports

## Problem

Two `useRef`-backed async React hooks managing Google Photos operations (`hooks/useGooglePhotosUpload.ts`, `hooks/useGooglePhotosPicker.ts`) read a shared ref *after* an `await`, at a point where a different, concurrent invocation of the same hook instance could have already mutated that ref out from under them. In the upload hook this silently dumped uploaded photos outside any Google Photos album (into the user's main library) with no error shown; in the picker hook it could let a cancelled import keep running and deliver photos the user had explicitly rejected.

## Symptoms

- Adding more local files mid-upload (which unconditionally calls `reset()`) could cause the in-flight upload's `batchCreate` call to omit `albumId`, so Google created the media items successfully but not inside the album the user named — no error surfaced anywhere.
- The same exposure existed independently in `retryFailed()`, which reads the album id from the ref at a different point in its own lifecycle.
- Cancelling a Google Photos picker import and starting a new one before the old import's poll loop's pending timer elapsed could let the old loop resume, believe itself still "current" (because the new call had reset the shared cancellation flag), and mutate `sessionIdRef` / status / `triggerImmediatePollRef` state that the new import now owned — or even complete and call `addPhotos()` with the cancelled session's photos.

## What Didn't Work

These are the tempting-but-incomplete fixes an engineer might reach for instead of the actual one:

- **"Just don't call `reset()` (or disable the file input) while an upload is in flight."** This only patches one caller (`components/PhotoUploadPage.tsx`'s `handleChange`/`handleDrop`, at `PhotoUploadPage.tsx:61` and `PhotoUploadPage.tsx:76`) and leaves `retryFailed`'s independent read-after-await of `albumIdRef.current` exposed to the exact same hazard from any other future caller of `reset()`. It treats the symptom's trigger as the bug, not the read-timing race itself.
- **"Make `albumIdRef` a `useState` instead of a `useRef`."** Changing the storage primitive doesn't change *when* the value is read relative to concurrent writes. A `state` value captured via closure at render time is arguably *more* stale, not less; the actual defect is re-reading a shared, externally-mutable location after an `await` that a concurrent call could have run through, not which React API backs that location.
- **For the picker hook: "clear `abortControllerRef` more aggressively in `cancelImport()`."** `abortControllerRef` and the boolean `cancelledRef` were separate problems — aborting the fetch's `AbortSignal` doesn't resolve the poll loop's own `waitWithImmediateOption` promise, which is a bespoke `setTimeout` with no `AbortSignal` wiring at all. The loop wakes up regardless of the controller's abort state.
- **For the picker hook: "keep the shared boolean, but have `cancelImport()` set it and never let anything set it back to `false`."** This is close in spirit to the real fix but wrong in shape: `startImport()` legitimately needs to reset cancellation state for *its own* run, and a single shared boolean can't distinguish "still cancelled from the old run" from "freshly started, not cancelled, for the new run" — whichever call writes last wins, regardless of which one is semantically current. A monotonically increasing generation counter, compared by value rather than by a shared true/false flag, is what actually resolves the ambiguity.

## Solution

**Bug 1 — capture `albumId` into a local before the upload loop's `await`s, in both `startUpload` and `retryFailed` (`hooks/useGooglePhotosUpload.ts`):**

`startUpload` resets the ref during its own setup (`hooks/useGooglePhotosUpload.ts:230`, `albumIdRef.current = undefined`) and `reset()` resets it independently (`hooks/useGooglePhotosUpload.ts:319`) whenever the file-input/drop handlers in `components/PhotoUploadPage.tsx` fire. After album creation succeeds, `startUpload` now captures the id once, locally, before the long-running upload loop:

```ts
// hooks/useGooglePhotosUpload.ts:254-266
// Capture the album id for this call locally — albumIdRef.current can
// be cleared by a concurrent reset() (e.g. the user adding more local
// files while this upload is still running), and re-reading the ref
// after the upload loop would then submit batchCreate with no album,
// silently orphaning these photos outside any album.
const albumId = albumIdRef.current

const tokens = await uploadWithConcurrency(photos, accessToken, uploadSinglePhoto)

// Batch create
if (tokens.length > 0) {
  try {
    await batchCreate(tokens, albumId, accessToken)
```

`retryFailed` applies the identical pattern, capturing the album id — set by a *previous* `startUpload` call and still sitting in the ref — before its own upload loop runs:

```ts
// hooks/useGooglePhotosUpload.ts:293-304
// Capture locally for the same reason as startUpload — a concurrent
// reset() must not be able to null out the album this retry commits to.
const albumId = albumIdRef.current

// Re-upload failed photos
const newTokens = await uploadWithConcurrency(failedPhotos, accessToken, uploadSinglePhoto)

// Only batch-create the newly retried tokens — previously successful tokens
// were already committed in the initial startUpload call
if (newTokens.length > 0) {
  try {
    await batchCreate(newTokens, albumId, accessToken)
```

In both cases `batchCreate(..., albumId, ...)` now passes the local variable, not `albumIdRef.current`. The ref's reset sites (`useGooglePhotosUpload.ts:230` and `useGooglePhotosUpload.ts:319`) are untouched — only the *read* moved to happen once, early, before any `await`.

**Bug 2 — replace the shared `cancelledRef` boolean with a per-invocation generation token, and pull `AbortController` out of the shared ref (`hooks/useGooglePhotosPicker.ts`):**

```ts
// hooks/useGooglePhotosPicker.ts:104-110
const sessionIdRef = useRef<string | null>(null)
const abortControllerRef = useRef<AbortController | null>(null)
// Identifies which startImport() call is still "current". cancelImport()
// and a fresh startImport() both bump this — a suspended older call can
// then tell it no longer owns the shared refs/state instead of resuming
// as if it were still active.
const importGenerationRef = useRef(0)
```

`cancelImport()` invalidates the current generation by incrementing, instead of flipping a boolean that a later call could reset back:

```ts
// hooks/useGooglePhotosPicker.ts:130-139
const cancelImport = useCallback(() => {
  importGenerationRef.current += 1
  abortControllerRef.current?.abort()
  if (sessionIdRef.current) {
    cleanupSession(sessionIdRef.current)
    sessionIdRef.current = null
  }
  setStatus('idle')
  setError(null)
}, [cleanupSession])
```

`startImport()` claims its own generation number and its own `AbortController` locally, up front:

```ts
// hooks/useGooglePhotosPicker.ts:141-147
const startImport = useCallback(async () => {
  if (!accessToken || status !== 'idle') return

  const myGeneration = ++importGenerationRef.current
  const isCurrent = () => importGenerationRef.current === myGeneration
  const controller = new AbortController()
  abortControllerRef.current = controller
```

Every branch that used to check `!cancelledRef.current` now checks `isCurrent()`, including inside the poll loop itself:

```ts
// hooks/useGooglePhotosPicker.ts:220-225
let mediaItemsSet = false
while (isCurrent()) {
  await waitWithImmediateOption(pollIntervalMs)

  if (!isCurrent()) break
```

Because `myGeneration` and `controller` are locals captured once per call, a later `startImport()` incrementing `importGenerationRef.current` again can never make an older call's `isCurrent()` re-evaluate to `true` — unlike the old shared boolean, which a fresh call legitimately needed to reset to `false`, thereby also un-cancelling any still-suspended older call.

## Why This Works

Both bugs are the same shape: an async function reads a value from a `useRef` that is shared across *every* invocation of the same hook instance, and it does that read *after* an `await` — a point where a different, concurrent invocation (a `reset()`, a `cancelImport()`, a fresh `startImport()`/`startUpload()` call) has had a chance to run and mutate that same ref. By the time execution resumes, the ref no longer necessarily reflects "this call's" data; it reflects whichever call wrote to it most recently, which may be a completely different invocation.

The fix in both hooks is to capture what's needed into a **local variable (or local closure) before the first `await` of that invocation**, and use only that local for the rest of the call's lifetime:

- In `useGooglePhotosUpload.ts`, the *value* needed (the album id) is captured once (`const albumId = albumIdRef.current`) right after it's produced and before the upload loop's `await`s. A local variable is a stack/closure binding private to that specific call — no other invocation of `startUpload`/`retryFailed`/`reset` has a reference to it and so cannot mutate it. Re-reading the ref later reintroduces the hazard exactly because the ref is the one thing every concurrent call can see and write.
- In `useGooglePhotosPicker.ts`, what's needed isn't a fixed value but an *identity check* — "am I, this specific call, still the one that should be driving the UI?" A shared boolean can't encode identity, only a single global on/off state that any call can flip either way. A **generation token** (`const myGeneration = ++importGenerationRef.current`, tested via `isCurrent()`) gives each call a unique, immutable-to-it number to compare against a ref that only ever moves forward. `cancelImport()` and a fresh `startImport()` both advance the counter, but neither can make an old call's captured `myGeneration` match a newer value — invalidation is monotonic and one-directional, which a mutable boolean is not.

Same underlying principle either way: never let "am I still valid" or "what value should I use" for a specific call be answered by re-reading shared mutable state after that call has already yielded control (via `await`) to code that can change the answer.

## Prevention

**Rule of thumb:** any `useRef` read that happens *after* an `await` inside an async callback, where the same ref is also *written* by a different callback/handler that's reachable while the first callback is still in flight (a cancel button, a reset handler, a re-invocation of the same hook function), is a candidate for this bug.

- If the ref holds a **value** needed later in the same call, capture it into a local variable before the first `await`, and use the local for the rest of that call — never re-read the ref for that purpose again in the same invocation.
- If the ref is being used to answer **"is this call still the active/current one"**, and the same call also needs to tell "a stale run of myself" apart from "a fresh run with new data" (not just true/false), use a generation-token comparison (`useRef(0)`, incremented by every invalidating action, compared against a value captured at the start of the call) instead of a shared boolean or nullable flag. A boolean can be reset back to its "valid" state by an unrelated later call; a monotonically increasing counter compared by exact-value equality cannot.

Generic pattern, independent of Google Photos:

```ts
// Hazard: sharedRef can be mutated by a concurrent call to cancel()/reset()
// while doSomething() is still awaiting, and the re-read below picks up
// whichever value is there *now*, not the one that was true at call time.
async function doSomething() {
  await longRunningStep()
  useTheRef(sharedRef.current) // BUG: may belong to a different, later call
}

// Fix: capture before the await, use the local for the rest of this call.
async function doSomething() {
  const captured = sharedRef.current
  await longRunningStep()
  useTheRef(captured) // immune to concurrent mutation of sharedRef
}

// When the question is "am I still current" rather than "what's the value":
const generationRef = useRef(0)
function cancel() { generationRef.current += 1 }
async function start() {
  const myGeneration = ++generationRef.current
  const isCurrent = () => generationRef.current === myGeneration
  await longRunningStep()
  if (!isCurrent()) return // a cancel() or a newer start() ran meanwhile
}
```

**Review-process note:** bug 2's exact hazard (`cancelledRef`/`abortControllerRef` read after an `await`, corrupted by a concurrent call) was flagged once before, as a residual, deferred finding in `.context/compound-engineering/ce-review/2026-08-09-001/run.md` ("cancellation timing between `await parseErrorBody(res)` and the `cancelledRef.current` check — pre-existing pattern, not introduced by this diff") — and only fixed later, by the review-fix commit on `fix/google-photos-sync` that both bugs in this doc were found in and fixed by (unmerged into `main` as of this writing). Both bugs were found in that same commit's code-review pass precisely because they share this pattern: once one instance of "shared ref read after await, mutable by a concurrent call" is spotted, grep the rest of the same hook (and sibling hooks with the same shape) for every other `.current` read that follows an `await`, rather than deferring the finding as "pre-existing" again.

## Related Issues

- `docs/solutions/integration-issues/google-photos-json-parse-failure-returns-200.md` — same module and overlapping files (`hooks/useGooglePhotosPicker.ts`, `app/api/google-photos/*`), but a different defect shape: that doc is about a same-call control-flow hazard (`.catch(() => fallback)` laundering a JSON-parse failure into success-shaped data), not a cross-call timing race. The same review-fix commit that fixes this doc's two bugs also propagated that doc's try/catch pattern to `albums`, `batch-create`, `upload`, and the auth-token routes, so the two docs cover adjacent hazards in the same integration surface without sharing a root cause.
- A related-but-distinct hazard remains **open** in the same two hooks: `startUpload`'s and `startImport`'s re-entrancy guards (`if (uploadState === 'uploading') return`, `if (!accessToken || status !== 'idle') return`) read `uploadState`/`status` from React **state** via a closure, not a ref, so two calls fired before a re-render could both pass the guard (flagged in `.context/compound-engineering/ce-review/2026-04-06-001/run.md`, P1, still present as of `hooks/useGooglePhotosUpload.ts:213`). Do not treat this as fixed by the work in this doc — the mechanism is inverted (the guard itself is stale-closure-vulnerable, not a ref value read too late by an otherwise-correct guard).
- `docs/solutions/integration-issues/google-photos-picker-pagination-token-never-followed.md` — another related but distinct hazard in the same file: a single-invocation, no-concurrency omission (the media-items fetch never followed `nextPageToken` to get further pages) rather than this doc's cross-call shared-ref race.
