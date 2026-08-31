---
title: Download All Photos as a Single ZIP - Plan
type: feat
date: 2026-08-31
deepened: 2026-08-31
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Download All Photos as a Single ZIP - Plan

**Target repo:** photo-tidy-web

## Goal Capsule

- **Objective:** replace the current "Download all" button's per-photo download loop with a single client-side ZIP build, so one click produces one downloaded file instead of one browser download prompt per photo.
- **Authority hierarchy:** this Planning Contract's Key Technical Decisions govern implementation mechanism; Product Contract Requirements govern product behavior; a unit's Approach never overrides either.
- **Execution profile:** standard `ce-work`/`/goal` execution — two dependency-ordered units.
- **Stop conditions:** a unit's test scenarios fail after a genuine attempt, or an implementation discovery contradicts a KTD's premise — surface as a blocker rather than guessing.
- **Tail ownership:** the implementer runs the Verification Contract gates and satisfies Definition of Done; this plan does not choose a PR/landing strategy — follow repo convention.

---

## Product Contract

### Summary

Replace `lib/download.ts`'s per-photo `downloadAll` loop with a single ZIP build. The ZIP contains every currently-loaded photo, in the same order the grid displays them, under their current (possibly renamed) filenames, with EXIF and ZIP-entry timestamps reflecting any edited capture date. The ZIP filename comes from the existing Google Photos album-name field when set, else a dated default. A progress indicator covers the build.

### Problem Frame

Today's "Download all" (`components/PhotoUploadPage.tsx:571`, wired to `lib/download.ts`'s `downloadAll`) loops over every photo and triggers one browser download per photo, 60ms apart. For any real batch this means dozens of separate download prompts landing in the user's downloads folder as loose files, with no single artifact representing "this batch." A single ZIP is one file, one download prompt, and preserves the batch as a unit.

### Requirements

**ZIP build**
- R1. A single "Download all" action produces exactly one ZIP file containing every currently-loaded photo, replacing the current per-photo download loop. This holds even for a photo added after the grid's visual order last resynced.
- R2. Each photo enters the ZIP under its current (possibly renamed) filename, with its EXIF timestamp rewritten to its current captured-at value (reusing the existing per-photo EXIF-write behavior) and its ZIP-entry file-modified date also set to that same captured-at value.
- R3. Two photos that would produce the same in-ZIP filename are distinguished automatically so neither overwrites the other inside the archive.

**Ordering and naming**
- R4. Photos appear in the ZIP in the same order the grid currently displays them (cluster-aware visual order), not flat upload order.
- R5. The ZIP's own filename is the trimmed, filesystem-safe value of the existing Google Photos album-name field when non-empty, else `photo-tidy-export-<today's date, YYYY-MM-DD>.zip`.

**Progress and UX**
- R6. A progress indicator is visible for the duration of the ZIP build, and the "Download all" button is disabled while a build is in progress.
- R7. No separate individual-photo download UI is added; "Download all" fully replaces today's per-photo-download-loop button.

### Scope Boundaries

- Unchanged: `photo-tidy-api/`, persistence, clustering, grid rendering and layout, and any partial/selection-based export (only "download everything currently loaded" is in scope).
- `lib/download.ts`'s current `downloadAll` and `downloadPhoto` exports are removed as dead code once the new ZIP flow replaces their only caller (the "Download all" button); `triggerDownload` is kept and reused to deliver the single ZIP `Blob`.

---

## Planning Contract

### Key Technical Decisions

- KTD1. **ZIP library: `client-zip`.** Store-only by default (no compression config needed for already-compressed JPEGs), smallest maintained bundle among viable options (~2.6kB gzipped), and native per-entry `lastModified` support for R2. Chosen over `fflate` (needs an explicit `level: 0` per entry and worker-offload machinery this app doesn't need for a store-only build) and `jszip` (no npm release in ~4 years, no worker/offload path, would block the main thread hardest of the three).
- KTD2. **ZIP entry order is read from `PhotoUploadPage.tsx`'s existing `visualOrder` state**, mapped through the existing `photosById` lookup — not the flat `photos` array the current `downloadAll(photos)` call passes today. *(session-settled: user-approved — chosen over the flat `photos` array: user confirmed this ordering call-out during Phase 0.7 scoping.)*
- KTD3. **ZIP filename is derived from the existing `albumName` state** (trimmed, with filesystem-unsafe characters `/ \ : * ? " < > |` replaced by `-`), falling back to `photo-tidy-export-<date, YYYY-MM-DD>.zip` when empty, rather than adding a dedicated export-name field. ISO date format matches this document's own frontmatter convention; sanitization matters because a Google Photos album title is free text and can legally contain path-meaningful characters that would otherwise mangle or break the downloaded filename. *(session-settled: user-approved — chosen over a new dedicated field: confirmed during Phase 0.7 scoping.)*
- KTD4. **`downloadAll` and `downloadPhoto` are deleted** once the new ZIP flow replaces their only caller; no individual-photo download button is added. `triggerDownload` is kept and reused for the single ZIP download. *(session-settled: user-approved — confirmed during Phase 0.7 scoping that no separate individual-download UI would be added.)*
- KTD5. **Filename collisions inside the ZIP are resolved by appending a numeric suffix before the extension** to the second and later occurrence of a duplicate name (`photo (2).jpg`, `photo (3).jpg`, ...), leaving the first occurrence unchanged. Chosen over silently overwriting (loses a photo from the export) or failing the whole build (a filename collision from user-editable names is not an error state).
- KTD6. **Progress mirrors `GooglePhotosUploadPanel`'s existing `Uploading {doneCount} of {total}…` convention**: a count updates as each photo's EXIF rewrite resolves, and the button is disabled for the duration, consistent with this component's existing `isRestoring`-disables-the-trigger pattern.
- KTD7. **A ZIP-build failure is caught and surfaced as a dismissible warning**, styled like `usePhotoPersistence`'s existing `storageWarning` banner, re-enabling the button — never an uncaught rejection or a silent no-op. This includes a single entry's `writeTimestamp` throwing mid-batch: the build aborts as a whole (no partial ZIP, no skip-and-continue) and the warning is generic ("Couldn't build the ZIP — try again"), not per-photo. Chosen over skip-and-continue or per-entry retry as disproportionate complexity for this project's scale; a whole-batch retry is cheap since the batch is already in memory.
- KTD8. **`buildPhotoZipBlob` streams entries to `client-zip` via an async generator** (running `writeTimestamp` and yielding one resolved entry at a time) instead of resolving all N entries into an array before calling `downloadZip`. `client-zip` accepts an async iterable natively, so this costs no extra complexity and caps peak memory at roughly "original `File`s + the final combined zip `Blob`" instead of also holding all N rewritten `Blob`s in an array simultaneously — material at a couple hundred multi-MB photos.
- KTD9. **U2's handler reconciles `visualOrder` against `photosById` before building ZIP entries**, appending any photo id present in `photosById` but absent from `visualOrder` (ordered by `uploadIndex`), instead of using `visualOrder` as-is. `visualOrder` resolves through an async, debounced re-cluster call, so a photo can land in `photos`/`photosById` before the grid's visual order has caught up to include it; without reconciliation, clicking "Download all" in that window would silently export fewer photos than R1 promises.
- KTD10. **Photo edits (rename, delete, reorder) are not locked while a ZIP build is in progress.** The entry list is snapshotted once, at click time (KTD2, KTD9); the build proceeds against that snapshot regardless of edits made afterward. Chosen over locking other controls during the build as disproportionate complexity for a single-user, personal-project-scale feature; a mid-build edit landing on the next export is an acceptable, low-stakes outcome here.

### Sources & Research

- `lib/download.ts` (40 lines): current `triggerDownload`/`downloadPhoto`/`downloadAll` shapes, confirmed unchanged from this plan's premise except `downloadAll`/`downloadPhoto` being removed (KTD4).
- `lib/exif-write.ts:45`: `writeTimestamp(file: File, newDate: Date): Promise<Blob>` — reused as-is per entry; PNG/TIFF pass through unchanged (no writable EXIF format) but still get a ZIP-entry `lastModified` set from `capturedAt` (R2).
- `hooks/usePhotos.ts:7-15`: `PhotoEntry` fields (`id`, `file`, `filename`, `capturedAt`, `uploadIndex`, `source`, `mediaItemId?`) — `filename`/`capturedAt` are already the final, edited values; nothing else to merge in.
- `components/PhotoUploadPage.tsx:115,120-140`: `visualOrder` is `useState<string[]>([])`, kept in sync via `handleVisualOrderChange` with a content-equality guard, already in scope at the button's render site — no extra threading needed (KTD2).
- `components/PhotoUploadPage.tsx:92`: `albumName` is unconditionally mounted top-level state, safely readable regardless of Google Photos connection state (KTD3).
- `components/GooglePhotosUploadPanel.tsx:88-92`: `Uploading {doneCount} of {photos.length}…` progress-count convention (KTD6).
- `docs/solutions/logic-errors/cluster-drag-timestamp-visual-order-divergence.md`: origin of `visualOrder`; documents why flat-array order and visual order diverge and why ordering must read `visualOrder`, not `photos` (KTD2). `components/PhotoUploadPage.test.tsx` already has a divergent-cluster regression fixture for this same distinction, usable as a template for U2's ordering test.
- `docs/solutions/logic-errors/stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md`: generation-token/async-guard pattern; not adopted here since this is a single manually-triggered action, not concurrent-hook-invocation-prone — a simple `isGeneratingZip`-style disabled state (KTD6) is sufficient.
- Client-side ZIP library landscape (web research, Aug 2026): `client-zip` (~2.6kB gz, store-only default, native `lastModified`, ~398 GitHub stars, last release ~1yr old but stable) vs. `fflate` (~16.4M weekly downloads, Worker-backed async API, needs explicit `level: 0` for store-only) vs. `jszip` (no release in ~4yrs, no Worker path, community steering new projects away). Informs KTD1.

---

## Risks & Dependencies

- **Large-batch build time and UI responsiveness in Chrome.** External research flagged that stream-based zip libraries like `client-zip` show more overhead in Chrome than Safari (WHATWG Streams cost). At this feature's data volume (store-only, no compression, hundreds of MB total), worst case should still land in single-digit-to-tens-of-seconds, not minutes — `writeTimestamp` patches JPEG EXIF bytes directly via `piexif-ts` (no full image decode/re-encode), so the sequential per-photo loop's total cost stays low. Mitigation: a manual acceptance check (see Definition of Done) rather than a design change.
- **Peak memory during the build scales with batch size.** Holding all N rewritten `Blob`s in an array simultaneously, on top of the original `File`s and the final combined zip `Blob`, could reach roughly 3x the photo set's total byte size — a real concern on memory-constrained mobile browsers at a couple hundred multi-MB photos, even if comfortable on desktop. Mitigation: KTD8's generator-streaming approach removes the "N rewritten blobs held in an array" tier entirely.
- **`client-zip` is a small-adoption, low-churn dependency** (~398 GitHub stars, ~98K weekly downloads, latest release ~1 year old — not abandoned, just infrequently updated). Mitigation: if a real defect surfaces, `fflate` is the documented fallback (KTD1); no abstraction layer is warranted at this project's scale.

---

## Implementation Units

### U1. ZIP-building core in `lib/download.ts`

**Goal:** add the `client-zip` dependency and a `buildPhotoZipBlob` utility that turns an ordered list of photo entries into one ZIP `Blob`, reusing the existing per-photo EXIF rewrite; remove the now-dead `downloadAll`/`downloadPhoto`.

**Requirements:** R1, R2, R3; KTD1, KTD4, KTD5, KTD8

**Dependencies:** none

**Files:**
- `package.json`
- `lib/download.ts`
- `lib/download.test.ts`

**Approach:**
- Add `client-zip` as a dependency.
- Add `buildPhotoZipBlob(entries: PhotoEntry[], onProgress?: (done: number, total: number) => void): Promise<Blob>` to `lib/download.ts`, backed by an async generator rather than a pre-resolved array (KTD8). In the given order (caller's responsibility — this function does not re-sort): for each entry, `await writeTimestamp(entry.file, entry.capturedAt ?? new Date())`; resolve a de-duplicated in-zip name (KTD5); call `onProgress` after each entry resolves; yield `{name, lastModified: entry.capturedAt ?? new Date(), input: <resolved blob>}` to `client-zip`'s `downloadZip(...)`, which accepts the async iterable directly; await `.blob()` for the final result.
- Remove `downloadAll` and `downloadPhoto` and their `describe` blocks from `lib/download.test.ts`; `triggerDownload` and its tests are unchanged.

**Patterns to follow:** `lib/download.test.ts`'s existing mocking style — `vi.mock('./exif-write', ...)` for `writeTimestamp`, `vi.stubGlobal('URL', ...)` for `createObjectURL`/`revokeObjectURL`.

**Test scenarios:**
- Builds a `Blob` from N entries, calling `writeTimestamp` in the exact given order (assert call order via the mock).
- Two entries sharing the same `filename` are de-duplicated: the first keeps its original name, the second gets a `(2)`-suffixed name before the extension.
- A `capturedAt: null` entry falls back to `new Date()` for both the EXIF-write call and the ZIP-entry `lastModified`, matching current `downloadPhoto` behavior.
- A non-JPEG (`image/png`) entry still gets its ZIP-entry `lastModified` set from `capturedAt`, even though `writeTimestamp` returns its bytes unchanged.
- `onProgress` is called once per resolved entry with an increasing `done` and a constant `total` equal to the entry count.
- `lib/download.ts` no longer exports `downloadAll` or `downloadPhoto`; `triggerDownload`'s existing test scenarios are unchanged.

**Verification:** `npm run test -- lib/download`, `npm run lint`, `npm run build`.

---

### U2. Wire the button, ordering, filename, and progress UI

**Goal:** replace `components/PhotoUploadPage.tsx`'s `onClick={() => downloadAll(photos)}` with a handler that builds ZIP entries from `visualOrder`, derives the ZIP filename, shows build progress, and surfaces failures.

**Requirements:** R1, R4, R5, R6, R7; KTD2, KTD3, KTD6, KTD7, KTD9, KTD10

**Dependencies:** U1

**Files:**
- `components/PhotoUploadPage.tsx`
- `components/PhotoUploadPage.test.tsx`

**Approach:**
- New handler maps `visualOrder` through `photosById` (filtering any miss), then appends any `photosById` entry not already included, ordered by `uploadIndex`, to build the ordered `PhotoEntry[]` passed to `buildPhotoZipBlob` (KTD2, KTD9).
- ZIP filename: sanitize `albumName.trim()` (replace `/ \ : * ? " < > |` with `-`) when non-empty, else `photo-tidy-export-${<today's date, YYYY-MM-DD>}.zip` (KTD3), matching the existing `albumName.trim() === ''` idiom already used in `GooglePhotosUploadPanel.tsx`.
- Local `isGeneratingZip`/`doneCount` state: disable the "Download all" button (and keep it disabled while `isRestoring`, matching "Clear all"), show a `Zipping {doneCount} of {total}…`-style line while `isGeneratingZip`, wired as `buildPhotoZipBlob`'s `onProgress` callback (KTD6).
- On success: `triggerDownload(blob, zipFilename)`, clear generating state.
- On failure: catch, show a dismissible warning styled like `usePhotoPersistence`'s `storageWarning`, clear generating state so the button re-enables (KTD7).

**Patterns to follow:** `usePhotoPersistence`'s `isRestoring`/`storageWarning` render pattern (`components/PhotoUploadPage.tsx:388-398`); `GooglePhotosUploadPanel`'s `Uploading {doneCount} of {photos.length}…` progress line; the "Clear all" button test block in `components/PhotoUploadPage.test.tsx` for the click-and-assert shape.

**Test scenarios:**
- Clicking "Download all" builds the ZIP from `visualOrder`-ordered entries, not `photos` array order — using a divergent-cluster fixture (mirroring this test file's existing visual-order-vs-flat-array regression pattern), assert the entries passed to the ZIP builder follow `visualOrder`.
- A photo present in `photosById` but not yet in `visualOrder` (simulating a pending re-cluster) is still included in the ZIP, appended in `uploadIndex` order (KTD9).
- Renamed and timestamp-edited photos pass their current (edited) `filename`/`capturedAt`, not their original values.
- ZIP filename uses the trimmed, sanitized `albumName` when it is non-empty, including a case where `albumName` contains a filesystem-unsafe character (e.g. `/`).
- ZIP filename falls back to `photo-tidy-export-<today, YYYY-MM-DD>.zip` when `albumName` is empty or whitespace-only.
- The button is disabled and a progress count is visible while generation is in progress, and both clear once the download triggers.
- The button is disabled while `isRestoring`, matching "Clear all".
- A rejected ZIP build shows a dismissible warning message and re-enables the button, rather than throwing uncaught or failing silently.
- One entry's `writeTimestamp` rejecting mid-batch (e.g. entry 3 of 5) aborts the whole build with the same generic warning — no partial ZIP is delivered, and the remaining entries are never processed (KTD7).

**Verification:** `npm run test -- components/PhotoUploadPage`, `npm run lint`, `npm run build`.

---

## Verification Contract

| Command | Applies to |
|---|---|
| `npm run test -- lib/download` | U1 |
| `npm run test -- components/PhotoUploadPage` | U2 |
| `npm run lint` | U1, U2 |
| `npm run build` | U1, U2 |
| `npm run test` (full suite) | Before ship — confirms no regression outside the touched files |

## Definition of Done

- All Requirements (R1-R7) are satisfied and traceable to a unit.
- `npm run test`, `npm run lint`, and `npm run build` pass clean.
- `downloadAll`/`downloadPhoto` no longer exist in `lib/download.ts` or its test file; no dead exports remain.
- Manually verified build time and UI responsiveness on a ~100-150 photo batch in Chrome (the browser research flagged for stream-overhead) is acceptable — single-digit-to-tens-of-seconds, no unresponsive tab.
- No changes outside `photo-tidy-web/`.
