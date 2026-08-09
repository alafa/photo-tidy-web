---
title: "fix: Surface real Google Photos import-session error instead of generic failure message"
type: fix
status: completed
date: 2026-08-09
---

# fix: Surface real Google Photos import-session error instead of generic failure message

## Overview

After signing in with Google, clicking "Import from Google Photos" always fails with the same
generic banner text — "Failed to create import session" — regardless of what actually went
wrong. The real cause is currently unrecoverable: the Next.js proxy route already receives
Google's detailed error body, but the client-side hook discards it before it ever reaches a
console log or the UI. This plan makes the real error visible (logged and shown to the user),
hardens the two proxy routes on this path so they always return valid JSON instead of an
unhandled-exception page, and then uses that visibility to diagnose and apply the actual
root-cause fix.

## Problem Frame

`hooks/usePhotos.ts`, `useGoogleAuth`, and the Google Photos Picker/Library API integration were
built in a single prior pass (see `docs/plans/2026-04-06-001-feat-google-photos-integration-plan.md`,
committed under `136889e "fix google login"`). Sign-in now works. The next step of the flow —
creating a Picker session — fails every time a user clicks "Import from Google Photos," and the
app currently has no way to say why.

Code tracing (`hooks/useGooglePhotosPicker.ts:126-142`) shows the failure path:

```
POST /api/google-photos/sessions
  → app/api/google-photos/sessions/route.ts forwards to
    https://photospicker.googleapis.com/v1/sessions
  → on non-2xx, the route already returns Google's real error body + status code
  → but the client only checks `!res.ok`, throws a bare `Error`, and the catch block
    discards it entirely, always setting the same string: 'Failed to create import session'
```

No `console.error`/`console.warn` is emitted on this path either, so even a developer with
devtools open cannot currently see whether Google returned 401 (bad token), 403 (API not
enabled / missing scope), 400 (malformed request), or a network-level failure.

A raw `curl` against `photospicker.googleapis.com/v1/sessions` (with a placeholder token, both
with and without a request body) confirmed Google validates auth before body shape, returning
identical `401 UNAUTHENTICATED` responses either way. This narrows — but does not fully rule
out — "missing request body" as the cause: it only proves the auth check runs first with an
invalid token, not that an authenticated request succeeds without a body. The failure is most
likely a 401/403 from Google (token, scope, or API-enablement issue), a malformed-request 400,
or a network/parsing failure — none of which the app currently surfaces (see Unit 3's decision
matrix for how each is diagnosed and fixed).

## Requirements Trace

- R1. Clicking "Import from Google Photos" and hitting a session-creation failure must show the
  user (and log to the console) Google's actual error detail, not a hardcoded generic string.
- R2. The two proxy routes on this path (`sessions` create, `sessions/[id]` poll/fetch-items)
  must always return valid, parseable JSON to the client — including when the upstream `fetch`
  itself throws or Google returns a non-JSON body — so error detail is never lost to an unhandled
  exception.
- R3. Once the real error is visible, the actual root cause of the reported failure must be
  identified and fixed (or, if the cause is a Google Cloud Console configuration gap rather than
  a code defect, documented as a required operational step).

## Scope Boundaries

- Only the **import** path (`useGooglePhotosPicker`, `sessions/route.ts`, `sessions/[id]/route.ts`)
  is in scope. `hooks/useGooglePhotosUpload.ts` already reads `response.text()` on upload
  failures and is not exhibiting the reported symptom — it is not touched by this plan.
- No change to the OAuth/token-exchange flow (`useGoogleAuth`, `lib/pkce.ts`,
  `app/api/google/auth/*`) — sign-in itself is confirmed working per the bug report ("After
  Google login...").
- No change to the polling-retry behavior for transient poll failures
  (`useGooglePhotosPicker.ts` poll loop's silent-retry catch is intentional and out of scope).
- No preemptive fix for all four hypothesized root causes (API not enabled, missing scope,
  invalid token, malformed request) — only the one the now-visible error actually points to (see
  Unit 3).

## Context & Research

### Relevant Code and Patterns

- `hooks/useGooglePhotosPicker.ts:126-142` — session-creation catch block; swallows the real
  error and always sets `'Failed to create import session'`
- `hooks/useGooglePhotosPicker.ts:218-231` — the "fetch selected photos" step has the identical
  blind-catch pattern (`'Failed to fetch selected photos'`), same file, same bug class
- `app/api/google-photos/sessions/route.ts` — already forwards Google's error body + status
  correctly (`return NextResponse.json(data, { status: upstream.status })`); the fix is entirely
  client-side for this route plus defensive hardening (see below)
- `app/api/google-photos/sessions/[id]/route.ts` — `DELETE` already wraps `upstream.json()` in
  `.catch(() => ({ error: 'Delete failed' }))`; `GET` (used for both poll and fetch-items) does
  not have this guard, and neither route wraps the outer `fetch()` call itself in try/catch — an
  inconsistency within the same file to fix by mirroring `DELETE`'s existing pattern
- `hooks/useGooglePhotosPicker.test.ts:207-224` — existing test pins the exact generic string
  (`expect(result.current.error).toBe('Failed to create import session')`); will need updating
  to assert on the new, detail-carrying message instead

### Institutional Learnings

- `.context/compound-engineering/ce-review/2026-04-06-001/run.md` — the review that shipped this
  feature already flagged related-but-distinct issues (no fetch timeouts on proxy routes, poll
  HTTP errors swallowed, `startImport` stale-closure guard) but did not catch this specific
  error-message swallowing — confirms this is a genuine gap, not a previously-accepted tradeoff
- No `docs/solutions/` entry covers Google API error handling specifically; none of the existing
  best-practice docs (EXIF slot-timestamp, image-as-selection-target, drag-drop event handlers)
  apply to this area

### External References

- Google Photos Picker API session creation:
  https://developers.google.com/photos/picker/reference/rest/v1/sessions/create — confirms field
  names used in code (`pickerUri`, `pollingConfig`, `mediaItemsSet`) match the actual API schema,
  ruling out a response-shape mismatch as the cause
- Google API errors follow the standard `{ error: { code, message, status } }` envelope
  (`google.rpc.Status`) — the fix should read `data?.error?.message` from the already-forwarded
  body

## Key Technical Decisions

- **Surface the error client-side, don't just log server-side**: the proxy route already has the
  correct detail in its response body; the fix is to make `useGooglePhotosPicker` actually read
  and use it, both via `console.warn` (for developer diagnosis — not `console.error`, since
  Next.js's dev-mode error overlay intercepts `console.error` calls and shows them as a blocking
  full-screen overlay, which would hijack this recoverable, in-app error state; discovered during
  Unit 3's live reproduction) and in the user-facing `error` string (so a user can report
  something more useful than "Failed to create import session").
- **Harden both proxy routes to always return valid JSON**: mirroring the `DELETE` handler's
  existing `.catch()` pattern in `sessions/[id]/route.ts` and adding the same defensive shape to
  `sessions/route.ts`'s `POST` and the `GET` handler. This guarantees the client-side fix in the
  previous decision always has a parseable body to read from, even on network-level failures
  between our server and Google.
- **Defer the exact root-cause fix to a diagnosis step, not a guess**: per user direction, do not
  preemptively implement fixes for all hypothesized causes (Picker API not enabled, missing
  scope, bad token, malformed request). Ship the visibility improvements first, reproduce with
  them in place, then apply only the fix the real error points to. This is captured as an explicit
  decision matrix in Unit 3 rather than speculative code changes.

## Open Questions

### Resolved During Planning

- **Does the missing request body on `POST /v1/sessions` explain the 401s seen in the curl
  test?** No — confirmed via direct `curl` against Google's endpoint that auth is validated
  before body shape; both with and without a body, an invalid token produces the same `401
  UNAUTHENTICATED` response. This only proves Google's auth check runs before body validation —
  it does not prove an authenticated request would succeed without a body. Whether the missing
  body matters once auth passes remains unverified and stays a live row in Unit 3's decision
  matrix (see the `400` row).
- **Does the Picker API response schema match what the code expects?** Yes — `pickerUri`,
  `pollingConfig`, `mediaItemsSet` field names are confirmed correct against Google's reference
  docs, ruling out a parsing/shape mismatch on success responses.
- **Is this the same bug as the upload flow?** No — `useGooglePhotosUpload.ts` already reads
  `response.text()` on failure; it's out of scope.
- **Should this plan guess and implement a fix for all possible root causes?** No — user
  direction: ship error visibility first, diagnose with it, then apply the one matching fix
  (see Unit 3).

### Deferred to Implementation

- **The actual Google-side root cause** (API not enabled on the GCP project vs. missing/ungranted
  `photospicker.mediaitems.readonly` scope vs. a stale/invalid token vs. a genuine malformed
  request) can only be confirmed by reproducing the flow in a browser with real credentials once
  Units 1–2 land. Unit 3's decision matrix maps each possible real-error signature to its fix.

## Implementation Units

- [x] **Unit 1: Harden the two proxy routes to always return valid JSON**

**Goal:** Guarantee that `app/api/google-photos/sessions/route.ts` (`POST`) and
`app/api/google-photos/sessions/[id]/route.ts` (`GET`) never let an unhandled exception reach
the client — every response, success or failure, is valid JSON the client can parse for detail.

**Requirements:** R2

**Dependencies:** None

**Files:**
- Modify: `app/api/google-photos/sessions/route.ts`
- Modify: `app/api/google-photos/sessions/[id]/route.ts`
- Test: `app/api/google-photos/sessions/route.test.ts` (new)
- Test: `app/api/google-photos/sessions/[id]/route.test.ts` (new)

**Approach:**
- Wrap the outer `fetch()` call to `photospicker.googleapis.com` in try/catch in both routes; on
  a thrown network-level error, return a structured JSON body with a `502` status.
- Wrap `upstream.json()` in a `.catch()` fallback in the `POST` handler and the `GET` handler —
  same defensive intent as the `DELETE` handler's existing `.catch(() => ({ error: 'Delete
  failed' }))` in `sessions/[id]/route.ts`, but use the **nested** error shape (below), not
  `DELETE`'s flat string — Unit 2 reads `data?.error?.message` uniformly across every failure
  path, so every fallback body this unit produces must use the same nested shape or that read
  silently evaluates to `undefined`.
- Use one fallback shape everywhere in this unit, in both routes, for both the network-throw case
  and the non-JSON-body case: `{ error: { message: '<route-specific text>', status:
  '<SCREAMING_SNAKE_CASE code>' } }` (e.g. `{ error: { message: 'Failed to reach Google Photos
  API', status: 'UPSTREAM_UNREACHABLE' } }` for a network throw; `{ error: { message: 'Upstream
  returned a non-JSON response', status: 'INVALID_UPSTREAM_RESPONSE' } }` for a JSON-parse
  failure). This mirrors Google's own `{ error: { code, message, status } }` envelope shape that
  the success/passthrough path already forwards, so Unit 2 can read `data?.error?.message`
  identically regardless of whether the body came from Google or from this fallback.
- Preserve existing behavior for the success path and for upstream responses that are already
  valid JSON (this is purely a defensive fallback for the cases that currently fall through).
- The `DELETE` handler in `sessions/[id]/route.ts` is not left untouched: it also gets the same
  outer-`fetch()` try/catch it was missing, and its fallback shape is normalized from the
  original flat `{ error: 'Delete failed' }` string to the same shared nested shape as `POST` and
  `GET` (via a small shared helper, e.g. in `lib/google-photos-server.ts`, so all three handlers
  build the fallback body the same way instead of duplicating the object literal three times).

**Patterns to follow:**
- The existing `DELETE` handler's `.catch()` fallback in `app/api/google-photos/sessions/[id]/route.ts`
  (lines 34-56) is the starting reference for the defensive pattern, but its own fallback shape
  is upgraded to match the shared nested shape as part of this unit — not left as-is.

**Test scenarios:**
- Happy path: `POST /sessions` with a valid Bearer token and a 200 upstream response → returns
  the upstream JSON body unchanged.
- Error path: upstream `fetch()` to Google throws (simulated network failure) → route returns a
  structured JSON error body with `502`, not an unhandled exception.
- Error path: upstream responds non-2xx with a non-JSON body → route still returns valid JSON
  (fallback error shape) with the upstream status code, not a thrown error.
- Happy path: `GET /sessions/{id}` (poll mode, no `items` query param) and
  `GET /sessions/{id}?items=true` both retain existing success-path behavior.
- Error path: same network-failure and non-JSON-body cases as above, applied to the `GET` handler
  for both poll and fetch-items modes.
- Error path: same network-failure and non-JSON-body cases, applied to the `DELETE` handler,
  which previously had neither guard on its outer `fetch()` call.

**Verification:**
- `npm run lint` passes with no new errors.
- `npm test` passes, including the new route tests.
- No behavior change for any currently-passing request/response shape.

---

- [x] **Unit 2: Surface the real error in `useGooglePhotosPicker`**

**Goal:** Replace the hardcoded generic error strings for session creation and fetch-items
failures with the actual detail forwarded by the proxy routes (now guaranteed valid JSON by
Unit 1), logged to the console and reflected in the user-facing `error` state.

**Requirements:** R1

**Dependencies:** Unit 1

**Files:**
- Modify: `hooks/useGooglePhotosPicker.ts`
- Modify: `hooks/useGooglePhotosPicker.test.ts`

**Approach:**
- In the session-creation step (`hooks/useGooglePhotosPicker.ts:126-142`): the current
  `try { const res = ...; if (!res.ok) throw ... } catch { ... }` structure declares `res` inside
  the `try` block, so it is out of scope in the `catch` — reading `res.json()` on failure
  requires restructuring this control flow (e.g. parse the body and branch on `res.ok` inside the
  `try` block itself, rather than throwing and catching). On `!res.ok`, parse the response body
  (`res.json()`, tolerant of parse failure), extract `data?.error?.message` from Google's
  standard `{ error: { code, message, status } }` envelope (now guaranteed present in that shape
  by Unit 1's fallback), and set `error` to a message that includes the detail — falling back to
  a status-code-qualified generic message (e.g. `` `Failed to create import session (HTTP
  ${res.status})` ``) only when no `message` is present. `console.warn` (not `console.error` —
  see Key Technical Decisions) only the narrow, known-safe fields (`res.status`,
  `data?.error?.code`, `data?.error?.status`, `data?.error?.message`) — not the full parsed body,
  which may carry additional fields (e.g. Google's `error.details`) not vetted for what they
  contain.
- Apply the identical treatment (including the same control-flow restructuring) to the
  fetch-items step (`hooks/useGooglePhotosPicker.ts:218-231`, currently `'Failed to fetch
  selected photos'`) — same bug class, same file, same fix shape.
- Leave the poll-loop catch block untouched — it is an intentional silent-retry, not a terminal
  error path (see Scope Boundaries).
- Keep the `status = 'error'` state transition and cleanup calls (`cleanupSession`) unchanged;
  only the content of the `error` string and the addition of `console.warn` change.

**Patterns to follow:**
- `hooks/useGooglePhotosPicker.ts`'s existing `downloadBatch` function, which already logs
  `console.warn` on a per-item failure — extend the same "log the real cause" discipline to the
  two catch blocks being fixed here.

**Test scenarios:**
- Happy path: session creation fails with a structured Google error body (e.g.
  `{ error: { code: 403, message: 'Photos Picker API has not been used...', status:
  'PERMISSION_DENIED' } }`) → `result.current.error` includes that message text, not the old
  hardcoded string; `console.warn` is called with the detail.
- Edge case: session creation fails with `!res.ok` but a non-JSON or empty body → `error` falls
  back to a status-code-qualified generic message; no unhandled exception.
- Edge case: the `fetch()` call itself rejects (client-side network failure, e.g. offline) before
  any `res` is available → `error` is set to a generic network-failure message; behavior does not
  regress from today for this specific sub-case.
- Happy path: fetch-items step fails with a structured Google error body → `error` includes the
  real detail, mirroring the session-creation fix.
- Regression: update the existing pinned-string test at `hooks/useGooglePhotosPicker.test.ts:207-224`
  to assert the new message shape instead of the literal old string.

**Verification:**
- `npm test` passes, including updated and new assertions.
- `npm run lint` passes.
- Manual check (post-Unit 3 reproduction): the error banner and browser console both show
  Google's actual error text instead of the generic string.

---

- [x] **Unit 3: Diagnose and apply the matching root-cause fix**

**Diagnosis outcome:** Live reproduction (with Units 1–2's visibility in place) matched the
second decision-matrix row: session creation failed for a signed-in user, and re-running the
OAuth sign-in flow (forcing re-consent via `prompt=consent`, already set in `lib/pkce.ts`)
resolved it on the next attempt. This is consistent with a stale access token obtained before
`photospicker.mediaitems.readonly` was added to `useGoogleAuth.ts`'s `SCOPES` list — the token
never had Picker API access, and forcing fresh consent granted it. No code change was required;
this is the operational fix already captured in Documentation / Operational Notes below. Users
hitting this again only need to sign out and sign in again; no user should need to repeat this
once their token was issued after the scope was added.

**One implementation defect was found and fixed during reproduction, outside the original scope
of this unit:** `describeApiError` (added in Unit 2) originally used `console.error`, which
Next.js's dev-mode error overlay intercepts and displays as a blocking full-screen overlay —
hijacking what should be a recoverable, in-app error state. Changed to `console.warn`, matching
the existing `downloadBatch` convention in the same file (Unit 2's own "Patterns to follow").
Updated `hooks/useGooglePhotosPicker.test.ts` to spy on `console.warn` accordingly.

**Goal:** With Units 1–2 landed, reproduce the reported failure (sign in, click "Import from
Google Photos") and use the now-visible error detail to identify and apply the specific fix.

**Requirements:** R3

**Dependencies:** Units 1, 2

**Execution note:** This unit is diagnosis-driven. Apply only the row of the decision matrix
below that matches the error actually observed — do not implement all branches preemptively.

**Technical design:** *(directional decision matrix, not a prescribed diff — apply only the
matching row once the real error is observed)*

| Observed error signature | Likely cause | Fix |
|---|---|---|
| `403 PERMISSION_DENIED`, message mentions the API "has not been used" or "is disabled" | Google Photos Picker API not enabled on the Google Cloud project tied to `GOOGLE_CLIENT_ID` | Operational: enable "Google Photos Picker API" for the project in Google Cloud Console. Not a code change. |
| `403`, message mentions insufficient/invalid scope, or the OAuth consent screen predates the scope | `photospicker.mediaitems.readonly` not actually granted (stale consent from before the scope was added to `useGoogleAuth.ts`'s `SCOPES`) | Sign out and sign in again to force re-consent (`prompt=consent` is already set in `lib/pkce.ts`, so a fresh `signIn()` call should re-request all scopes); verify the OAuth consent screen in Google Cloud Console lists this scope. Operational, not a code change. |
| `401 UNAUTHENTICATED` immediately after a fresh sign-in | Access token not reaching Google as expected (e.g. stale/incorrect token forwarded) | Code: inspect the `Authorization` header actually sent from `useGoogleAuth`'s stored `accessToken` through to `extractBearer` in `lib/google-photos-server.ts` via browser DevTools' Network tab (not `console.log`/`console.error` of the token or header value, and not server-side logging) to avoid persisting a live bearer credential in devtools history or log aggregation; fix the specific handoff defect found; before considering this row done, confirm no debug logging of `accessToken` or the `Authorization` header value was left in the diff. |
| `400`, message complains about the request shape | Genuine malformed-request bug in `app/api/google-photos/sessions/route.ts`'s forwarded request | Code: correct the request body/headers sent to `photospicker.googleapis.com/v1/sessions` to match the `PickingSession` schema; add a regression test asserting the exact request shape. |

**Files:**
- Modify: only the file(s) implicated by the matching row above (scope not knowable until
  reproduced — see Deferred to Implementation)
- Test: `app/api/google-photos/sessions/route.test.ts` (extend, only if the matching fix is the
  malformed-request row — assert the exact request shape sent to Google)

**Approach:**
- Reproduce the reported flow with Units 1–2's improved visibility in place; read the error
  banner text and/or browser console for Google's real error code/message.
- Match against the decision matrix above and apply only that fix.
- If the matching cause is operational (API enablement or consent screen scope), no code change
  is needed — document the required Google Cloud Console step in this plan's Documentation /
  Operational Notes section (already included below) rather than inventing a code workaround for
  an infrastructure gap.

**Test scenarios:**
- Test expectation: none for the diagnosis step itself — it produces no code by definition.
- If the matching fix is the token-handoff row: add/extend a test in `hooks/useGoogleAuth.test.ts`
  or `hooks/useGooglePhotosPicker.test.ts` asserting the correct token value reaches the
  `Authorization` header sent to `/api/google-photos/sessions`.
- If the matching fix is the malformed-request row: add a test in
  `app/api/google-photos/sessions/route.test.ts` asserting the exact method, headers, and body
  the route sends to `photospicker.googleapis.com/v1/sessions`.

**Verification:**
- Manual end-to-end: sign in, click "Import from Google Photos," Picker opens in a new tab,
  selecting photos and returning to the app results in the photos appearing in the grid with
  Google Photos origin badges — the originally reported failure no longer occurs.

## System-Wide Impact

- **Interaction graph:** Only `useGooglePhotosPicker` and its two backing proxy routes change.
  `useGoogleAuth`, `usePhotos.addPhotos`, `useGooglePhotosUpload`, and the Picker polling/download
  loop's control flow are unaffected — only the content and reliability of error reporting on the
  session-creation and fetch-items steps changes.
- **Error propagation:** Errors now carry Google's actual detail from the proxy route through to
  the hook's `error` state and the console, instead of being replaced with a hardcoded string at
  the hook boundary. No new error propagates further than it already did (still terminal at
  `status = 'error'` within the hook).
- **State lifecycle risks:** None — `sessionIdRef`, `cancelledRef`, and cleanup-on-error behavior
  are unchanged; only the error message content changes.
- **Unchanged invariants:** The Picker session lifecycle (create → poll → fetch items → download
  → cleanup), the poll loop's silent-retry-on-transient-error behavior, and the upload flow
  (`useGooglePhotosUpload`) are explicitly not modified by this plan.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Root cause turns out to require a Google Cloud Console change the implementer can't make (no project access) | Unit 3's operational rows are called out explicitly so this is surfaced as a blocker to communicate, not silently worked around in code |
| Error message from Google may contain detail not meant for end users (e.g. internal project identifiers) | Show Google's `message` field only (already user-facing text in Google's API design), not the full raw JSON body, in the UI-facing string; full detail goes to `console.warn` only. Note: for the `403 SERVICE_DISABLED` case specifically, Google's `message` text itself embeds a GCP project number and Cloud Console URL — this mitigation doesn't strip that. Accepted as-is (reviewed 2026-08-09): a project number isn't highly sensitive and this is a locally-run app with a single user. |
| Fix for Unit 3's malformed-request row (if applicable) could be masked by Unit 1's defensive JSON wrapping if not tested carefully | Unit 1's tests explicitly assert the success path is unchanged; Unit 3 adds a request-shape assertion if that row is the one that applies |

## Documentation / Operational Notes

If Unit 3's diagnosis matches one of the two operational rows in its decision matrix (API not
enabled, or missing/ungranted scope), record the resolution here rather than as a code change:

- **Google Photos Picker API not enabled**: Enable "Google Photos Picker API" for the Google
  Cloud project tied to `GOOGLE_CLIENT_ID` in Google Cloud Console → APIs & Services → Library.
- **`photospicker.mediaitems.readonly` scope not granted**: Verify the OAuth consent screen in
  Google Cloud Console lists this scope, then sign out and sign in again in the app to force
  re-consent (`prompt=consent` in `lib/pkce.ts` already requests fresh consent on every
  `signIn()` call).

## Sources & References

- Related code: `hooks/useGooglePhotosPicker.ts`, `app/api/google-photos/sessions/route.ts`,
  `app/api/google-photos/sessions/[id]/route.ts`, `hooks/useGooglePhotosPicker.test.ts`
- Related plan: `docs/plans/2026-04-06-001-feat-google-photos-integration-plan.md`
- Related review: `.context/compound-engineering/ce-review/2026-04-06-001/run.md`
- Google Photos Picker API reference:
  https://developers.google.com/photos/picker/reference/rest/v1/sessions/create
- Google Photos Picker API getting started:
  https://developers.google.com/photos/picker/guides/get-started-picker
