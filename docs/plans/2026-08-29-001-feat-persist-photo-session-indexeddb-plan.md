---
title: Persist Photo Session Across Page Reloads - Plan
type: feat
date: 2026-08-29
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
deepened: 2026-08-29
---

# Persist Photo Session Across Page Reloads - Plan

**Target repo:** photo-tidy-web

## Goal Capsule

- **Objective:** add a browser-local IndexedDB persistence layer so the user's photo batch survives page reload, tab close, and lost connectivity, and is cleared only by an explicit "Clear all" action.
- **Authority hierarchy:** this Planning Contract's Key Technical Decisions govern implementation mechanism; Product Contract Requirements govern product behavior; a unit's Approach never overrides either.
- **Execution profile:** standard `ce-work`/`/goal` execution — five dependency-ordered units, no phased milestones needed.
- **Stop conditions:** a unit's test scenarios fail after a genuine attempt, or an implementation discovery contradicts a KTD's premise (e.g. a targeted browser lacks a relied-on API) — surface as a blocker rather than guessing.
- **Tail ownership:** the implementer runs the Verification Contract gates and satisfies Definition of Done; this plan does not choose a PR/landing strategy — follow repo convention.

---

## Product Contract

### Summary

Add an IndexedDB-backed persistence layer to `photo-tidy-web` so the current photo batch (blobs, thumbnails, and metadata) survives reload, tab close, and lost connectivity. Photos accumulate across import sessions. Only an explicit "Clear all" button wipes the stored set. Clustering results, the similarity-slider position, and UI-only state stay ephemeral. Storage-full surfaces as a warning, never a silent failure.

### Problem Frame

Photos currently live only in `hooks/usePhotos.ts`'s in-memory React state. A reload, crash, or dropped connection loses the entire batch, forcing the user to restart Google Photos import or re-select local files. This makes the app unreliable for large batches worked on over more than one sitting.

### Requirements

**Storage and restore**
- R1. Every photo added, by local upload or Google Photos import, is written to IndexedDB (blob, thumbnail, and metadata) as part of being added to the batch.
- R2. On page load, all previously stored photos and their metadata are restored before the user can act on the photo batch.
- R3. A loading state is shown while photos are being restored from IndexedDB.

**Accumulation and clearing**
- R4. Photos accumulate across import sessions. Importing new photos adds to the existing set; it never replaces it.
- R5. A "Clear all" button is the only action that wipes the persisted photo set. Page refresh, tab close, and lost connectivity do not clear it.
- R6. Deleting a photo from the batch persists. The photo does not reappear after reload.

**What persists**
- R7. Each persisted photo record carries: id, filename, capturedAt, source, uploadIndex, user edits (renamed filename, changed timestamp), and the Google Photos `mediaItemId` once the photo has uploaded.
- R8. A 300px thumbnail is stored alongside each photo's original blob, for fast rendering on restore.
- R9. Clustering results, the similarity-slider position, and UI-only state (scroll position, selection) are not persisted.

**Storage failure**
- R10. If IndexedDB storage is full, the app shows a warning. It never fails silently.

### Scope Boundaries

- Only `photo-tidy-web/` changes. `photo-tidy-api/` is untouched.
- Multi-tab concurrent use is out of scope. The design assumes a single writer to the IndexedDB store; two tabs open on the same origin can interleave writes unpredictably.

#### Deferred to Follow-Up Work

- Progressive/lazy restore (thumbnails first, full-resolution blobs streamed in afterward) is not needed at this batch's expected scale (hundreds of photos) and is deferred if real usage proves the simple `getAll()` restore too slow.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **Hand-roll a minimal typed IndexedDB wrapper instead of adding the `idb` dependency.** The store needs five operations against one object store (open, get all, put, delete, clear) — too narrow to justify a new runtime dependency, and CLAUDE.md asks that new dependencies be raised before adding. Tests stub IndexedDB with a small hand-rolled mock via `vi.stubGlobal`, matching this repo's existing convention (e.g. `URL.createObjectURL` in `hooks/usePhotos.test.ts`), rather than adding the `fake-indexeddb` devDependency.
- KTD2. **Restore blocks photo-batch interactions until it completes**, rather than allowing uploads/imports/Clear-all to run concurrently with an in-flight restore. This matches R3's own loading-state framing and avoids inventing merge logic for concurrent-write races that blocking eliminates by construction.
- KTD3. **`mediaItemId` is added to `PhotoEntry` and persisted as part of the photo record**, not persisted by reading `useGooglePhotosUpload`'s separate `photoStates` map. `photoStates` is a session-local upload-progress tracker (cleared by `reset()`), never designed to be a durable source of truth. *(session-settled: user-approved — chosen over persisting `photoStates` directly: keeps one source of truth for what's durable; user confirmed this framing during scoping.)*
- KTD4. **The restore effect and `useGooglePhotosUpload`'s upload tracking reuse this repo's existing generation-token pattern** (`uploadGenerationRef`, `importGenerationRef`), rather than a plain boolean flag, per `docs/solutions/logic-errors/stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md`. `useGooglePhotosUpload`'s generation token is extended to bump when a tracked photo is removed from the batch, not only on `reset()` — so a late-resolving `mediaItemId` write can never target a photo the user already deleted.
- KTD5. **Restored `File` objects are explicitly reconstructed** as `new File([blob], filename, { type, lastModified })` from persisted metadata, not left as bare `Blob`s. `batchUpdateNames` (`hooks/usePhotos.ts:130`) reads `file.name`, which a bare `Blob` does not carry.
- KTD6. **Storage-quota failures are handled per photo.** A write that throws `QuotaExceededError` skips persisting that one photo — the in-memory session state is unaffected, so the photo stays visible and usable this session — and surfaces one warning banner. Already-persisted photos in the same batch stay persisted.
- KTD7. **Persistence writes are chunked (10-20 records per transaction) and yield to the main thread between chunks**, so a large import batch does not block the UI. Restore reads use a single `getAll()`; at the expected scale (hundreds of records) a chunked read adds complexity the batch size does not yet justify (see Deferred to Follow-Up Work).
- KTD8. **Restored photos with a persisted `mediaItemId` seed `useGooglePhotosUpload`'s tracking as `status: 'done'` at hook init.** Without this, a restored already-uploaded photo looks re-uploadable, risking a duplicate Google Photos album entry.
- KTD9. **"Clear all" performs one comprehensive reset**: wipe the IndexedDB store, clear in-memory photos, revoke all object URLs, and reset the Google Photos upload tracking. This matches R5's "wipe the entire session" framing rather than only clearing the IndexedDB store.
- KTD10. **`uploadIndex` is persisted verbatim as part of each photo's record**, not recomputed from IndexedDB read order. Undated photos tie-break on `uploadIndex`; recomputing it on restore could reorder photos the user arranged by drag.
- KTD11. **Persistence thumbnails are generated independently from the clustering feature's thumbnails.** Both call `lib/generate-thumbnail.ts`'s `generateThumbnail`, but persistence generates and stores its own copy once, at add-time; clustering continues to regenerate on demand for each API call. The two serve different purposes (durable display vs. ephemeral API payload), and clustering already treats its thumbnail as disposable — sharing a cache is a bigger structural change than this plan needs.
- KTD12. **`navigator.storage.persist()` is requested once, best-effort, after the first successful photo import.** A denied or ignored request does not block or degrade the feature; it only reduces (does not eliminate) the risk of browser-initiated eviction of stored photos under storage pressure or, on Safari, extended inactivity.
- KTD13. **A restore, a delete, and a "Clear all" that all target the same photo funnel through one delete path** (extending `PhotoUploadPage.tsx`'s existing `handleBatchDelete` wrapper), rather than adding a second raw call site to `removePhotos`. A prior bug (`docs/solutions/logic-errors/cluster-view-delete-missing-object-url-release-and-selection-cleanup.md`) happened exactly this way: a second delete-capable surface skipped the wrapper's object-URL cleanup. The same risk applies to the new persistence-delete and upload-tracking-removal side effects this plan adds.

### High-Level Technical Design

**Restore-on-mount, guarded by a generation token:**

```mermaid
sequenceDiagram
    participant Page as PhotoUploadPage
    participant Persist as usePhotoPersistence
    participant Store as IndexedDB (lib/photo-storage)
    participant Photos as usePhotos
    participant Upload as useGooglePhotosUpload

    Page->>Persist: mount
    Persist->>Persist: bump restoreGenerationRef
    Persist->>Store: getAllPhotoRecords()
    Note over Persist: isRestoring = true; Page disables<br/>upload/import/Clear all
    Store-->>Persist: records (blob, thumbnail, metadata)
    Persist->>Persist: still current generation?
    alt generation superseded (Strict Mode remount or Clear all fired)
        Persist->>Persist: discard result
    else current
        Persist->>Persist: reconstruct File per record (KTD5)
        Persist->>Photos: hydratePhotos(entries)
        Persist->>Upload: seed photoStates from persisted mediaItemId (KTD8)
        Persist->>Persist: isRestoring = false
    end
```

**Delete during an in-flight Google Photos upload (KTD4's race guard):**

```mermaid
sequenceDiagram
    participant User
    participant Page as PhotoUploadPage
    participant Upload as useGooglePhotosUpload
    participant Persist as usePhotoPersistence
    participant Store as IndexedDB

    Upload->>Upload: batchCreate in flight for photo P
    User->>Page: delete photo P
    Page->>Upload: notify removal of P
    Upload->>Upload: bump uploadGenerationRef
    Page->>Persist: delete-through (KTD13)
    Persist->>Store: deletePhotoRecord(P.id)
    Upload-->>Upload: batchCreate resolves late for P
    Upload->>Upload: generation check fails -> drop result
    Note over Persist,Store: P's mediaItemId is never written;<br/>no resurrected record
```

---

## Implementation Units

### U1. IndexedDB storage module

**Goal:** provide the low-level persistence primitives the rest of the plan builds on: a single `photos` object store keyed by `id`, CRUD helpers, and quota helpers.

**Requirements:** R1, R7, R8, R10

**Dependencies:** none

**Files:**
- `lib/photo-storage.ts` (new)
- `lib/photo-storage.test.ts` (new)

**Approach:**
- Hand-rolled Promise wrapper around raw IndexedDB (KTD1) — no `idb` dependency.
- One object store, `photos`, version 1, keyed by `id`. `onupgradeneeded` creates the store; no migration logic needed yet.
- Exports: `getAllPhotoRecords()`, `putPhotoRecord(record)`, `deletePhotoRecord(id)`, `clearAllPhotoRecords()`, `checkQuota()` (wraps `navigator.storage.estimate()`), `requestPersistence()` (wraps `navigator.storage.persist()`, resolves `false` on denial rather than throwing).
- `putPhotoRecord` rejects with a distinguishable error (e.g. a `QuotaExceededError` instance check) so callers can implement KTD6 without string-matching error messages.

**Test scenarios:**
- Opening the database creates the `photos` store on first use.
- `putPhotoRecord` then `getAllPhotoRecords` round-trips a record, including a `Blob` field, unchanged.
- `deletePhotoRecord` removes exactly the targeted record; others are untouched.
- `clearAllPhotoRecords` empties the store.
- A write that throws `QuotaExceededError` (simulated via the IndexedDB stub) rejects with an error the caller can identify as quota-related, not a generic error.
- `checkQuota` surfaces `usage`/`quota` numbers from a stubbed `navigator.storage.estimate()`.
- `requestPersistence` resolves `false` without throwing when the stub simulates denial.

**Verification:** `npm run test -- lib/photo-storage`, `npm run lint`.

---

### U2. Extend `usePhotos` for persistence

**Goal:** add `mediaItemId` to `PhotoEntry`, and add a bulk-hydrate mutator restore can call safely more than once.

**Requirements:** R6, R7

**Dependencies:** none

**Files:**
- `hooks/usePhotos.ts`
- `hooks/usePhotos.test.ts`

**Approach:**
- `PhotoEntry` gains `mediaItemId?: string`.
- New mutator `hydratePhotos(entries: PhotoEntry[])` replaces the in-memory array wholesale (sorted via the existing `sortPhotos`), for the restore flow only. Idempotent: calling it twice with the same input leaves state unchanged, covering Strict Mode's double-mount.
- New mutator `setPhotoMediaItemId(id, mediaItemId)` updates one photo's `mediaItemId` in place, for the upload flow (U3) to call.
- Existing mutators (`processFiles`, `addPhotos`, `reorderPhotos`, `updatePhotoName`, `updatePhotoTimestamp`, `batchUpdateNames`, `batchSetTimestamps`, `removePhotos`) are unchanged.

**Execution note:** write `hydratePhotos`'s idempotency test first — restore-idempotency is exactly the bug class `docs/solutions/logic-errors/stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md` documents.

**Test scenarios:**
- `hydratePhotos` sets `photos` to the given (sorted) entries.
- Calling `hydratePhotos` twice with the same entries is a safe no-op — no duplication, same resulting array.
- `setPhotoMediaItemId` updates only the targeted photo's `mediaItemId`; other fields and other photos are untouched.
- Existing mutators' behavior is unchanged (regression pass over `hooks/usePhotos.test.ts`'s current scenarios).

**Verification:** `npm run test -- hooks/usePhotos`, `npm run lint`.

---

### U3. Extend `useGooglePhotosUpload` for durable `mediaItemId` and generation-safe deletion

**Goal:** let the upload flow announce a `mediaItemId` the moment it's known, seed prior uploads on restore, and never let a late-resolving upload write a `mediaItemId` for a photo that's been deleted.

**Requirements:** R7

**Dependencies:** U2

**Files:**
- `hooks/useGooglePhotosUpload.ts`
- `hooks/useGooglePhotosUpload.test.ts`

**Approach:**
- Accept an optional `onMediaItemIdSet(photoId, mediaItemId)` callback, invoked exactly once per photo when batch-create reports item-creation success — so U4 can write it durably at the moment it's known, not by polling `photoStates`.
- Accept an optional `seedMediaItemIds: Map<string, string>` at hook init; entries seed `photoStates` as `{ status: 'done', mediaItemId }` (KTD8).
- Add a `notifyPhotoRemoved(photoId)` function to the hook's return value. The call site (U5) calls it when a photo is deleted, bumping `uploadGenerationRef` (extending the existing reset-only bump per KTD4) so any in-flight `batchCreate`/`reconcile` result for that photo is dropped on arrival.

**Execution note:** add the "delete during in-flight upload" integration test first — the Critical race this plan's research flagged — before other work in this unit.

**Test scenarios:**
- `onMediaItemIdSet` fires exactly once per successfully created item, with the correct `(photoId, mediaItemId)` pair.
- Calling `notifyPhotoRemoved` for a photo with an in-flight `batchCreate` bumps the generation; that call's late-resolving result does not update `photoStates` and does not fire `onMediaItemIdSet`.
- `seedMediaItemIds` at init marks the given photo ids `status: 'done'` without triggering a re-upload attempt.
- Existing upload, retry, and reconcile test scenarios in `hooks/useGooglePhotosUpload.test.ts` still pass.

**Verification:** `npm run test -- hooks/useGooglePhotosUpload`, `npm run lint`.

---

### U4. `usePhotoPersistence` — restore and write-through orchestration

**Goal:** own the restore-on-mount and write-on-mutation lifecycle: read from U1 on mount, hydrate U2 and seed U3, then keep IndexedDB in sync with every subsequent mutation.

**Requirements:** R1, R2, R3, R7, R8, R10

**Dependencies:** U1, U2, U3

**Files:**
- `hooks/usePhotoPersistence.ts` (new)
- `hooks/usePhotoPersistence.test.ts` (new)

**Approach:**
- A `useRef` generation token, bumped on every mount-effect run, guards the restore per the High-Level Technical Design sequence diagram — a stale restore's `hydratePhotos` call is dropped if superseded (Strict Mode remount, or a "Clear all" that fires before restore resolves).
- On restore: read all records via U1, reconstruct `File` objects per KTD5, call U2's `hydratePhotos`, then call U3's seed path with persisted `mediaItemId`s (KTD8), then set `isRestoring = false`.
- On each `usePhotos` mutation (add, edit, delete, reorder), write through to U1 in chunks of 10-20 records, yielding to the main thread between chunks (KTD7).
- A write that rejects with the quota error from U1 skips that photo, adds one entry to `storageWarning`, and continues the batch (KTD6).
- After the first successful write, call U1's `requestPersistence()` once, fire-and-forget (KTD12).
- Exposes `{ isRestoring, storageWarning, hydrate, persistPhoto, deletePhotoPersisted, clearAllPersisted }` for U5 to wire into the UI.

**Execution note:** this unit owns the plan's highest-risk races. Write the Strict-Mode-double-invoke test and the mid-restore-write-ordering test before the happy-path restore test, so the generation guard is proven under adversarial ordering first.

**Test scenarios:**
- On mount, restore populates photos from stored records and sets `isRestoring` false when done.
- Simulating Strict Mode's double mount (calling the mount effect twice) is idempotent: the second run's result is dropped, no duplicate photos, no duplicate `File` instances for the same photo id.
- A mutation's write, triggered after restore starts but before it resolves, is not clobbered by the restore's later `hydratePhotos` call.
- A `QuotaExceededError` on one photo's write sets `storageWarning` and leaves the rest of the batch's writes and the in-memory state unaffected.
- A restored record's reconstructed `File` has the original `filename` and `type` (covers `batchUpdateNames`'s dependency on `file.name`).
- A `reorderPhotos` call triggers a persistence write of the updated `uploadIndex` values (covers KTD10's drag-order-survives-reload guarantee).
- `clearAllPersisted` empties the IndexedDB store and resolves cleanly even if called while a restore is still in flight.

**Verification:** `npm run test -- hooks/usePhotoPersistence`, `npm run lint`.

---

### U5. Wire persistence into `PhotoUploadPage`

**Goal:** connect U4 to the UI: a loading state and disabled controls during restore, a "Clear all" button doing the full reset, and a storage-warning banner.

**Requirements:** R2, R3, R4, R5, R9, R10

**Dependencies:** U4, U3

**Files:**
- `components/PhotoUploadPage.tsx`
- `components/PhotoUploadPage.test.tsx`

**Approach:**
- Instantiate `usePhotoPersistence` alongside the existing `usePhotos()`/`useObjectUrls()` calls.
- While `isRestoring`, render inline loading text (matching the existing `useGooglePhotosPicker` status-text convention) and disable upload, import, and "Clear all" controls (KTD2).
- Add a "Clear all" button whose handler performs the comprehensive reset: `usePhotoPersistence`'s `clearAllPersisted`, `usePhotos`'s equivalent clear, `useObjectUrls`' revoke-all, and `useGooglePhotosUpload`'s `reset()` (KTD9).
- Extend the existing `handleBatchDelete` wrapper (KTD13) to also call U4's `deletePhotoPersisted` and U3's `notifyPhotoRemoved`, rather than adding a second delete call site.
- Render `storageWarning` as an inline banner matching `GooglePhotosUploadPanel.tsx`'s existing styling convention (conditional `<div>`, no new toast component).

**Test scenarios:**
- While `isRestoring` is true, upload/import/Clear-all controls are disabled and loading text renders.
- "Clear all" empties the visible photo grid and triggers all four reset calls (IndexedDB, in-memory photos, object URLs, upload tracking).
- Deleting a photo still releases its object URL (regression against the prior documented bug) and now also calls `deletePhotoPersisted` and `notifyPhotoRemoved`.
- `storageWarning` set renders the banner; unset renders nothing.
- The similarity slider, clustering results, and scroll/selection state are unaffected by a restore or a "Clear all" (confirms R9's negative scope).

**Verification:** `npm run test -- components/PhotoUploadPage`, `npm run lint`, `npm run build`.

---

## Verification Contract

| Gate | Command | Applies to |
|---|---|---|
| Unit tests | `npm run test` | All units — run the full suite after each unit, not only the final one, since U2-U5 touch shared hooks (`docs/solutions/workflow-issues/conflict-markers-dont-catch-cross-branch-collateral-damage.md` documents that a shared-hook change can silently break a consumer's mock even when its own tests pass). |
| Lint | `npm run lint` | All units |
| Build | `npm run build` | U5 (touches a client component tree; confirms no SSR/hydration break from the new client-only IndexedDB access) |
| Manual smoke | Reload the app mid-batch in a real browser; confirm photos, thumbnails, and an uploaded photo's Google Photos status all survive | After U5, before calling the plan done |

## Definition of Done

- All five units implemented; `npm run test`, `npm run lint`, and `npm run build` pass at the repo root.
- Every test scenario listed under each unit exists and passes, not just a happy-path subset.
- No dangling references to abandoned approaches (e.g. a discarded IndexedDB wrapper attempt) remain in the diff.
- A manual reload-mid-batch smoke test (see Verification Contract) has been performed at least once in a real browser, not only under `vitest`'s jsdom environment, since jsdom does not implement IndexedDB natively and the persistence layer is stubbed in unit tests.

---

## System-Wide Impact

This plan moves photo state from ephemeral to durable across the app's three core photo-state hooks: `usePhotos`, `useGooglePhotosUpload`, and `useObjectUrls`. Two consequences follow for future work:

- Any future mutator added to `usePhotos` must write through U4's persistence path (`persistPhoto`/`deletePhotoPersisted`), or that mutation will silently revert on the next reload. This is the same class of risk KTD13 addresses for deletion specifically, generalized to any future mutator.
- `useGooglePhotosUpload`'s `photoStates` shape gains a durable dependent (U1's IndexedDB schema, via `mediaItemId`). A future change to that shape needs a corresponding schema-version bump (U1's `onupgradeneeded`), not just a type change.

No auth, payment, or security boundary is touched. `photo-tidy-api` is unaffected — communication stays HTTP-only per the workspace's architecture rules.

---

## Risks & Dependencies

- **Safari IndexedDB Blob-storage stability.** WebKit's serious IndexedDB instability was only fixed as of March 2026 (per research); users on older cached Safari builds may still hit write failures. KTD6's per-photo quota handling also catches non-quota write failures gracefully, which mitigates this.
- **Safari private-mode near-zero quota.** A write in Safari private browsing can throw immediately. KTD6's per-photo failure handling covers this without a dedicated detection path.
- **No new dependency (KTD1) shifts maintenance onto this repo.** The hand-rolled wrapper is intentionally narrow (five operations); if the schema grows materially more complex later, revisit `idb`.

## Sources & Research

- `hooks/usePhotos.ts`, `hooks/useGooglePhotosUpload.ts`, `hooks/useObjectUrls.ts`, `components/PhotoUploadPage.tsx`, `lib/generate-thumbnail.ts` — current architecture this plan extends.
- `docs/solutions/logic-errors/cluster-view-delete-missing-object-url-release-and-selection-cleanup.md` — precedent for KTD13's single-delete-path decision.
- `docs/solutions/logic-errors/stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md` — precedent for KTD4's generation-token approach.
- `docs/solutions/integration-issues/google-photos-json-parse-failure-returns-200.md` — precedent against laundering a storage failure into a fallback value that looks like success (informs U1/U4's explicit quota-error handling).
- `docs/solutions/workflow-issues/conflict-markers-dont-catch-cross-branch-collateral-damage.md` — informs the Verification Contract's per-unit full-suite gate.
- MDN `IDBObjectStore.put()`, `StorageManager.estimate()`, `StorageManager.persist()` — confirm Blob storage, quota estimation, and persistent-storage APIs are current and unprefixed as of 2026.
- Dexie's IndexedDB-on-Safari tracking doc — basis for the Safari-stability risk note.
