---
title: "feat: Add Google Photos integration (import + upload)"
type: feat
status: active
date: 2026-04-06
origin: docs/brainstorms/2026-04-05-google-photos-integration-requirements.md
---

# feat: Add Google Photos integration (import + upload)

## Overview

Add the ability to import photos directly from a user's Google Photos library into the app's
editing grid, and to upload the modified copies back to Google Photos as new media items. Users
avoid manually downloading and re-uploading files. The integration uses:

- **Google Photos Picker API** for user-driven photo selection (not the deprecated Library API
  read scopes)
- **Google Photos Library API** with `photoslibrary.appendonly` for upload only
- **OAuth 2.0 Authorization Code + PKCE** via a popup, handled by a thin Next.js backend so
  the client secret stays server-side and grid state is never lost during re-auth
- **Transparent CORS-proxy API routes** for every call to `photospicker.googleapis.com` and
  `photoslibrary.googleapis.com` — no confirmed browser CORS support exists for either

All client secrets remain server-side. Access tokens are short-lived (~1 hour), stored in React
state only, never persisted.

## Problem Frame

See origin: `docs/brainstorms/2026-04-05-google-photos-integration-requirements.md`

Users must manually download photos from Google Photos, upload them into the app, then download
the modified copies and re-upload them to Google Photos. This breaks the workflow. The feature
removes every manual file-handling step.

## Requirements Trace

- R1–R6: OAuth authentication (popup PKCE flow, token in React state, expiry warning + re-auth
  without losing grid, signed-in indicator, sign-out)
- R7–R13: Google Photos import via Picker (import entry point alongside local upload, Picker
  widget via new tab, additive import, origin badge on cards, Picker error handling)
- R14–R20: Upload back to Google Photos (upload button shown when authenticated, uploads all
  grid photos, optional album name, progress, per-photo error + retry)
- R21: Existing local upload unchanged

## Scope Boundaries

- No replacing/updating existing photos in Google Photos — only new uploads
- No refresh tokens; access token session-only
- Minimal backend only: Next.js API routes for CORS proxy and token exchange; no database or
  server-side storage
- No Drive Picker (legacy); only the new Google Photos Picker API
- No Google Drive file support
- No bulk album management beyond creating one named destination
- No deep link to uploaded album in success message (API may not return a usable URL; fall
  back to text confirmation)
- Picker selection UI is Google's own — no custom photo browser

## Context & Research

### Relevant Code and Patterns

- `hooks/usePhotos.ts` — all photo state; `processFiles(fileList: FileList)` must be extended
  to accept `File[] | FileList`; a new `addPhotos(files: File[])` path is needed for additive
  Google Photos imports that skip the discard-edits confirmation guard
- `hooks/useObjectUrls.ts` — lazy `blob:` URL cache keyed by `File` reference; Google Photos
  images fetched and wrapped in `File` objects are fully compatible with this hook
- `lib/exif.ts` — reads `DateTimeOriginal → DateTimeDigitized → DateTime` via `exifr`; for
  Google Photos imports, `mediaMetadata.creationTime` from the API is already an ISO-8601
  timestamp — set `capturedAt` directly and skip `exifr.parse` for those photos
- `lib/exif-write.ts` — JPEG-only; returns original `File` unchanged for PNG/TIFF; this means
  non-JPEG photos upload without modified timestamps (documented behavior, acceptable for MVP)
- `lib/download.ts` — export-only; not changed
- `components/PhotoUploadPage.tsx` — top-level orchestrator; Google Photos UI elements live here
- `components/PhotoCard.tsx` — leaf card; needs an origin badge for Google Photos imports
- **Critical pattern** (`docs/solutions/best-practices/exif-timestamp-rewriting-…`): always use
  `slotTimestamp`, never `assignTimestamps`, after any reorder; Google Photos photos arrive with
  real timestamps that `assignTimestamps` would overwrite on first drag
- **Critical pattern** (`docs/solutions/best-practices/image-as-selection-target-…`): any
  clickable element inside a sortable card must call `e.stopPropagation()` on `pointerDown`
  (but never on the image wrapper itself)
- `PhotoEntry` type currently: `{ id, file: File, filename, capturedAt, uploadIndex }` — needs
  `source: 'local' | 'google-photos'` added

### Institutional Learnings

- `slotTimestamp` (not `assignTimestamps`) for post-import reordering — any reorder after Google
  Photos import must use this pattern (see `docs/solutions/best-practices/exif-…`)
- `onDrop` + `onDragOver` must always be paired; test new interactive surfaces separately from
  click-to-import (see `docs/solutions/ui-bugs/drag-and-drop-upload-missing-event-handlers-…`)
- dnd-kit cards: `stopPropagation` on `pointerDown` only for non-drag elements inside cards;
  never on the image wrapper (see `docs/solutions/best-practices/image-as-selection-target-…`)
- `processFiles` iterates `fileList[i]` / `fileList.length` — accepts `FileList` shape only;
  tests use a custom `makeFileList` shim to create a `FileList`-compatible object from `File[]`

### External References

- Google Photos Picker API scopes and session lifecycle: April 2025 breaking change removed
  `photoslibrary.readonly`; read access now requires `photospicker.mediaitems.readonly` only
- `baseUrl + "=d"` appended to Picker media item `baseUrl` fetches original file with full EXIF
  (minus GPS) — documented in Google's "access-media-items" guide
- GIS token model vs. manual PKCE: GIS code model does not support PKCE parameters;
  manual PKCE against `https://accounts.google.com/o/oauth2/v2/auth` is required for the
  popup/postMessage pattern
- Picker session lifecycle: `POST /v1/sessions` → redirect user to `pickerUri` (cannot be
  iframed) → poll `GET /v1/sessions/{id}` until `mediaItemsSet: true` → `GET /v1/mediaItems`
  → `DELETE /v1/sessions/{id}`
- Upload lifecycle: `POST /v1/uploads` (raw bytes, returns upload token) → `POST
  /v1/mediaItems:batchCreate` (up to 50 items per call, `albumId` optional)
- App-created Google Photos albums are visible in the main Google Photos UI (not "Apps"-only)
- Unverified apps: 100 test users cap; sensitive scope verification required for production

## Key Technical Decisions

- **Popup OAuth, not full redirect**: PKCE auth opens in a popup; the callback page sends
  `postMessage` to the opener and closes itself. This means the main app never navigates away
  and grid state is preserved across sign-in and re-authentication. Rationale: R2 requires
  re-auth without losing grid state; redirect flow would require serializing File objects which
  cannot be serialized to sessionStorage.

- **Manual PKCE, not GIS**: GIS `initCodeClient` does not accept PKCE parameters; GIS token
  model skips PKCE entirely. We build the authorization URL manually with `code_challenge` +
  `code_challenge_method=S256`, store the PKCE verifier in `sessionStorage` (survives same-tab
  use while the popup is open), and exchange server-side via `/api/google/auth/token`. This
  keeps `GOOGLE_CLIENT_SECRET` out of the browser bundle.

- **All Google API calls proxied via Next.js route handlers**: `photospicker.googleapis.com`
  and `photoslibrary.googleapis.com` have no documented CORS headers. Rather than test each
  endpoint at runtime, all calls go through `/api/google-photos/*` route handlers that forward
  the user's Bearer token and return Google's response. The same pattern handles photo downloads
  (`baseUrl + "=d"`) to avoid CORS on `lh3.googleusercontent.com`.

- **Additive imports (`addPhotos`) vs. replacing imports (`processFiles`)**: `processFiles`
  calls `sortPhotos` and resets `hasEdits`, and is gated by the discard-edits confirmation.
  Google Photos imports are additive — they append to the current grid. A new `addPhotos(files:
  File[])` method in `usePhotos` handles this without confirmation and without re-sorting the
  entire list (new photos insert sorted among existing ones).

- **Set `capturedAt` from Picker API metadata, not exifr**: `mediaMetadata.creationTime` is an
  ISO-8601 timestamp from Google's own database — more reliable than EXIF-from-CDN. Construct
  `PhotoEntry.capturedAt = new Date(item.mediaMetadata.creationTime)` directly for Google Photos
  imports and skip the `exifr.parse` call.

- **Upload scope covers the full grid**: "Upload to Google Photos" uploads all photos currently
  in the grid (both Google Photos imports and local uploads), not only the ones that came from
  Google Photos. Rationale: simpler UX and stated in R15; the origin badge (R13) makes clear
  which photos will be affected.

- **OAuth scopes requested at initial sign-in**: Both `photospicker.mediaitems.readonly` and
  `photoslibrary.appendonly` are requested together at first sign-in. Progressive consent would
  add complexity without significant benefit given that import and upload are both core to the
  feature's value.

## Open Questions

### Resolved During Planning

- **Which Picker API?** New Google Photos Picker API (`photospicker.googleapis.com`), not the
  legacy Drive Picker. The Drive Picker requires `drive.readonly` scope and returns Drive file
  IDs — a different data model that doesn't map to the Picker API's media items.
- **EXIF from CDN or API?** Use `mediaMetadata.creationTime` from the Picker API response for
  `capturedAt`. Fetch image bytes with `baseUrl + "=d"` for EXIF-preserved binary; the EXIF
  inside the file will still contain the original dates, and our EXIF-write pipeline re-stamps
  it anyway if the user reorders.
- **App-created albums visible in Google Photos UI?** Yes — confirmed via research.
  Albums created via `POST /v1/albums` appear in the standard Albums section of Google Photos.
- **Library root upload supported?** Yes — `albumId` is optional in `batchCreate`.
- **Scopes removed in April 2025**: `photoslibrary.readonly` is gone. We use
  `photospicker.mediaitems.readonly` for reading (Picker, user-driven) and
  `photoslibrary.appendonly` for writing. These are the correct current scopes.

### Deferred to Implementation

- **CORS on `lh3.googleusercontent.com`**: The plan routes all downloads server-side for safety.
  If testing shows the CDN serves CORS headers with a Bearer token, the download proxy can be
  removed for lower latency. Do not assume either way — test at integration time.
- **Exact poll interval handling**: Use the `pollingConfig.pollInterval` string from the session
  response (e.g. `"2s"`) and parse it at runtime. If the format is unexpected, fall back to 3
  seconds. Implement the timeout using `pollingConfig.timeoutIn` similarly.
- **Album creation vs. reuse on duplicate name**: Google Photos API creates a new album even if
  one with the same name already exists. The UI copy should set this expectation ("A new album
  will be created"). If the behavior changes, detect it at integration time.
- **Non-JPEG EXIF write**: `lib/exif-write.ts` returns PNG/TIFF unchanged. Uploaded non-JPEG
  photos will have the original EXIF (not the reordered timestamp). Document this as a known
  limitation; do not expand `writeTimestamp` scope in this plan.
- **Google Cloud OAuth app verification**: Required before public launch. 100 test-user cap
  applies during development. Verification (sensitive scope) requires domain verification, privacy
  policy, and a YouTube demo. This is an operational step outside the code plan.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not
> implementation specification. The implementing agent should treat it as context, not code to
> reproduce.*

### OAuth Popup Flow

```
Browser                    Popup                      /api/google/auth/*
─────────────────────────────────────────────────────────────────────────
[Sign In clicked]
  generatePKCE()
  store verifier in sessionStorage
  open popup(authUrl + code_challenge)
                           [Google OAuth consent]
                           [redirect to /api/google/auth/callback?code=...]
                                                      GET /callback
                                                      redirect to /google-auth-callback?code=...
                           [/google-auth-callback page]
                           postMessage({code, state})
                           window.close()
  receive message
  validate state vs sessionStorage
  clear sessionStorage
  POST /api/google/auth/token {code, verifier}
                                                      POST /token
                                                      exchange with client_secret
                                                      return {accessToken, expiresIn}
  store token in React state
  start expiry timer
```

### Picker Session Flow

```
Browser                              /api/google-photos/sessions/*
────────────────────────────────────────────────────────────────────
[Import from Google Photos clicked]
  POST /api/google-photos/sessions
  {Authorization: Bearer token}
                                     POST photospicker.googleapis.com/v1/sessions
                                     return {id, pickerUri, pollingConfig}
  window.open(pickerUri)   ← user picks photos in Google Photos app (new tab)
  start polling loop (uses pollingConfig.pollInterval)
    GET /api/google-photos/sessions/{id}
                                     GET photospicker.googleapis.com/v1/sessions/{id}
    repeat until mediaItemsSet:true or timeout
  GET /api/google-photos/sessions/{id}/items
                                     GET photospicker.googleapis.com/v1/mediaItems?sessionId={id}
                                     return [{id, mediaFile.baseUrl, mediaMetadata.creationTime}]
  for each item:
    POST /api/google-photos/download {baseUrl}
                                     fetch baseUrl+"=d" with Bearer token
                                     stream image bytes back
    new File([bytes], filename, {type})
    capturedAt = new Date(mediaMetadata.creationTime)
  addPhotos(files[])  → sorted insert into grid
  DELETE /api/google-photos/sessions/{id}
```

### Upload Flow

```
Browser                              /api/google-photos/*
─────────────────────────────────────────────────────────
[Upload to Google Photos clicked]
  (optional) user enters album name
  if album name:
    POST /api/google-photos/albums {title}
                                     POST photoslibrary.googleapis.com/v1/albums
                                     return {id}

  for each photo in grid:
    writeTimestamp(file, capturedAt)  ← JPEG only; PNG/TIFF pass through unchanged
    POST /api/google-photos/upload {file bytes}
                                     POST photoslibrary.googleapis.com/v1/uploads
                                     return uploadToken (plain text)
    store uploadToken per photo

  POST /api/google-photos/batch-create
  { uploadTokens[], filenames[], albumId? }
                                     POST photoslibrary.googleapis.com/v1/mediaItems:batchCreate
                                     return newMediaItemResults[]
  surface per-photo success/failure
  show "Retry failed" if any errors
```

## Implementation Units

- [ ] **Unit 1: OAuth authentication infrastructure**

**Goal:** PKCE utilities, callback page, token-exchange API route, and `useGoogleAuth` hook
that manages the popup flow, access token in React state, expiry detection, and sign-out.

**Requirements:** R1, R2, R3, R4, R5, R6 (see origin doc)

**Dependencies:** None

**Files:**
- Create: `lib/pkce.ts` — `generatePKCE(): Promise<{verifier, challenge}>`,
  `buildGoogleAuthUrl(params)` (constructs authorization URL with all PKCE + scope params)
- Create: `lib/google-auth-server.ts` — import `'server-only'`; exports validated env var
  accessors `getGoogleClientId()`, `getGoogleClientSecret()` — prevents accidental client import
- Create: `app/api/google/auth/callback/route.ts` — `GET` handler; validates `code` and `state`
  params, redirects to `/google-auth-callback?code=...&state=...`; returns `400` on `error`
  param or missing params
- Create: `app/api/google/auth/token/route.ts` — `POST` handler; receives `{code, codeVerifier,
  redirectUri}`, exchanges with Google's token endpoint using `GOOGLE_CLIENT_ID` +
  `GOOGLE_CLIENT_SECRET`; returns `{accessToken, expiresIn}` (no refresh token)
- Create: `app/google-auth-callback/page.tsx` — `'use client'`; reads `code`/`state`/`error`
  from `useSearchParams`; calls `window.opener.postMessage({type:'GOOGLE_AUTH', code, state,
  error}, origin)`; calls `window.close()`
- Create: `hooks/useGoogleAuth.ts` — React hook; manages: `accessToken | null`,
  `expiresAt: number | null`, `signIn()` (opens popup + wires postMessage listener + calls
  `/api/google/auth/token`), `signOut()` (clears token), `isSignedIn: boolean`,
  `isExpiringSoon: boolean` (true when < 5 min remaining, checked via `setInterval(60s)`),
  `accountEmail: string | null` (parsed from the id_token or returned alongside accessToken)
- Create: `.env.local.example` — documents `NEXT_PUBLIC_GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; includes comment about HTTP referrer restriction
  for API key when added
- Test: `lib/pkce.test.ts`
- Test: `hooks/useGoogleAuth.test.ts`

**Approach:**
- Popup is opened via `window.open(authUrl, 'google-auth', 'width=500,height=650')`. Store the
  PKCE verifier and a random state value in `sessionStorage` immediately before opening; the
  callback page validates state via postMessage
- The `app/google-auth-callback/page.tsx` is a minimal page that only runs `useEffect` to send
  postMessage and close; it should render nothing visible to avoid flash
- `signIn()` should be idempotent: if a popup is already open, focus it rather than opening a
  second one (track the popup reference with `useRef`)
- `useGoogleAuth` requests both scopes in one OAuth call:
  `photospicker.mediaitems.readonly photoslibrary.appendonly`
- `accountEmail` can be extracted by requesting `openid email` alongside the photos scopes and
  parsing the returned `id_token` JWT claims (no signature verification needed client-side since
  we just use it for display)
- `isExpiringSoon` drives the proactive warning in Unit 2; `signIn()` called while already
  signed in re-opens the popup to refresh the token (same PKCE flow)

**Patterns to follow:**
- `hooks/usePhotos.ts` for `useCallback` + functional state updater patterns
- `hooks/useObjectUrls.ts` for cleanup-on-unmount with `useEffect` return

**Test scenarios:**
- Happy path: `signIn()` opens popup, postMessage received with `{code, state}`, state matches,
  token exchange succeeds → `isSignedIn` becomes `true`, `accessToken` is set, `expiresAt` is
  roughly `Date.now() + expiresIn * 1000`
- Edge case: postMessage received with mismatched `state` → token exchange not called, no state
  change, error surfaced
- Edge case: postMessage received with `error` field → `isSignedIn` remains `false`
- Edge case: `/api/google/auth/token` returns non-200 → `isSignedIn` remains `false`, error surfaced
- Edge case: `signIn()` called while popup already open → no new popup opened (popup reference reused)
- Happy path: `signOut()` clears `accessToken`, `expiresAt`, `isSignedIn` becomes `false`
- Happy path: `isExpiringSoon` becomes `true` when `expiresAt - Date.now() < 300_000`; `false`
  when freshly signed in
- Integration: `buildGoogleAuthUrl` includes `code_challenge`, `code_challenge_method=S256`,
  `state`, `scope`, `redirect_uri` in the output URL
- Happy path for `pkce.ts`: `generatePKCE()` returns `{verifier, challenge}` where challenge is
  the URL-safe base64 SHA-256 of verifier; re-running returns a different pair each time
- API route — happy path: `POST /api/google/auth/token` with valid `code + codeVerifier` makes
  expected fetch to `oauth2.googleapis.com/token` and returns `{accessToken, expiresIn}`
- API route — error path: Google token endpoint returns non-200 → route returns 400 with error

**Verification:**
- `npm run lint` passes with no new errors
- `npm test` passes: pkce generation tests + auth hook tests + API route unit tests
- Visiting the app, clicking sign in, completing consent → `isSignedIn` becomes `true` in React
  DevTools; `accessToken` is present; no token visible in URL, cookies, or localStorage

---

- [ ] **Unit 2: Auth UI components**

**Goal:** Signed-in indicator showing Google account email, sign-in/sign-out button, and
non-blocking expiry warning banner. All integrated into `PhotoUploadPage`.

**Requirements:** R1, R4, R5, R6

**Dependencies:** Unit 1

**Files:**
- Create: `components/GoogleAuthStatus.tsx` — renders one of three states:
  (a) signed-out: "Connect Google Photos" button
  (b) signed-in: account email + disconnect link + (when `isExpiringSoon`) warning banner with
  "Refresh session" link that calls `signIn()`
  (c) loading: skeleton/disabled state while popup is open
- Modify: `components/PhotoUploadPage.tsx` — add `useGoogleAuth()` call; render
  `<GoogleAuthStatus>` in the page header or toolbar area
- Test: `components/GoogleAuthStatus.test.tsx`

**Approach:**
- `GoogleAuthStatus` receives `{ isSignedIn, accountEmail, isExpiringSoon, signIn, signOut }`
  as props (derived from `useGoogleAuth` in `PhotoUploadPage`)
- "Refresh session" re-invokes `signIn()` — same popup flow, preserves grid state
- Use the existing Tailwind zinc-palette and button patterns from `PhotoUploadPage.tsx`
- The expiry warning is visually distinct but non-blocking (not a modal) — a slim banner, similar
  to how a browser shows "save password?" notifications

**Patterns to follow:**
- `components/BatchEditPanel.tsx` for conditional-render patterns within `PhotoUploadPage`
- Existing Tailwind button classes in `PhotoUploadPage.tsx`

**Test scenarios:**
- Happy path: when `isSignedIn=false` → renders "Connect Google Photos" button; clicking calls
  `signIn`
- Happy path: when `isSignedIn=true, isExpiringSoon=false` → renders account email and
  disconnect link; no warning banner visible
- Happy path: when `isSignedIn=true, isExpiringSoon=true` → renders warning banner with "Refresh
  session" link alongside account info; clicking "Refresh session" calls `signIn`
- Happy path: clicking disconnect calls `signOut`
- Edge case: `accountEmail=null` while `isSignedIn=true` → renders a fallback label (e.g.
  "Google account connected") instead of blank

**Verification:**
- `npm test` passes
- Visual check: all three states render correctly with no layout shift; zinc styling matches
  existing page elements

---

- [ ] **Unit 3: Photo state extension for Google Photos imports**

**Goal:** Extend `usePhotos` with an `addPhotos(files: File[])` method for additive imports;
add `source` field to `PhotoEntry`; update `processFiles` to accept `File[] | FileList`; add
an origin badge to `PhotoCard`.

**Requirements:** R12, R13, R21

**Dependencies:** None (standalone state and UI change)

**Files:**
- Modify: `hooks/usePhotos.ts` — (a) add `source: 'local' | 'google-photos'` to `PhotoEntry`;
  (b) change `processFiles` signature to accept `File[] | FileList` (use duck-typing: check for
  `.length` and `[0]` access pattern, or union type narrowed via `instanceof`); existing callers
  pass `FileList` and must still work; (c) add `addPhotos(files: File[], source: 'google-photos')
  => void` — builds `PhotoEntry[]` with `source='google-photos'`, inserts them into `photos` in
  sorted order without calling `sortPhotos` on the whole list, does not touch `hasEdits`
- Modify: `components/PhotoCard.tsx` — render a small "Google Photos" badge (e.g. a pill with
  a colored dot + "Google Photos" text, or just an icon) when `entry.source === 'google-photos'`;
  position it as an overlay in the card's top-left corner, similar to existing checkmark overlay
- Modify: `components/PhotoUploadPage.tsx` — update the `handleChange` / `handleDrop` callers
  of `processFiles` to pass `{ source: 'local' }` or update the signature as needed
- Modify: `lib/download.ts` — no change needed; `downloadAll` is source-agnostic
- Test: `hooks/usePhotos.test.ts` — add tests for `addPhotos` and `source` field
- Test: `components/PhotoCard.test.tsx` — add tests for origin badge rendering

**Approach:**
- `addPhotos` does not call `sortPhotos` on the entire list. Instead, it builds `PhotoEntry[]`
  for the new photos (reading `capturedAt` from the file's EXIF using `getPhotoDate`, or using a
  supplied timestamp), then merges them into the existing sorted list by inserting at the correct
  sorted position. This preserves existing manual order while placing new photos chronologically
  among existing ones. `uploadIndex` for new photos starts after the current max `uploadIndex`.
- For the `processFiles` `FileList | File[]` union: existing tests use the `makeFileList` shim
  from `hooks/usePhotos.test.ts`; extend the shim or add a `File[]` path to the existing tests.
- `PhotoEntry.source` defaults to `'local'` for all existing entries constructed by
  `processFiles`; `addPhotos` sets `'google-photos'`.

**Patterns to follow:**
- `components/SortablePhotoCard.tsx` for the checkmark overlay pattern (position, z-index,
  conditional rendering) to mirror the origin badge style

**Test scenarios:**
- Happy path: `addPhotos([file1, file2])` appends two entries with `source='google-photos'` to
  an existing grid; entries are inserted in correct sorted order by `capturedAt`
- Happy path: `addPhotos` called on an empty grid → photos added and sorted as expected
- Edge case: `addPhotos` called when `hasEdits=true` → does not trigger confirm, `hasEdits`
  remains true, photos are added
- Happy path: `processFiles(fileList)` still works with existing `FileList` shape (existing tests
  pass unchanged)
- Happy path: existing `processFiles` callers produce entries with `source='local'`
- Happy path: `PhotoCard` renders origin badge when `entry.source === 'google-photos'`
- Happy path: `PhotoCard` renders no origin badge when `entry.source === 'local'`

**Verification:**
- `npm test` passes; no regressions in existing photo state tests
- Visual: origin badge appears on Google Photos cards without overlapping the checkmark or
  blocking image content; no badge on local cards

---

- [ ] **Unit 4: Google Photos API proxy route handlers**

**Goal:** All Next.js API routes that proxy calls to `photospicker.googleapis.com` and
`photoslibrary.googleapis.com`. These are CORS-safe tunnels — they read the user's Bearer token
from the `Authorization` header and forward it to Google.

**Requirements:** R8–R12 (import), R14–R19 (upload)

**Dependencies:** Unit 1 (env vars; `lib/google-auth-server.ts` for any server-side validation)

**Files:**
- Create: `lib/google-photos-types.ts` — TypeScript interfaces for all Google Photos API
  response shapes used in this plan:
  `PickerSession`, `PickedMediaItem`, `MediaFile`, `MediaMetadata`, `UploadResult`,
  `BatchCreateResult`, `NewMediaItemResult`, `Album`
- Create: `app/api/google-photos/sessions/route.ts` — `POST`: creates a Picker session; forwards
  to `photospicker.googleapis.com/v1/sessions`; returns `{id, pickerUri, pollingConfig,
  expireTime}`
- Create: `app/api/google-photos/sessions/[id]/route.ts` — `GET`: polls session OR fetches media
  items; reads optional `?items=true` query param — if `items=true`, calls
  `GET /v1/mediaItems?sessionId={id}`; otherwise calls `GET /v1/sessions/{id}` for poll status;
  `DELETE`: calls `DELETE /v1/sessions/{id}` for cleanup
- Create: `app/api/google-photos/download/route.ts` — `POST` with `{baseUrl: string}` body;
  fetches `${baseUrl}=d` server-side with the Bearer token; streams response bytes back to
  client; sets `Content-Type` from the upstream response
- Create: `app/api/google-photos/upload/route.ts` — `POST` with raw binary body (the image file
  bytes); reads `X-Goog-Upload-Content-Type` and `X-Goog-Upload-Filename` from request headers;
  forwards to `photoslibrary.googleapis.com/v1/uploads`; returns the plain-text upload token
- Create: `app/api/google-photos/albums/route.ts` — `POST` with `{title: string}` body; calls
  `POST /v1/albums` with the title; returns `{id, title}`
- Create: `app/api/google-photos/batch-create/route.ts` — `POST` with `{uploadTokens: Array<
  {token, filename}>, albumId?: string}` body; builds `newMediaItems` array; calls
  `POST /v1/mediaItems:batchCreate`; returns `BatchCreateResult`

**Approach:**
- Every route handler reads the `Authorization` header from the incoming request and forwards it
  verbatim to Google. If the header is missing or doesn't start with `Bearer `, return `401`.
- No route handler stores or logs the Bearer token.
- Route handlers are thin: validate inputs, build the Google API request, forward, return the
  response. No business logic.
- `params` in dynamic route handlers (`sessions/[id]`) must be `await`-ed per Next.js 16 pattern.
- `album.title` input is trimmed and capped to 500 characters before being sent to Google
  (matching R16's 500-char limit).
- The download route should set `Cache-Control: no-store` on the response to prevent caching
  of authenticated photo content.
- Error responses from Google (4xx, 5xx) are forwarded to the browser with the same status code.

**Patterns to follow:**
- `app/api/google/auth/token/route.ts` for the route handler pattern (established in Unit 1)
- `lib/google-auth-server.ts` for accessing server-only env vars

**Test scenarios:**
- Happy path: `POST /sessions` with valid Bearer token → forwards to Google, returns session object
- Error path: `POST /sessions` with no Authorization header → returns 401
- Error path: Google returns 403 → route returns 403 to browser
- Happy path: `GET /sessions/{id}` (poll mode) → returns session with `mediaItemsSet` field
- Happy path: `GET /sessions/{id}?items=true` → returns media items array
- Happy path: `DELETE /sessions/{id}` → returns 204
- Happy path: `POST /download` with valid `baseUrl` → proxies `baseUrl=d` fetch, streams bytes
- Happy path: `POST /upload` with image bytes → forwards to Google upload endpoint, returns
  upload token string
- Happy path: `POST /albums` → creates album, returns `{id, title}`
- Edge case: `POST /albums` with title > 500 chars → title is trimmed before forwarding
- Happy path: `POST /batch-create` with multiple upload tokens and no albumId → calls
  batchCreate without albumId; returns results
- Happy path: `POST /batch-create` with albumId → calls batchCreate with albumId

**Verification:**
- `npm run lint` passes
- `npm test` passes (route handler unit tests using `vi.mock` for `fetch`)
- Manual integration test: authenticated call to each route returns the expected shape without
  CORS errors

---

- [ ] **Unit 5: Google Photos Picker client flow**

**Goal:** `useGooglePhotosPicker` hook orchestrates the full Picker session lifecycle — creates
session, opens picker in new tab, polls until user picks, fetches media items, downloads image
bytes via the proxy, constructs `File` objects, and calls `addPhotos`. Includes the import
entry-point UI in `PhotoUploadPage`.

**Requirements:** R7, R8, R9, R10, R11, R12

**Dependencies:** Units 1, 3, 4

**Files:**
- Create: `hooks/useGooglePhotosPicker.ts` — state: `status: 'idle' | 'session-open' |
  'picking' | 'downloading' | 'error'`, `error: string | null`; methods: `startImport()`,
  `cancelImport()`
- Modify: `components/PhotoUploadPage.tsx` — add "Import from Google Photos" button (visible when
  `isSignedIn=true`); wire to `useGooglePhotosPicker.startImport()`; show loading/status indicator
  while `status !== 'idle'`; show error message when `status === 'error'`
- Test: `hooks/useGooglePhotosPicker.test.ts`

**Approach:**
- `startImport()` is the full orchestration:
  1. `POST /api/google-photos/sessions` → get `{id, pickerUri, pollingConfig}`
  2. `window.open(pickerUri, '_blank')` — user picks in new tab
  3. Start polling loop using `setTimeout` (not `setInterval`) — respects
     `pollingConfig.pollInterval` (parse `"2s"` → 2000ms; default 3000ms on parse failure)
  4. On each poll: `GET /api/google-photos/sessions/{id}` — if `mediaItemsSet: true`, exit loop;
     if `pollingConfig.timeoutIn` elapsed, exit with error
  5. `GET /api/google-photos/sessions/{id}?items=true` → `PickedMediaItem[]`
  6. For each item in parallel (up to, say, 5 concurrent): `POST /api/google-photos/download
     {baseUrl: item.mediaFile.baseUrl}` → `Blob`; construct `new File([blob], filename, {type})`
     with `capturedAt` set from `item.mediaMetadata.creationTime`
  7. Call `addPhotos(files, 'google-photos')` on `usePhotos`
  8. `DELETE /api/google-photos/sessions/{id}` — cleanup (fire-and-forget, do not block UI)
  9. Set `status = 'idle'`
- `cancelImport()` sets a cancellation flag checked in the polling loop, calls `DELETE` on the
  session if `id` is known, sets `status = 'idle'`
- On `visibilitychange` (page becomes visible), check if picking is in progress and the session
  hasn't timed out — this is a heuristic UX optimization so the poll resolves quickly when the
  user returns from the Google Photos tab
- Filename for each `File` object: use `item.mediaFile.filename` if available, else derive from
  `item.id` with extension from `item.mediaFile.mimeType`
- `status = 'downloading'` while fetching bytes so the UI can show "Downloading X photos…"

**Patterns to follow:**
- `hooks/usePhotos.ts` for `useCallback` patterns and functional state updates
- `hooks/useObjectUrls.ts` for `useEffect` cleanup pattern (cancel in-flight fetch on unmount)

**Test scenarios:**
- Happy path: `startImport()` creates session, polls until `mediaItemsSet: true`, fetches items,
  downloads bytes, calls `addPhotos` with correct `File[]`; `status` transitions:
  `idle → session-open → picking → downloading → idle`
- Happy path: `addPhotos` receives `File` objects with `capturedAt` matching
  `mediaMetadata.creationTime`
- Edge case: polling timeout reached before user picks → `status = 'error'`,
  `error` contains a user-readable message
- Edge case: session creation (`POST /sessions`) fails → `status = 'error'`
- Edge case: `cancelImport()` called while polling → polling stops, session deleted, `status =
  'idle'`
- Edge case: one of N photo downloads fails → `addPhotos` is called with successfully downloaded
  photos only; a warning is surfaced noting how many failed (do not block the entire import)
- Edge case: `startImport()` called while `status !== 'idle'` → noop
- Integration: after `addPhotos` call, photos appear in grid with `source='google-photos'`

**Verification:**
- `npm test` passes
- Manual test: sign in, click import, pick 3 photos in Google Photos, return to app → 3 cards
  appear in the grid with origin badges; timestamps reflect `creationTime` from Google Photos

---

- [ ] **Unit 6: Upload-back logic**

**Goal:** `useGooglePhotosUpload` hook orchestrates the full upload flow — EXIF-stamp each
photo (JPEG only), upload bytes one-by-one via the proxy, collect upload tokens, optionally
create a named album, then call batchCreate with all tokens. Tracks per-photo upload state.

**Requirements:** R14, R15, R17, R18, R19, R20

**Dependencies:** Units 1, 4

**Files:**
- Create: `hooks/useGooglePhotosUpload.ts` — state: `uploadState: 'idle' | 'uploading' |
  'done' | 'error'`; `photoStates: Map<string, {status: 'pending'|'uploading'|'done'|'failed',
  error?: string}>` keyed by `PhotoEntry.id`; methods: `startUpload(photos, albumName,
  accessToken)`, `retryFailed()`
- Test: `hooks/useGooglePhotosUpload.test.ts`

**Approach:**
- `startUpload(photos, albumName, accessToken)`:
  1. If `albumName` is non-empty: `POST /api/google-photos/albums {title: albumName}` → get
     `albumId`; on failure, surface error and abort
  2. For each photo (sequentially — Google imposes rate limits; sequential avoids overwhelming):
     a. `writeTimestamp(photo.file, photo.capturedAt ?? new Date())` → `modifiedFile`
     b. Set `photoStates.get(id).status = 'uploading'`
     c. `POST /api/google-photos/upload` with `modifiedFile` bytes + filename/content-type headers
        → `uploadToken` string
     d. On success: set `status = 'done'`, store token
     e. On failure: set `status = 'failed'`, store error message; continue to next photo
  3. Collect all successful `uploadTokens` into batches of ≤ 50
  4. For each batch: `POST /api/google-photos/batch-create {uploadTokens, albumId?}`
  5. Set `uploadState = 'done'`
- `retryFailed()`: re-runs steps 2–4 only for entries where `status === 'failed'`
- Token (`accessToken`) is passed as a parameter (not from a global) so the hook stays testable
  with mock tokens

**Patterns to follow:**
- `lib/download.ts` (`downloadAll`) for sequential async loop pattern
- `lib/exif-write.ts` (`writeTimestamp`) — already imported by `lib/download.ts`

**Test scenarios:**
- Happy path: `startUpload([photo1, photo2], '', token)` → calls upload proxy for each, then
  batchCreate with both tokens; `uploadState = 'done'`; all `photoStates` set to `'done'`
- Happy path: `startUpload([photo1, photo2], 'Paris 2024', token)` → creates album first, then
  uploads, then batchCreate includes `albumId`
- Error path: upload for `photo1` fails (proxy returns 500) → `photo1.status = 'failed'`;
  `photo2` upload still attempted; batchCreate called with `photo2`'s token only
- Happy path: `retryFailed()` after partial failure → re-uploads only failed photos, merges
  tokens with previous successful tokens, calls batchCreate again with combined set
- Error path: album creation fails → `uploadState = 'error'`, no uploads attempted
- Edge case: `startUpload` called while `uploadState = 'uploading'` → noop
- Edge case: `photos` is empty array → `uploadState = 'done'` immediately without calling any
  proxy
- Integration: `writeTimestamp` called for each JPEG photo before upload bytes are sent; non-JPEG
  `file` passed unchanged
- Happy path: batchCreate is called in batches of ≤ 50 when photos.length > 50

**Verification:**
- `npm test` passes
- Manual test: upload 2 photos → both appear in Google Photos with modified timestamps

---

- [ ] **Unit 7: Upload UX**

**Goal:** Upload-back UI in `PhotoUploadPage` — upload button (visible when signed in and grid
has photos), album name input, per-photo progress display, success confirmation, and per-photo
error/retry affordance.

**Requirements:** R14, R15, R16, R17, R19, R20

**Dependencies:** Units 2, 3, 6

**Files:**
- Create: `components/GooglePhotosUploadPanel.tsx` — panel shown during/after upload:
  album name text input (optional, max 500 chars, placeholder "Album name (optional)"),
  "Upload to Google Photos" button, per-photo progress list (filename + status icon), success
  banner, "Retry failed" button (shown only when some photos failed)
- Modify: `components/PhotoUploadPage.tsx` — instantiate `useGooglePhotosUpload`; render
  `<GooglePhotosUploadPanel>` conditionally (show when `isSignedIn && photos.length > 0`);
  pass `photos`, `accessToken`, upload state, and callbacks as props
- Test: `components/GooglePhotosUploadPanel.test.tsx`

**Approach:**
- "Upload to Google Photos" button triggers `startUpload(photos, albumName, accessToken)`
- The panel shows a per-photo list: `filename` + a status indicator (`⏳ pending`, `⬆️
  uploading`, `✅ done`, `❌ failed: <error>`)
- Progress summary line: "Uploading 3 of 12…" while `uploadState = 'uploading'`
- Success banner: "12 photos uploaded to Google Photos" (if no album) or "12 photos uploaded to
  album 'Paris 2024'" (if album name was provided). No deep link (API may not return one).
- "Retry failed" button is shown after `uploadState = 'done'` if any `photoStates.status ===
  'failed'`; calls `retryFailed()`
- "Upload to Google Photos" button is disabled while `uploadState = 'uploading'`
- Album name field is a plain `<input type="text">` with a 500-char `maxLength` attribute
- Panel closes/resets when user starts a new local upload or Google Photos import (natural
  session reset); `uploadState` resets to `'idle'` when `processFiles` is called

**Patterns to follow:**
- `components/BatchEditPanel.tsx` for the collapsible/conditional panel pattern
- Existing Tailwind zinc-palette classes for buttons and inputs throughout `PhotoUploadPage`

**Test scenarios:**
- Happy path: when `isSignedIn=false` → upload panel not rendered
- Happy path: when `isSignedIn=true, photos.length=0` → upload panel not rendered
- Happy path: when `isSignedIn=true, photos.length=3` → panel rendered with "Upload to Google
  Photos" button and album name input
- Happy path: clicking "Upload to Google Photos" calls `startUpload` with current `photos`,
  `albumName`, and `accessToken`
- Happy path: during upload (`uploadState='uploading'`) → button disabled; per-photo list shows
  uploading statuses; progress summary shows "Uploading N of M…"
- Happy path: after `uploadState='done'`, all successful → success banner shown; no "Retry
  failed" button
- Happy path: after `uploadState='done'` with some failures → "Retry failed" button shown;
  clicking calls `retryFailed()`
- Edge case: `albumName` exceeds 500 chars typed into input → `maxLength` prevents input beyond
  500 chars; `startUpload` receives at most 500 chars
- Happy path: success banner reads "N photos uploaded to album 'Paris 2024'" when album name
  was provided
- Happy path: success banner reads "N photos uploaded to Google Photos" when no album name

**Verification:**
- `npm test` passes
- `npm run lint` passes
- Manual end-to-end test: sign in, import photos, reorder, click "Upload to Google Photos",
  enter album name, confirm → progress list appears, success banner shown, album visible in
  Google Photos with updated timestamps

## System-Wide Impact

- **Interaction graph**: `useGoogleAuth` is new; `usePhotos` gains `addPhotos`; `PhotoUploadPage`
  gains three new hook instantiations (`useGoogleAuth`, `useGooglePhotosPicker`,
  `useGooglePhotosUpload`). Existing `processFiles` / drag-drop / download flow is unchanged.
  The `slotTimestamp` path in `reorderPhotos` is used for all photos regardless of origin.
- **Error propagation**: Auth errors surface via `useGoogleAuth` state; Picker errors surface
  via `useGooglePhotosPicker.error`; upload errors surface via `useGooglePhotosUpload.photoStates`
  — all scoped to their respective hooks, no error propagation across layers.
- **State lifecycle risks**: `addPhotos` appends to an existing grid; `processFiles` replaces
  it. If `addPhotos` is called after `processFiles` clears the list on a new local upload,
  behavior is correct (new import starts fresh). The `hasEdits` flag is not affected by
  `addPhotos`.
- **API surface parity**: The local download flow (`downloadAll`, `writeTimestamp`) is reused
  for upload EXIF-stamping — same function, same JPEG-only behavior. Non-JPEG photos in the
  grid will upload without updated timestamps whether they originated locally or from Google
  Photos.
- **Integration coverage**: The Picker polling loop, the popup postMessage handshake, and the
  sequential upload loop are multi-step async flows that unit tests alone cannot prove. Manual
  end-to-end testing is required for each (see Verification steps above).
- **Unchanged invariants**: `processFiles` still resets the grid and triggers sort;
  `reorderPhotos` + `slotTimestamp` still own order-preserving timestamp logic; `downloadAll`
  still owns local export; `useObjectUrls` cleanup is unchanged. No existing tests should fail.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Picker API CORS: `photospicker.googleapis.com` may require browser requests to be proxied | All calls already routed through Next.js API routes — CORS is not assumed for any Google endpoint |
| CDN CORS for photo download (`lh3.googleusercontent.com`) | Download proxy route (`/api/google-photos/download`) handles all image downloads server-side |
| `expiresIn` for re-auth may be shorter than 1 hour for sensitive scopes | `isExpiringSoon` checks at 5 min remaining; `signIn()` re-auth is always available via the toolbar |
| Google OAuth app verification (100 test user limit) | Use Google Cloud Console to add specific test users during development; submit for verification before production launch |
| `writeTimestamp` (piexif-ts) throws on JPEG with no EXIF segment | Already caught and handled in existing `exif-write.ts` — seeds `{}` and retries |
| `batchCreate` rate limit (10,000 requests/day per project) | Sequential upload loop keeps request rate low; single batchCreate per session is the expected pattern |
| Picker session timeout if user takes too long to pick | `pollingConfig.timeoutIn` is parsed and respected; user sees error + can restart |
| `window.opener` is null if popup is blocked by the browser | Detect null opener in `google-auth-callback/page.tsx`; show a manual "Copy code" fallback if needed (defer to implementation) |

## Documentation / Operational Notes

- **`.env.local.example`**: Created in Unit 1 — documents all required env vars. Developers
  clone the repo and copy this to `.env.local` before running the app.
- **Google Cloud Console setup** (not automated by this plan):
  - Create OAuth 2.0 client: "Web application" type
  - Authorized redirect URI: `http://localhost:3000/api/google/auth/callback` (dev) +
    `https://your-production-domain/api/google/auth/callback` (prod)
  - Enable: Google Photos Picker API + Google Photos Library API
  - Restrict API key (if used) to production domain via HTTP referrer restriction
  - OAuth consent screen: add test users (max 100) before verification
- **App verification** (before public launch): Submit for sensitive scope review with
  `photospicker.mediaitems.readonly` and `photoslibrary.appendonly` — requires domain
  verification, privacy policy, YouTube demo video.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-05-google-photos-integration-requirements.md](docs/brainstorms/2026-04-05-google-photos-integration-requirements.md)
- Related code: `hooks/usePhotos.ts`, `lib/exif-write.ts`, `lib/download.ts`,
  `components/PhotoUploadPage.tsx`
- Institutional learnings: `docs/solutions/best-practices/exif-timestamp-rewriting-…`,
  `docs/solutions/best-practices/image-as-selection-target-…`,
  `docs/solutions/ui-bugs/drag-and-drop-upload-…`
- Google Photos Picker API: https://developers.google.com/photos/picker/guides/get-started-picker
- Google Photos Library API upload: https://developers.google.com/photos/library/guides/upload-media
- April 2025 scope deprecation: https://developers.google.com/photos/support/updates
- OAuth 2.0 PKCE + manual flow: https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow
- `baseUrl + "=d"` EXIF preservation: https://developers.google.com/photos/library/guides/access-media-items
