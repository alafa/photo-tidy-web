---
title: "Google Photos API Routes Silently Returned 200 Instead of 502 on Non-JSON Upstream Bodies"
date: 2026-08-09
category: integration-issues
module: google-photos-import
problem_type: integration_issue
component: tooling
related_components:
  - authentication
symptoms:
  - "Google Photos session-creation (POST /api/google-photos/sessions) and session-detail (GET /api/google-photos/sessions/[id]) routes returned HTTP 200 with an error-shaped payload (`{error: {message, status: 'INVALID_UPSTREAM_RESPONSE'}}`) instead of a 502, whenever Google's Picker API returned a non-JSON body on an ok (2xx) upstream response"
  - "Client code in useGooglePhotosPicker treated the malformed error payload as a valid PickerSession or MediaItemsResponse because the route reported success (status 200), risking downstream runtime errors from reading fields off an error object"
  - "Unhandled promise rejection in useGooglePhotosPicker when res.json() threw on a non-JSON response body during session creation or media-items fetch, instead of surfacing a user-facing error state"
  - "401 'missing/invalid Authorization header' responses used an inconsistent bare `{ error: string }` shape instead of the structured upstreamErrorBody('...', 'UNAUTHENTICATED') format used by the rest of the route"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - google-photos
  - error-handling
  - api-routes
  - json-parsing
  - status-codes
  - next-js
  - upstream-response
---

# Google Photos API Routes Silently Returned 200 Instead of 502 on Non-JSON Upstream Bodies

## Problem

The Google Photos Picker API routes (`app/api/google-photos/sessions/route.ts`, `app/api/google-photos/sessions/[id]/route.ts`) parsed the upstream response with `upstream.json().catch(() => upstreamErrorBody(...))`. When Google returned HTTP 200 (`upstream.ok === true`) but a body that failed to parse as JSON, the `.catch()` silently substituted an error-shaped fallback object as `data`, which then flowed through the unchanged `!upstream.ok` check and fell to `return NextResponse.json(data)` — returning the error payload wrapped in a 200 OK instead of a 502. `hooks/useGooglePhotosPicker.ts` had the mirror-image gap: two `res.json()` call sites had no try/catch at all, so a non-JSON body there produced an unhandled promise rejection instead of a user-facing error.

## Symptoms

- A route returns HTTP 200 with a body shaped like `{ error: { message: '...', status: 'INVALID_UPSTREAM_RESPONSE' } }` instead of a 502.
- Client code that checks `res.ok` (or relies on a 2xx status) treats the error object as real session/media data and either crashes downstream or silently misbehaves.
- In `useGooglePhotosPicker.ts`, an upstream non-JSON body on session creation or media-item fetch produces an unhandled promise rejection (uncaught `SyntaxError` from `.json()`) rather than setting `status: 'error'` with a user-facing message.
- 401 "missing/invalid Authorization header" responses returned a bare `{ error: 'Missing or invalid Authorization header' }`, inconsistent with the structured `{ error: { message, status } }` shape used by every other error path in the same routes.

## What Didn't Work

The route handlers and hook were originally written as a single opaque generic error ("Failed to create import session") with no diagnostic detail surfaced anywhere, which made a real upstream failure indistinguishable from any other failure mode. A prior session reworked this to add real error surfacing (`GooglePhotosApiError` type, `describeApiError` hook helper, structured `upstreamErrorBody()` envelope) and, mid-implementation, discovered that `console.error` for the new diagnostic logging triggered Next.js's dev-mode error overlay; the fix was switching to `console.warn`, matching an existing "log without alarming" convention already used in `downloadBatch` (session history).

That rework itself introduced this doc's bug as a regression. The original code had the whole response-handling flow inside one try/catch, so a bad body anywhere would land as *some* error; splitting the logic to add structured errors left three new gaps that a follow-up 12-persona `ce-review` pass caught against the diff (session history, `.context/compound-engineering/ce-review/2026-08-09-001/run.md`):

1. `useGooglePhotosPicker.ts`'s two success-path `res.json()` calls were left outside any try/catch — a malformed 200-OK body would throw unhandled.
2. The GET handler in `app/api/google-photos/sessions/[id]/route.ts` (and the POST handler in `app/api/google-photos/sessions/route.ts`) returned an error-shaped body with HTTP 200 when `upstream.ok` was true but the body failed to parse — the exact bug this doc describes. The `DELETE` handler was checked and confirmed already correct, since its only `.json()` call sits entirely inside the `!upstream.ok` branch.
3. The 401 responses used a flat `{ error: 'string' }` shape instead of the nested envelope `describeApiError` expected elsewhere, so the message would silently disappear if that branch were ever hit.

The pattern that looked reasonable but was wrong:

```ts
const data = await upstream
  .json()
  .catch(() => upstreamErrorBody('Upstream returned a non-JSON response', 'INVALID_UPSTREAM_RESPONSE'))

if (!upstream.ok) {
  return NextResponse.json(data, { status: upstream.status })
}
return NextResponse.json(data)
```

This never throws, and `data` always holds *some* value, including a sensible-looking error shape when parsing fails. The bug is that `.catch()` here only supplies a fallback **value** for a variable — it doesn't change the **control flow** that decides the HTTP status. The status logic (`if (!upstream.ok) { ...status: upstream.status } else { ...200 }`) assumed the branch it took was fully determined by whether Google's HTTP call succeeded. But a JSON-parse failure is an orthogonal failure mode that can happen even when `upstream.ok` is `true`. Since `.catch()` swallowed the parse error into a normal return value, the `upstream.ok` check had no way to know a failure had occurred, and routed the fake error object down the 200-success path.

## Solution

**Server route pattern** (`app/api/google-photos/sessions/route.ts:29-43`, and the same shape in `app/api/google-photos/sessions/[id]/route.ts:36-50` for `GET`):

```ts
let data: unknown
try {
  data = await upstream.json()
} catch {
  return NextResponse.json(
    upstreamErrorBody('Upstream returned a non-JSON response', 'INVALID_UPSTREAM_RESPONSE'),
    { status: upstream.ok ? 502 : upstream.status },
  )
}

if (!upstream.ok) {
  return NextResponse.json(data, { status: upstream.status })
}

return NextResponse.json(data)
```

The catch block now `return`s immediately with an explicit status computed right there: `502` if Google claimed success (`upstream.ok`) but lied about the body being JSON, or `upstream.status` if Google's own error status should be preserved. Nothing falls through to the success-path `return NextResponse.json(data)`.

The 401 paths were also normalized to use the shared helper, e.g. (`app/api/google-photos/sessions/route.ts:6-11`):

```ts
if (!authHeader) {
  return NextResponse.json(
    upstreamErrorBody('Missing or invalid Authorization header', 'UNAUTHENTICATED'),
    { status: 401 },
  )
}
```

(`upstreamErrorBody` is defined in `lib/google-photos-server.ts:11-13` as `{ error: { message, status } }`, alongside `extractBearer` at `lib/google-photos-server.ts:1-5`.)

**Hook pattern** (`hooks/useGooglePhotosPicker.ts:173-181` for session creation, `hooks/useGooglePhotosPicker.ts:280-290` for media items):

```ts
try {
  session = await res.json() as PickerSession
} catch {
  if (!cancelledRef.current) {
    setStatus('error')
    setError('Failed to create import session: server returned an invalid response')
  }
  return
}
```

```ts
try {
  mediaItemsResponse = await res.json() as MediaItemsResponse
} catch {
  if (!cancelledRef.current) {
    setStatus('error')
    setError('Failed to fetch selected photos: server returned an invalid response')
    cleanupSession(session.id)
    sessionIdRef.current = null
  }
  return
}
```

The media-items catch additionally tears down the now-orphaned picker session (`cleanupSession(session.id)`) and clears `sessionIdRef.current`, matching the cleanup already done on the adjacent `!res.ok` branch a few lines above.

Note: the `DELETE` handler in `app/api/google-photos/sessions/[id]/route.ts:80-84` still uses `.catch()` (`await upstream.json().catch(() => upstreamErrorBody('Delete failed', ...))`) — but that call site sits entirely inside the `if (!upstream.ok)` branch, so the fallback value is only ever used to build the already-determined error-status response. There's no success path it could leak into, so the pattern is safe there. This is a useful contrast case: the anti-pattern is specifically about `.catch()`-fallback values that can still reach a status branch written for the non-error case.

## Why This Works

`.catch(() => fallbackValue)` chained onto a data-producing promise converts a *rejection* into a *resolved value*. From the perspective of any code downstream, there's no distinction left between "parsing genuinely succeeded and produced this object" and "parsing failed and this is a stand-in." If a status-code decision downstream was written assuming the promise's resolution implies success, that decision is now silently wrong whenever the fallback path was actually taken — the failure gets dressed up as data and rides whatever branch the *original* control flow (here, `upstream.ok`, which reflects a completely different signal: the HTTP transport status) had already staked out.

The fix replaces the value-fallback with try/catch used as actual control flow: the `catch` block doesn't produce a value to be consumed later — it `return`s immediately, deciding the HTTP status right at the point the failure is known, using information (`upstream.ok`) still in scope. This keeps "a JSON-parse failure happened" and "what status code we send" tightly coupled, instead of letting the failure get laundered into ordinary data and re-decided by unrelated logic several lines later.

## Prevention

**Rule**: When parsing a response body that can fail (`.json()`, `.text()` + manual parse, etc.) and the result feeds into a decision (an HTTP status to return, a type-narrowed variable used later), catch the failure and `return`/`throw` immediately inside the `catch` block with an explicit outcome. Don't use `.catch(() => fallbackValue)` to keep it as one expression — the fallback value re-enters ordinary control flow and can be misrouted by logic written assuming success.

Anti-pattern vs. fix, generically:

```ts
// Anti-pattern: failure becomes a normal-looking value that flows
// through status/branch logic written for the success case.
const data = await res.json().catch(() => ({ error: 'parse failed' }))
if (!res.ok) return json(data, { status: res.status })
return json(data) // BUG: parse failures on an ok response return 200

// Fix: catch is control flow — decide and return right there.
let data: unknown
try {
  data = await res.json()
} catch {
  return json({ error: 'parse failed' }, { status: res.ok ? 502 : res.status })
}
if (!res.ok) return json(data, { status: res.status })
return json(data)
```

**Test pattern used here**: mock `.json()` (or `res.json()`) to `throw new SyntaxError('Unexpected token')` while `ok: true, status: 200`, then assert the resulting status is the explicit failure status (502 for the server routes; `status === 'error'` with a non-empty message for the hook) — never the success-path default. See `app/api/google-photos/sessions/route.test.ts` ("returns a structured 502 error, not a 200, when Google responds ok but with a non-JSON body"), the analogous test in `app/api/google-photos/sessions/[id]/route.test.ts`, and the two "sets status=error when the response is ok but the body is not valid JSON" tests in `hooks/useGooglePhotosPicker.test.ts`.

**Review-process note**: this exact bug was a regression introduced while fixing a different, unrelated problem (opaque error messages) in the same feature area, and was only caught by a follow-up structured code-review pass rather than by the implementation session itself (session history). When splitting a single try/catch block into more granular error handling to improve diagnostics, re-check every code path that used to be covered by the old block — granular error handling multiplies the number of paths, and it's easy to widen diagnostic coverage while narrowing status-code correctness.

## Related Issues

- `docs/plans/2026-08-09-001-fix-google-photos-import-session-error-plan.md` — the plan behind this fix.
- `docs/plans/2026-04-06-001-feat-google-photos-integration-plan.md` — the original Google Photos integration feature plan.
- `.context/compound-engineering/ce-review/2026-08-09-001/run.md` — the code-review pass that caught this regression before it shipped.
- `docs/solutions/logic-errors/stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md` — a related but distinct hazard in the same `useGooglePhotosPicker.ts`/Google Photos integration surface: a cross-call timing race (shared `useRef` read after an `await`, corrupted by a concurrent invocation) rather than this doc's same-call control-flow laundering bug. The review-fix commit for that doc (unmerged into `main` as of this writing) also propagated this doc's try/catch pattern to the `albums`, `batch-create`, `upload`, and auth-token routes.
