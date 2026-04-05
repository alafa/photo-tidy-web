---
title: "feat: Photo Upload & EXIF Display"
type: feat
status: completed
date: 2026-04-05
origin: docs/brainstorms/2026-04-05-photo-upload-display-requirements.md
---

# feat: Photo Upload & EXIF Display

## Overview

Scaffold the Next.js project and build the core photo-upload-and-display flow: users select image files, the app reads EXIF timestamps client-side, and displays photos in a grid sorted oldest-first with filename and date beneath each photo.

## Problem Frame

Users want to see a set of photos arranged by when they were taken without any manual sorting. All EXIF parsing, sorting, and display happens in the browser; no server upload or persistence. (see origin: docs/brainstorms/2026-04-05-photo-upload-display-requirements.md)

## Requirements Trace

- R1. User can select one or more image files via a file input.
- R2. Accepted display formats: JPEG, PNG, TIFF. HEIC is excluded from the file input's `accept` attribute — `exifr` can read HEIC EXIF metadata, but browsers cannot display HEIC images without extra decoding steps.
- R3. Read `DateTimeOriginal` EXIF tag client-side.
- R4. Fallback chain: `DateTimeOriginal` → `DateTimeDigitized` → `DateTime`.
- R5. Display ascending by timestamp; upload order as tiebreaker for equal timestamps.
- R6. Photos with no parseable timestamp sort last.
- R7. Show filename and formatted date ("Jan 3, 2025 14:32") — no timezone conversion.
- R8. Show "No date" when timestamp is absent.

## Scope Boundaries

- No server upload or persistence.
- No drag & drop reordering (separate feature).
- HEIC excluded from file input — cannot display in browsers without extra decode; out of scope for this feature.
- No virtualization — adequate for MVP; reconsider if file count regularly exceeds 100.

## Context & Research

### Relevant Code and Patterns

- Repo is unscaffolded — first step is `create-next-app`.
- CLAUDE.md: Next.js App Router, all processing browser-side, no server storage.

### External References

- `exifr` v7.x — async, TypeScript, accepts `File` directly, reads HEIC metadata, ~9 kB lite build. `pick` option limits parsing to requested tags only.
- `URL.createObjectURL` for image display; `URL.revokeObjectURL` on cleanup (not `FileReader.readAsDataURL` — 33% size overhead).
- Next.js `<Image>` does not support `blob:` URLs — use plain `<img loading="lazy">`.
- Single `'use client'` at the client-component entry point; page route stays a Server Component.

## Key Technical Decisions

- **`exifr` over `exif-js` / `piexifjs`**: `exif-js` is abandoned (no updates since 2019), `piexifjs` is write-focused and also unmaintained. `exifr` is actively maintained (August 2025 release), has direct `File` API, TypeScript types, and best performance.
- **Plain `<img>` over Next.js `<Image>`**: Next.js image optimization pipeline cannot fetch `blob:` URLs. Using `<img loading="lazy">` achieves the same lazy-loading without the mismatch.
- **Sort at set-time**: The sorted `PhotoEntry[]` array is sorted once when `setPhotos` is called, not on every render. No derived-state re-sort.
- **Object URL hook**: A `useObjectUrls` hook creates URLs lazily and revokes all of them on cleanup, preventing memory leaks across re-renders.
- **HEIC display out of scope**: `exifr` reads HEIC metadata natively, but browsers cannot render HEIC images without `heic2any` or similar. Accepted formats for display: JPEG, PNG, TIFF.

## Open Questions

### Resolved During Planning

- **Which EXIF library?** → `exifr`. Clear winner on maintenance, API ergonomics, TypeScript, performance.
- **HEIC support?** → EXIF reading: yes. Image display: no. Accept types attribute on file input will exclude HEIC to avoid user confusion.
- **`<Image>` vs `<img>`?** → `<img loading="lazy">` — blob URLs are incompatible with Next.js image optimizer.

### Deferred to Implementation

- **Maximum practical file count**: no hard limit at plan time; add a warning or batching if users regularly exceed 100 files, per CLAUDE.md guidance.
- **EXIF parsing concurrency**: parse in small batches (5–10) via `for...of` rather than `Promise.all` over all files, to avoid main-thread blocking. Exact batch size determined during implementation.
- **PNG EXIF reliability**: PNG EXIF is optional and commonly absent. Document behavior (treat as no-date) via test scenarios.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
app/page.tsx (Server Component)
  └─ <PhotoUploadPage> ('use client')
       ├─ <input type="file" multiple accept="image/jpeg,image/png,image/tiff">
       │     onChange → processFiles(FileList)
       │                  ├─ exifr.parse(file, { pick: [DateTimeOriginal, ...] })
       │                  ├─ sort PhotoEntry[] ascending by capturedAt (nulls last)
       │                  └─ setPhotos(sorted)
       └─ <PhotoGrid photos={photos}>
            └─ <PhotoCard> × N
                 ├─ <img src={useObjectUrls()(file)} loading="lazy">
                 ├─ <p>{filename}</p>
                 └─ <p>{capturedAt ? format(capturedAt) : "No date"}</p>
```

**State shape:**
```ts
type PhotoEntry = {
  file: File
  filename: string
  capturedAt: Date | null
  uploadIndex: number   // original position in FileList, used as sort tiebreaker
}
```

Object URLs are not stored in state — they are derived on demand by `useObjectUrls` and cleaned up via `useEffect`.

## Implementation Units

- [ ] **Unit 1: Project Scaffolding**

**Goal:** Initialize the Next.js project with TypeScript, install `exifr`, and establish the basic app directory structure.

**Requirements:** Prerequisite for all other units.

**Dependencies:** None.

**Files:**
- Create: `package.json` (via `create-next-app`)
- Create: `app/layout.tsx`
- Create: `app/page.tsx`
- Create: `app/globals.css`

**Approach:**
- Run `create-next-app` with TypeScript, Tailwind CSS, App Router, and `src/` directory disabled (flat `app/` layout as per Next.js default).
- Install `exifr` as a production dependency.
- Confirm `npm run dev`, `npm run build`, and `npm run lint` commands work per CLAUDE.md.

**Test expectation: none** — scaffolding only, no behavioral change.

**Verification:**
- `npm run dev` starts without error.
- `npm run build` succeeds.
- `exifr` appears in `package.json` dependencies.

---

- [ ] **Unit 2: EXIF Reading Utility**

**Goal:** Implement a typed async function that extracts a capture timestamp from a browser `File` object using `exifr`, applying the R3/R4 fallback chain.

**Requirements:** R3, R4.

**Dependencies:** Unit 1.

**Files:**
- Create: `lib/exif.ts`
- Test: `lib/exif.test.ts`

**Approach:**
- Use `exifr.parse(file, { pick: ['DateTimeOriginal', 'DateTimeDigitized', 'DateTime'] })`.
- Apply fallback chain: `DateTimeOriginal` → `DateTimeDigitized` → `DateTime`.
- Return `Date | null`. Wrap in `try/catch`; return `null` on any parse error or absent tags.
- By default, `exifr` parses date fields into JS `Date` objects (`reviveValues: true` is the default). Do not pass `{ reviveValues: false }` — this would return raw EXIF strings requiring manual parsing. Verify this behavior holds for the chosen import path (full vs lite build).

**Test scenarios:**
- Happy path: JPEG with `DateTimeOriginal` → returns correct `Date`.
- Fallback: JPEG with only `DateTimeDigitized` (no `DateTimeOriginal`) → returns `DateTimeDigitized` value.
- Fallback: JPEG with only `DateTime` → returns `DateTime` value.
- No EXIF: PNG with no EXIF chunk → returns `null`.
- Corrupt EXIF: file with malformed EXIF segment → returns `null` (no throw).
- Non-image file (e.g., a text file with `.jpg` extension) → returns `null`.

**Verification:**
- All test scenarios pass.
- Function is typed `(file: File) => Promise<Date | null>`.

---

- [ ] **Unit 3: Photo State and Sorting Hook**

**Goal:** Implement a `usePhotos` hook that takes a `FileList`, reads EXIF for each file, builds a sorted `PhotoEntry[]`, and exposes it for rendering.

**Requirements:** R1, R5, R6.

**Dependencies:** Unit 2.

**Files:**
- Create: `hooks/usePhotos.ts`
- Create: `hooks/useObjectUrls.ts`
- Test: `hooks/usePhotos.test.ts`

**Approach:**
- `usePhotos` returns `{ photos, processFiles }` where `processFiles(FileList)` is called on file input change.
- Process files sequentially (or in small batches) to avoid blocking the main thread.
- Sort `PhotoEntry[]` ascending by `capturedAt` (nulls last); use `uploadIndex` as tiebreaker for equal timestamps.
- `useObjectUrls` exposes a getter function `getUrl(file: File) => string` backed by a `Map<File, string>`. URLs are created lazily on first call per file; calling with the same `File` reference returns the cached URL. All URLs are revoked in the `useEffect` cleanup on unmount.

**Test scenarios:**
- Happy path: three files with distinct timestamps → sorted oldest-first.
- Tiebreaker: two files with identical timestamps → sorted by original upload order.
- Mixed: files with and without EXIF → timestamped files first, no-date files at end.
- All no-date: multiple files with no EXIF → order preserved from upload (all at end, tiebreaker applies).
- Empty input: `processFiles` called with empty `FileList` → `photos` is empty array.
- `useObjectUrls`: calling with the same file twice returns the same URL (no duplicate creation).
- `useObjectUrls`: cleanup revokes all created URLs on unmount.

**Verification:**
- All test scenarios pass.
- `photos` array is never mutated in place — always a new sorted array.

---

- [ ] **Unit 4: PhotoCard and PhotoGrid Components**

**Goal:** Implement the UI components that display a single photo with its metadata, and arrange all photos in a responsive grid.

**Requirements:** R5, R7, R8.

**Dependencies:** Unit 3.

**Files:**
- Create: `components/PhotoCard.tsx`
- Create: `components/PhotoGrid.tsx`
- Test: `components/PhotoCard.test.tsx`

**Approach:**
- `PhotoCard` receives `{ file, filename, capturedAt, objectUrl }`. Renders a plain `<img loading="lazy" src={objectUrl}>`, the filename, and the formatted date.
- Format `capturedAt` as "Jan 3, 2025 14:32". EXIF timestamps have no embedded timezone. `exifr` parses them as local clock time (no UTC offset applied). Format using `Intl.DateTimeFormat` with `timeZone: 'UTC'` after normalizing — or format the raw date components directly — to prevent the browser's local timezone from shifting the displayed time. Verify with a known timestamp in tests.
- When `capturedAt` is null, render "No date".
- `PhotoGrid` maps `photos` to `<PhotoCard>` components. Responsive grid layout via Tailwind CSS (`grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4`).
- Use `file.name + file.lastModified + uploadIndex` as the React `key` (not array index) — the `uploadIndex` tiebreaker handles duplicate names with identical timestamps.

**Test scenarios:**
- Happy path: renders filename and formatted date correctly for a photo with a valid `capturedAt`.
- No date: renders "No date" when `capturedAt` is null.
- Date format: "Jan 3, 2025 14:32" — month abbreviated, no seconds, no timezone suffix.
- Grid: renders the correct number of `PhotoCard` elements for a given photos array.
- Key stability: re-rendering with same photos array does not cause unnecessary remounts.

**Verification:**
- Correct date format rendered for a known timestamp.
- "No date" renders for null `capturedAt`.
- No Next.js `<Image>` component used anywhere in these files.

---

- [ ] **Unit 5: Upload Page Integration**

**Goal:** Wire file input, EXIF processing, and photo grid into a single client component, served from the root route.

**Requirements:** R1, R2, R6 (all requirements come together here).

**Dependencies:** Units 3, 4.

**Files:**
- Modify: `app/page.tsx` (add import of `PhotoUploadPage`)
- Create: `components/PhotoUploadPage.tsx`
- Test: `components/PhotoUploadPage.test.tsx`

**Approach:**
- `PhotoUploadPage` is the `'use client'` boundary. `app/page.tsx` remains a Server Component that only renders `<PhotoUploadPage />`.
- File input: `accept="image/jpeg,image/png,image/tiff"` (HEIC excluded from accept to avoid user confusion about missing previews).
- `onChange` calls `processFiles` from `usePhotos`.
- While photos is empty, show an upload prompt; once populated, show the grid.
- Pass `getObjectUrl` from `useObjectUrls` into the grid, creating URLs at render time, not before.

**Test scenarios (integration):**
- Happy path: selecting 3 JPEG files triggers grid render with photos sorted by date.
- Mixed selection: JPEGs with and without EXIF → timestamped photos appear before no-date photos.
- Empty state: before any files selected, upload prompt is visible and grid is not rendered.
- Re-upload: selecting a new set of files replaces the previous grid entirely.

**Verification:**
- `app/page.tsx` has no `'use client'` directive.
- `PhotoUploadPage.tsx` has `'use client'` as its first line.
- Selecting files produces a rendered, sorted grid in the browser.

## System-Wide Impact

- **Interaction graph:** All logic is self-contained within the client component tree. No server actions, API routes, or callbacks triggered.
- **State lifecycle risks:** Object URLs leak if `revokeObjectURL` is not called. The `useObjectUrls` cleanup handles this; verify in testing by checking that URLs are revoked on unmount.
- **Unchanged invariants:** No server-side routes are added. `app/page.tsx` remains a Server Component.
- **Integration coverage:** End-to-end upload → sort → display is covered by Unit 5 integration tests; unit-level tests in Units 2–4 cover individual concerns.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `exifr` bundle size adds noticeable load time | Try lite build first (`exifr/dist/lite.esm.mjs`); confirm date tags are returned as `Date` objects (not raw strings) in the lite build before committing to it |
| EXIF parsing blocks main thread for large file batches | Process in sequential batches; consider Web Worker in a future iteration if user testing reveals jank |
| PNG files silently have no EXIF | Documented as expected behavior (return `null`); covered in Unit 2 test scenarios |
| Memory leak from un-revoked object URLs | `useObjectUrls` hook revokes on cleanup; covered in Unit 3 test scenarios |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-05-photo-upload-display-requirements.md](docs/brainstorms/2026-04-05-photo-upload-display-requirements.md)
- External: exifr — https://github.com/MikeKovarik/exifr
- External: URL.createObjectURL — https://developer.mozilla.org/en-US/docs/Web/API/URL/createObjectURL_static
- External: Next.js `<Image>` blob URL incompatibility — https://github.com/vercel/next.js/discussions/19732
- External: Next.js Client Components — https://nextjs.org/docs/app/getting-started/server-and-client-components
