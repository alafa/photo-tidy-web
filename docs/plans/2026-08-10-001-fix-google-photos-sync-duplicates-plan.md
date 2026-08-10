---
title: "Google Photos Album-Based Sync - Plan"
type: fix
date: 2026-08-10
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Google Photos Album-Based Sync - Plan

## Goal Capsule

- **Objective:** Replace photo-tidy's Google Photos upload with an album-based workflow, and fix a silent upload-failure bug, so re-uploading a curated batch never creates stray duplicates and never fails without telling the user.
- **Authority hierarchy:** This Product Contract's Requirements govern product behavior. Planning Contract KTDs govern implementation mechanism within those Requirements. A unit overrides neither.
- **Stop conditions:** Stop and flag if further investigation shows the Google Photos API can, after all, modify or delete media items not created by this app (contradicts KTD2) — that would reopen the redesign this plan is built on.
- **Execution profile:** Standard depth, 6 implementation units. U6 is independent of the others; U1 and U2 both edit `components/PhotoUploadPage.tsx` and should be sequenced, not run in parallel.
- **Tail ownership:** `ce-work` or the executing agent owns commits, tests, and PR/landing per repo convention; this plan does not prescribe git workflow.

---

## Product Contract

### Summary

This plan replaces photo-tidy's Google Photos upload with an album-based workflow: every upload creates one new `<batch name> (photo tidy)` album containing the full curated set of current photos — imported, edited, or added locally — while excluding anything the user removed in-app. It also fixes a silent-failure bug where a failed upload showed no error and marked photos "done" before Google Photos had actually confirmed them.

### Problem Frame

Two bugs were reported. First, re-uploading a photo that was imported from Google Photos and then edited in the app created a duplicate in Google Photos instead of updating the original. Second, photos added from the local computer silently failed to appear in Google Photos at all.

Investigation against Google's official API documentation found that "update the original in place" is not achievable at all: the Library API's `mediaItems.patch` only updates the `description` field, and — like `albums.batchAddMediaItems` — only works on media items and albums the calling app created itself via the API. Photos picked from the user's existing library through the Photos Picker API are not app-created, so this app has no patch, delete, or album-move access to them, and the Library API has no delete endpoint at all regardless. There is also no field on a picked media item that links back to it in the Google Photos UI, so the app cannot even hand the user a direct link to the original.

Given that constraint, the agreed design abandons "replace in place" and instead makes every upload a complete, named album — a `<batch name> (photo tidy)` album holding the app's current curated photo set — with the user manually deleting the stale original album in Google Photos afterward, guided by an in-app message.

Separately, tracing the local-upload failure found a concrete code-level cause unrelated to any API restriction: the upload panel has no UI for the upload-error state, and each photo is marked "done" as soon as its raw bytes upload — before the separate album-create call that actually creates the Google Photos item. A failure in that later step is invisible: every photo shows a misleading green checkmark, no error appears anywhere, and "Retry failed" finds nothing to retry.

### Requirements

**Album-based upload workflow**

- R1. Every upload creates one Google Photos album named `<batch name> (photo tidy)`.
- R2. The user provides a batch name at Google Photos import time, or via the existing Album Name field when the session never imports from Google Photos. The name stays editable, including being overwritten by a later import in the same session, until upload is triggered.
- R3. Every currently-listed, non-deleted photo is included in the upload, regardless of origin (imported or local) or whether it was edited.

**In-app curation**

- R4. The user can remove a photo from the working batch from within the app. Removal never calls the Google Photos API; it only excludes the photo from the next upload.

**Upload reliability and feedback**

- R5. Album creation is mandatory on every upload. Upload failures, including album creation failure, are always visible in the UI, never silent.
- R6. A photo's upload status reflects Google's actual per-item batch-create result, not just the completion of its raw byte upload.
- R7. After a successful upload that included Google-Photos-origin photos, the app reminds the user they can delete the original photos' source album manually, without asserting a specific verified album name (the app has no way to confirm one).

### Scope Boundaries

#### Deferred to Follow-Up Work

- Delete propagation: deleting a photo in the app does not delete anything in Google Photos (R4) — carried forward from the original bug report's explicit out-of-scope note, not newly introduced by this plan.
- Bandwidth cost of re-uploading unchanged photo bytes on every upload (R3 uploads everything, not just changes) — accepted tradeoff for simplicity; not optimized in this plan.
- Any app-created "trash album" or similar workaround for the original photos — confirmed impossible via the API (see KTD2); not attempted.

### Acceptance Examples

- AE1. Given a session that imports 2 Google-Photos-origin photos (one edited, one unedited) and then adds 1 local photo, when the user uploads, then all 3 photos survive to the upload (the local add does not drop the earlier import), all 3 appear in the new `<name> (photo tidy)` album, and the success message reminds the user to check for and delete the original source album. Covers R1, R3, R7.
- AE2. Given a batch of 3 photos where the user deletes 1 in-app before uploading, when the user uploads, then only the 2 remaining photos are uploaded and the deleted photo is untouched in Google Photos. Covers R3, R4.
- AE3. Given a local-only session with no Google Photos import, when the user types a name into the Album Name field and uploads, then a new `<name> (photo tidy)` album is created containing the local photos, with no manual-cleanup guidance shown. Covers R2, R3, R5, R7.
- AE4. Given a batch-create call that partially fails (2 of 3 photos succeed), when the upload finishes, then the 2 succeeding photos show "done", the 1 failing photo shows "failed" with its own status message, "Retry failed" re-attempts only that photo, and the banner shows a qualified partial-success state rather than the full success banner. Covers R6.

### Sources

- [`mediaItems.patch` reference](https://developers.google.com/photos/library/reference/rest/v1/mediaItems/patch) — confirms patch is description-only and restricted to app-created items ("The media item must have been created by the developer via the API").
- [`albums.batchAddMediaItems` reference](https://developers.google.com/photos/library/reference/rest/v1/albums/batchAddMediaItems) — confirms both the media item and the album must be app-created, ruling out an app-created "trash album" holding picked (non-app-created) originals.
- [Updates to the Google Photos APIs](https://developers.google.com/photos/support/updates) — confirms the Library API provides no delete endpoint at all, and management access as of March 2025 is restricted to app-created content; picking from the user's full library is the Picker API's role, with no write-back path to picked items.
- `docs/solutions/integration-issues/google-photos-json-parse-failure-returns-200.md` — established convention for this codebase: parse upstream JSON with `try`/`catch` that decides the response status inside the `catch` block, never `.catch(() => fallback)` riding an unrelated status branch. Applies to any new or changed fetch call in U3–U5.
- `CONCEPTS.md` — "Picker Session" and "Media Item" are this repo's canonical terms for the Google Photos import flow.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Drop per-photo Google `mediaItem` ID tracking.** The original investigation asked how the app tracks a local photo's Google Photos identity, expecting that link to drive selective replace/skip logic. It is not needed: every upload now re-creates the full batch in a new album regardless of per-photo origin or edit state, so no code needs to know which specific Google item a photo came from. *(session-settled: user-directed — chosen over building `mediaItem.id` tracking to selectively skip or replace individual photos: the user redirected from per-photo replace toward a full-batch new-album model, making identity tracking unnecessary.)*
- KTD2. **No delete, patch, or album-move of original Google Photos items.** Confirmed against Google's official API docs (see Sources) that none of these operations are available for media items not created by this app, and that the Library API has no delete endpoint at all. Cleanup of originals is manual, guided by the R7 reminder message (see KTD7 for why it does not name a specific verified album). *(session-settled: user-directed — chosen over an app-created "trash album" workaround: verified impossible via API docs; user accepted manual cleanup given the constraint.)*
- KTD3. **Album creation is unconditional on every upload**, replacing the current `if (albumName.trim())` gate in `hooks/useGooglePhotosUpload.ts`. *(session-settled: user-directed.)*
- KTD4. **The batch name is captured at Google Photos import time**, or via the existing Album Name field for a local-only session that never imports, and stays editable — including being overwritten by a later import in the same session — until upload. It is reused as-is for the created album's name (with the `(photo tidy)` suffix). It is *not* asserted as a verified real album title in the R7 guidance message (see KTD7). *(session-settled: user-directed for the import-time capture; the local-only fallback to the existing field is this plan's assumption, surfaced during scoping and not contested.)*
- KTD5. **Per-photo status is decided by the batch-create response, not the raw upload step.** `lib/google-photos-types.ts` already defines `NewMediaItemResult` with a per-item `status`; today nothing reads it. A photo is marked "done" only when its own result in `BatchCreateResult.newMediaItemResults` indicates success, and "failed" (with that result's message) otherwise — closing the silent-failure gap in R6.
- KTD6. **In-app "delete from batch" is local-only state removal**, reusing the existing multi-select mechanism (`selectedIds` + `BatchEditPanel`) rather than adding a new per-card control. Consistent with delete propagation staying out of scope (R4).
- KTD7. **The R7 guidance message does not assert a specific, verified original album title.** Document review (4 independent reviewers) found the batch name is a user-typed label the app cannot check against any real Google Photos album — the Picker API returns no album-membership data for a picked item. Naming a specific title with certainty risks pointing the user at an album that doesn't exist, or a same-named but unrelated one. The guidance is phrased generically instead (e.g. "if these photos came from an existing Google Photos album, you can now delete it manually").
- KTD8. **Per-photo upload status is matched by photo id, not array position.** Document review found the original design (match `batchCreate`'s per-item results to `photos` by array index) breaks whenever any photo's raw upload fails first, since the token list becomes a subset of the photo list. Each submitted token now carries its source photo's id, and Google's response is re-matched by `uploadToken` (via a lookup map, since each `NewMediaItemResult` echoes the token it corresponds to) rather than by array position — removing a second, independent assumption that response order mirrors submission order. A subsequent review pass also fixed `batchCreate` to keep processing later chunks after one chunk fails outright (previously it threw immediately, abandoning every chunk after the failing one) and to guard the chunk's own `res.json()` parse with try/catch (a non-JSON 2xx response used to leave that chunk's photos stuck at `'uploading'` forever).

### High-Level Technical Design

The redesigned upload flow, from click to per-photo outcome:

```mermaid
flowchart TB
    A[Click Upload to Google Photos] --> B{photos list empty?}
    B -->|yes| Z1[uploadState = done, no album created]
    B -->|no| C[Create album: name + \" (photo tidy)\"]
    C -->|fails| E1[uploadState = error, error banner shown]
    C -->|succeeds| D[Upload raw bytes per photo, by id]
    D --> F[batchCreate per chunk, matched back by photo id]
    F -->|chunk call fails outright| E2[every pending photo in that chunk = failed]
    F -->|succeeds, per-item results| G{each photo's own result}
    G -->|success| H[status = done]
    G -->|failure| I[status = failed, shows result message]
    H --> M{any photo still failed?}
    I --> M
    M -->|yes| N[Partial-success banner + failed rows]
    M -->|no| O[Full success banner]
    N --> J{any done photo source = google-photos?}
    O --> J
    J -->|yes| K[+ generic \"check the original album\" reminder]
    J -->|no| L[No cleanup reminder shown]
```

### Assumptions

- For a local-only session (no Google Photos import), the batch name comes from the existing Album Name field in `components/GooglePhotosUploadPanel.tsx`, made required instead of optional. This was proposed during scoping and not contested, but was not explicitly restated in the final confirmation — flagged here per the Assumptions convention for un-re-confirmed inferred bets.

### Risks & Dependencies

- **Repeat uploads within one session create separate albums, not one growing album.** `useGooglePhotosUpload.ts` resets its album tracking at the start of every `startUpload` call, and U3 keeps that behavior. If the user uploads, makes more edits, and uploads again in the same session with the same batch name, Google Photos ends up with two albums sharing the name `<batch name> (photo tidy)` — Google allows duplicate album names. Reusing the same album across re-uploads was considered and rejected for this plan: the app's own uploaded photos and created album are app-created, so the API would technically allow adding to that album again, but a photo edited a second time still cannot have its first upload's bytes replaced in place (KTD2's constraint applies to the app's own previously-uploaded items too, not only the original picked items) — reusing the album would just relocate the duplicate problem inside it. Mitigation: none built into this plan; the user is expected to finish editing before uploading, matching the existing `hasEdits` confirmation already shown when adding more photos mid-session.
- **`batchCreate` per-item status codes (U4) are read from the API response shape documented today; this has not been exercised against a real, signed-in Google account during planning** (Vitest mocks the fetch layer). See the Definition of Done's live-verification item.

### Open Questions

Both items below are deferred, not blocking — the implementation units are fully specified regardless of how either is resolved.

- **Does the Goal Capsule's "never creates stray duplicates" objective need narrowing?** The Risks & Dependencies entry above shows repeat uploads within one session still create duplicate albums, just relocated from the photo level to the album level. Document review flagged this as a real gap between the stated objective and what the design delivers. Two resolutions: narrow the objective's wording to scope it to per-photo duplicates within a single upload (cheap, honest, no design change), or build session-scoped album reuse so a second upload with the same batch name adds to the still-open album instead of creating a new one (a real design change with its own tradeoffs, since KTD2's no-replace-in-place constraint would still apply to a photo edited a second time within that reused album). Deferred to a follow-up decision rather than resolved here.
- **Should "Delete selected" in `BatchEditPanel` require a confirmation step?** It is the only irreversible-within-session batch action (Rename and Set timestamp are both re-appliable). U2 currently specifies no confirmation, matching the existing batch-operation pattern. Deferred — U2 can ship either way; add a confirmation step later if accidental deletion turns out to be a real problem in practice.

---

## Implementation Units

### U1. Capture the upload batch name

- **Goal:** The user names the batch once per session — prompted at Google Photos import time, or via the existing Album Name field for a local-only session — and the upload action is disabled until a name exists.
- **Requirements:** R2. Governs KTD4.
- **Dependencies:** None.
- **Files:**
  - `components/PhotoUploadPage.tsx`
  - `components/PhotoUploadPage.test.tsx`
  - `components/GooglePhotosUploadPanel.tsx`
  - `components/GooglePhotosUploadPanel.test.tsx`
- **Approach:**
  1. Before calling `startImport()` from the "Import from Google Photos" button, prompt for a batch name (an inline text input matching the existing Album Name field's styling), and store it in `PhotoUploadPage`'s existing `albumName` state.
  2. Keep the existing Album Name field in `GooglePhotosUploadPanel` as the single place the name is edited afterward — it now shows the import-time name pre-filled, and is the only entry point when no import happened this session.
  3. Change the Album Name field's placeholder and remove the "(optional)" wording; disable the "Upload to Google Photos" button while the trimmed name is empty, and show helper text under the field (e.g. "Enter a name to enable upload") whenever it's disabled for that reason.
- **Patterns to follow:** Mirror the existing Album Name `<input>` in `components/GooglePhotosUploadPanel.tsx` for styling and controlled-input shape. The exact interaction shape of the import-time prompt (modal vs. inline expansion) is an implementation-time UI choice; ensure it has a visible cancel path that collapses the prompt without starting the picker session.
- **Test scenarios:**
  - User imports from Google Photos, is prompted for a name, provides "Vacaciones 2024" — `albumName` state reflects it.
  - User never imports (local-only session), types a name directly into the existing Album Name field — upload becomes enabled.
  - User imports twice in one session with two different names — the second name replaces the first (last-import-wins) in the Album Name field.
  - Whitespace-only name leaves the upload button disabled, with helper text shown.
  - Integration: the "Upload to Google Photos" button's disabled state toggles correctly as the name is entered and cleared.
- **Verification:** `npm run test -- PhotoUploadPage GooglePhotosUploadPanel` passes; manual check that the name prompt appears before the Google sign-in popup's picker flow starts.

### U2. In-app delete from batch (local-only)

- **Goal:** The user can remove selected photos from the working batch and the next upload, without any Google Photos API call.
- **Requirements:** R4. Governs KTD6.
- **Dependencies:** None.
- **Files:**
  - `hooks/usePhotos.ts`
  - `hooks/usePhotos.test.ts`
  - `components/BatchEditPanel.tsx`
  - `components/BatchEditPanel.test.tsx` (new — no existing test file for this component)
  - `components/PhotoUploadPage.tsx`
  - `components/PhotoUploadPage.test.tsx`
- **Approach:**
  1. Add `removePhotos(ids: string[])` to `hooks/usePhotos.ts`, filtering the `photos` state by ID, mirroring the shape of the existing `batchUpdateNames`/`batchSetTimestamps` callbacks.
  2. Add a "Delete selected" action to `components/BatchEditPanel.tsx` alongside the existing Rename and Set timestamp actions, via a new `onBatchDelete` prop.
  3. Wire a `handleBatchDelete` in `components/PhotoUploadPage.tsx`: call `removePhotos(Array.from(selectedIds))`, then `clearSelection()`.
- **Patterns to follow:** `components/BatchEditPanel.tsx`'s existing Rename/Set-timestamp action shape (labeled control + Apply button, operating on `selectedIds`).
- **Test scenarios:**
  - Select 2 of 5 photos, click Delete selected — the list shrinks to 3, the deleted photos are gone.
  - Delete every currently-selected photo, emptying the list entirely — no error, selection clears.
  - Integration: after deleting a photo, the next `startUpload(photos, ...)` call no longer includes that photo's ID. Covers AE2.
  - Test expectation for the Google Photos API surface: none — this unit makes no `fetch` call to any `/api/google-photos/*` route.
- **Verification:** `npm run test -- usePhotos BatchEditPanel PhotoUploadPage` passes.

### U3. Make album creation mandatory for every upload

- **Goal:** Every upload targets a named Google Photos album; there is no loose, no-album upload path left.
- **Requirements:** R1, R3, R5. Governs KTD3.
- **Dependencies:** U1 (guarantees a non-empty `albumName` by the time upload is reachable).
- **Files:**
  - `hooks/useGooglePhotosUpload.ts`
  - `hooks/useGooglePhotosUpload.test.ts`
  - `components/GooglePhotosUploadPanel.tsx`
- **Approach:**
  1. Remove the `if (albumName.trim())` conditional currently gating album creation in `startUpload` — treat it as unconditional.
  2. Keep the existing `photos.length === 0` early return ahead of album creation, so an empty batch still skips creating an album.
  3. Name the created album `` `${albumName.trim()} (photo tidy)` ``.
  4. Reduce the Album Name field's `maxLength` from 500 to 487 (`components/GooglePhotosUploadPanel.tsx`), so the composed `<name> (photo tidy)` title can never exceed the server's 500-character cap in `app/api/google-photos/albums/route.ts`.
- **Test scenarios:**
  - `startUpload` with a non-empty `albumName` and a non-empty `photos` array always creates an album before uploading any photo bytes.
  - `startUpload` called with an empty `photos` array creates no album and goes straight to `uploadState: 'done'`.
  - Album creation's `fetch` fails — `uploadState` becomes `'error'`; no photo upload is attempted. Covers AE1/AE3 (album gets created before uploads).
  - The created album's request body uses the exact `<name> (photo tidy)` format, not the raw batch name.
- **Verification:** `npm run test -- useGooglePhotosUpload` passes.

### U4. Correct per-photo done/failed status against the actual outcome

- **Goal:** A photo is marked "done" only once its own batch-create result confirms it, not merely because its raw bytes finished uploading, and status is never misassigned to the wrong photo. Governs KTD8.
- **Requirements:** R6. Governs KTD5.
- **Dependencies:** U3.
- **Files:**
  - `hooks/useGooglePhotosUpload.ts`
  - `hooks/useGooglePhotosUpload.test.ts`
- **Approach:**
  1. In `uploadSinglePhoto`, stop marking the photo `'done'` after the raw-bytes upload succeeds; keep it `'uploading'` until the batch-create step resolves. Return the photo's id alongside its upload token (e.g. `{ photoId, token }`) instead of a bare `UploadToken`, since `startUpload` builds its token list by skipping any photo whose raw upload failed — the token list is a subset of `photos`, so array position alone cannot identify the source photo once a failure occurs earlier in the batch.
  2. Change `batchCreate` to parse and return `BatchCreateResult.newMediaItemResults` (currently discarded) instead of `void`. For each 50-item chunk, match that chunk's results back to that chunk's own submitted photo ids — not a single running position across the whole call — and set `'done'` only for a successful result, `'failed'` (carrying that result's status message) otherwise.
  3. If a chunk's `batchCreate` call fails outright (network error or non-2xx), mark every still-pending photo whose token was in that chunk `'failed'` with a shared error message, so no row is left indefinitely `'uploading'` and "Retry failed" has something to act on.
  4. Apply the same id-based, per-chunk matching in `retryFailed`'s batch-create call.
- **Patterns to follow:** `lib/google-photos-types.ts`'s existing `NewMediaItemResult { uploadToken, status: { message, code? }, mediaItem? }` — no new types needed.
- **Test scenarios:**
  - `batchCreate` returns full success (every result indicates success) — every uploaded photo shows `'done'`.
  - `batchCreate` returns partial success (some results fail) — succeeding photos show `'done'`, failing ones show `'failed'` with their own message, not a blanket failure. Covers AE4.
  - A batch where one photo's raw upload fails before batch-create runs, and the remaining photos succeed — the surviving photos' results are matched to the correct photo ids, not misaligned by the missing token.
  - A batch larger than 50 photos spanning multiple batch-create chunk calls — each chunk's results are matched only to that chunk's own photos.
  - A chunk's `batchCreate` call fails outright (network error or non-2xx) — every photo in that chunk ends up `'failed'`, none stay stuck `'uploading'`.
  - Integration: `retryFailed` re-runs only photos previously `'failed'`, and applies this same id-based, per-chunk logic to the retry's response.
- **Verification:** `npm run test -- useGooglePhotosUpload` passes.

### U5. Surface upload failures and post-upload cleanup guidance

- **Goal:** No upload outcome is silent — failures are visible, and a successful upload that included Google-Photos-origin photos tells the user what to clean up manually.
- **Requirements:** R5, R7.
- **Dependencies:** U3, U4.
- **Files:**
  - `components/GooglePhotosUploadPanel.tsx`
  - `components/GooglePhotosUploadPanel.test.tsx`
- **Approach:**
  1. Add a rendering branch for `uploadState === 'error'`: an error banner naming the failure, with a retry action (reuse the existing "Retry failed" affordance when individual photos are marked `'failed'`; when the failure happened before any per-photo attempt — album creation — offer a general retry that re-invokes the upload).
  2. Distinguish two outcomes when `uploadState === 'done'`: full success (no photo marked `'failed'`) renders the existing green success banner; partial success (at least one photo marked `'failed'`, per U4) renders a qualified banner instead (e.g. "N of M photos uploaded — see failures below"), alongside the existing per-photo `'failed'` rows.
  3. In both the full-success and partial-success cases, when at least one uploaded photo has `source === 'google-photos'` and reached `'done'`, add a line reminding the user to check for and delete the original source album manually — phrased generically per KTD7 (e.g. "If these photos came from an existing Google Photos album, you can now delete it manually"), never asserting the typed batch name as a confirmed, existing album title. Omit this line when no `'done'` photo in the batch has `source === 'google-photos'`.
- **Patterns to follow:** The existing success-banner and per-photo status-row rendering already in `components/GooglePhotosUploadPanel.tsx`.
- **Test scenarios:**
  - `uploadState` becomes `'error'` after album creation fails — an error banner renders with the failure reason, replacing the current silent no-render.
  - A batch with Google-Photos-origin photos finishes fully successfully — the success banner shows both the upload confirmation and the manual-cleanup reminder, without asserting a specific verified album name. Covers AE1.
  - A local-only batch finishes successfully — the success banner shows only the upload confirmation, no cleanup reminder. Covers AE3.
  - A batch with a partial `batchCreate` failure (per U4) shows a qualified "N of M uploaded" banner instead of the full success banner, with the per-photo `'failed'` rows visible, and still shows the cleanup reminder if at least one Google-Photos-origin photo reached `'done'`. Covers AE4.
- **Verification:** `npm run test -- GooglePhotosUploadPanel` passes.

### U6. Merge newly-added local files into the existing batch instead of replacing it

- **Goal:** Adding local files (via file picker or drag-drop) extends the current working batch instead of discarding it, so a session that imports from Google Photos and then adds local files keeps both. Required for AE1 to hold.
- **Requirements:** R3.
- **Dependencies:** None.
- **Files:**
  - `hooks/usePhotos.ts`
  - `hooks/usePhotos.test.ts`
  - `components/PhotoUploadPage.tsx`
  - `components/PhotoUploadPage.test.tsx`
- **Approach:**
  1. Change `processFiles` in `hooks/usePhotos.ts` to append its newly-processed entries to the existing `photos` state, instead of replacing the whole list via `setPhotos(sortPhotos(entries))` — today's replace semantics silently discard any already-imported or already-added photos.
  2. Assign `uploadIndex` to the new entries by continuing from the current maximum, mirroring the existing `addPhotos` append logic, so new local files sort correctly alongside already-present photos.
  3. `PhotoUploadPage.tsx`'s `maybeConfirm()` gate on `handleChange`/`handleDrop` exists because adding files used to discard all existing edits via full replacement; once `processFiles` appends, nothing is discarded there, so that confirmation is no longer warranted for this path. Remove the gate from `handleChange`/`handleDrop` after confirming no other behavior in those handlers still depends on it.
- **Patterns to follow:** `hooks/usePhotos.ts`'s existing `addPhotos` append-with-index-offset logic.
- **Test scenarios:**
  - Import 2 photos from Google Photos, then add 1 local file via drag-drop — all 3 photos remain in the list afterward. Covers AE1.
  - Add local files with no prior photos in the list — behaves the same as today (nothing to preserve).
  - Add local files twice in a row — both batches' files are present, not just the most recent.
  - Test expectation for the Google Photos API surface: none — this unit makes no `fetch` call to any `/api/google-photos/*` route.
- **Verification:** `npm run test -- usePhotos PhotoUploadPage` passes.

---

## Verification Contract

| Command | Applies to | Purpose |
|---|---|---|
| `npm run test` | All units | Vitest suite; every unit above ships its own test file changes. |
| `npm run lint` | All units | ESLint. |
| `npm run build` | U3, U4, U5, U6 | Production build sanity — these units touch typed API-response handling paths. |

No `release:validate` or behavioral skill evaluation applies to this repo.

---

## Definition of Done

- All six units implemented; `npm run test`, `npm run lint`, and `npm run build` pass.
- AE1–AE4 hold when manually exercised against a real signed-in Google account (Vitest mocks the Google Photos API surface; the API's actual `mediaItems:batchCreate` and album-creation behavior has not been exercised live during planning).
- No abandoned-approach code remains — e.g. no dead per-photo identity-tracking scaffolding left over from the design direction ruled out by KTD1.
- `GooglePhotosUploadPanel.tsx` has a rendering branch for every `UploadState` value (`'idle'`, `'uploading'`, `'done'`, and both the full-success and partial-success shapes of `'done'`, `'error'`) — none silently render nothing.
- No per-photo upload status is ever assigned by array position alone — U4's id-based, per-chunk matching (KTD8) is in place for both `startUpload` and `retryFailed`.
