---
title: "Google Photos Picker Import Only Fetched One Page of mediaItems, Silently Dropping the Rest of Large Selections"
date: 2026-08-15
category: integration-issues
module: google-photos-import
problem_type: integration_issue
component: tooling
related_components:
  - google-photos-picker
symptoms:
  - "Selecting more photos than fit in one page of Google's Picker API response only imports the first page; the rest are silently dropped with no error shown to the user."
  - "MediaItemsResponse.nextPageToken was typed in lib/google-photos-types.ts but never read anywhere in the codebase."
  - "useGooglePhotosPicker.ts's Step 4 media-items fetch called the session route exactly once per import, with no loop or check for further pages."
  - "app/api/google-photos/sessions/[id]/route.ts had no way to forward a pageToken to the upstream mediaItems.list call, so even a client that wanted to request page 2 had no server-side path to do so."
  - "The failure looked like a generic 'some photos didn't import' issue rather than a pagination bug, since no error state or log distinguished 'truncated by pagination' from any other partial-import scenario."
root_cause: missing_workflow_step
resolution_type: code_fix
severity: high
tags:
  - google-photos
  - pagination
  - picker-api
  - mediaitems
  - import
  - next-page-token
---

# Google Photos Picker Import Only Fetched One Page of mediaItems, Silently Dropping the Rest of Large Selections

## Problem

Selecting more photos than fit on a single page of Google's Photos Picker `mediaItems.list` response only imported the first page — everything past it silently vanished, with no error or warning telling the user photos were missing.

## Symptoms

- User selects a large batch of photos in the Google Photos picker UI, but the app only imports a subset of them.
- No error message, warning, or partial-success indicator appears — from the user's perspective the missing photos simply never showed up.
- The bug only manifests once a selection is large enough to span more than one page of Google's `mediaItems.list` response; small selections work fine, which made it easy to miss in casual testing.
- Surfaced when the user asked "why it is still not loading all photos when I select" immediately after an unrelated Google Photos album-upload reconciliation fix had just shipped on the same branch — investigation traced it to this separate pagination gap, not the just-fixed reconciliation bug.

## What Didn't Work

N/A — the pagination gap was identified and fixed directly on first investigation; there was no prior failed fix attempt for this specific bug in this session.

(session history) Checked the two most relevant prior sessions on this codebase — the session that originally built this picker-import feature (`feat/google-photos-integration`, 2026-08-09) and a later session that reworked the adjacent upload/reconciliation flow (`develop`, 2026-08-09 to 2026-08-10). Neither ever discusses `nextPageToken`, `maxItemCount`, or page-size limits for the Picker API's `mediaItems.list` call — the picker's item-fetch was treated as a single unpaginated call throughout both. This wasn't a regression or a previously-known-and-deferred issue; it was an omission present from the feature's original implementation that nobody had reason to notice until a large enough selection hit it.

## Solution

`hooks/useGooglePhotosPicker.ts`'s Step 4 (fetching selected media items after the user finishes picking) used to call the items endpoint exactly once and treat whatever came back as the complete selection. It now loops, following `nextPageToken` until Google reports none, accumulating every page into `allMediaItems` (`hooks/useGooglePhotosPicker.ts:259-318`):

```ts
// Step 4: Fetch media items. Google's mediaItems.list endpoint paginates
// — a selection larger than one page's worth returns a nextPageToken
// that must be followed, or the rest of the selection is silently
// dropped. Loop until Google reports no further pages. MAX_PAGES is a
// safety cap against a pathological/looping token, not an expected limit.
const MAX_PAGES = 50
const allMediaItems: PickedMediaItem[] = []
let pageToken: string | undefined
let pageCount = 0

do {
  let res: Response
  const url = pageToken
    ? `/api/google-photos/sessions/${session.id}?items=true&pageToken=${encodeURIComponent(pageToken)}`
    : `/api/google-photos/sessions/${session.id}?items=true`
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    })
  } catch {
    // ...error handling omitted for brevity...
  }

  // ...response validation omitted for brevity...

  allMediaItems.push(...(page.mediaItems ?? []))
  pageToken = page.nextPageToken
  pageCount += 1
} while (pageToken && pageCount < MAX_PAGES)
```

`MAX_PAGES = 50` is a safety cap against a pathological/looping token, not an expected ceiling on selection size.

The proxy route, `app/api/google-photos/sessions/[id]/route.ts`, now reads an optional `pageToken` search param and forwards it to the upstream `mediaItems.list` call when present (`app/api/google-photos/sessions/[id]/route.ts:16-25`):

```ts
const { id } = await params
const { searchParams } = new URL(request.url)
const items = searchParams.get('items') === 'true'
const pageToken = searchParams.get('pageToken')

const url = items
  ? `https://photospicker.googleapis.com/v1/mediaItems?sessionId=${encodeURIComponent(id)}${
      pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''
    }`
  : `https://photospicker.googleapis.com/v1/sessions/${encodeURIComponent(id)}`
```

The `nextPageToken?: string` field the loop follows was already declared on `MediaItemsResponse` in `lib/google-photos-types.ts:31-34` before this fix — it just had no reader anywhere in the codebase:

```ts
export interface MediaItemsResponse {
  mediaItems: PickedMediaItem[]
  nextPageToken?: string
}
```

Two new tests in `hooks/useGooglePhotosPicker.test.ts`, under `describe('edge case: media items response is paginated', ...)` (`hooks/useGooglePhotosPicker.test.ts:656-728`), cover both directions:

- `'follows nextPageToken across multiple pages and imports every item, not just the first page'` — mocks a 2-page response (2 items + `nextPageToken: 'page-2-token'`, then 1 item with no token), asserts `addPhotos` receives all 3 files, and asserts the second items-fetch call's URL carries `&pageToken=page-2-token`.
- `'stops paginating once a page has no nextPageToken, making exactly one items-fetch call for a single page'` — the regression guard: a single-page response must still result in exactly one items-fetch call, so the common case's behavior and request count are unchanged.

`app/api/google-photos/sessions/[id]/route.test.ts` adds `'forwards pageToken to the upstream mediaItems.list call when present'` (`app/api/google-photos/sessions/[id]/route.test.ts:58-73`), asserting a request with `?items=true&pageToken=abc123` produces an upstream call to `https://photospicker.googleapis.com/v1/mediaItems?sessionId=abc&pageToken=abc123`.

## Why This Works

Pagination is a per-page contract that most list-returning APIs impose: a single response is documented and typed as *a* page, not *the* result. Treating a paginated endpoint's first response as the complete answer is a recurring class of bug precisely because the failure is silent — there's no error, no thrown exception, just a truncated result that looks superficially correct for small inputs. That's exactly what happened here: `MediaItemsResponse.nextPageToken?: string` was declared in the type from the start, so the type system "knew" pagination existed, but a declared-but-unread field gives zero compile-time protection against forgetting to actually loop on it. TypeScript will happily let code ignore an optional field forever; nothing forces a consumer to check it, let alone act on it.

## Prevention

When wrapping any Google (or other) list-returning API, grep the response type for a `nextPageToken` / `pageToken` / similar field before considering the integration complete. If the type declares one, the follow-up loop is not optional polish — it is part of the correct implementation, and skipping it is a bug regardless of whether small test selections happen to hide it.

Concrete test pattern to mirror: the two new cases in `hooks/useGooglePhotosPicker.test.ts` under `describe('edge case: media items response is paginated', ...)`:
1. A multi-page case that asserts every item across all pages ends up in the final result, and that each subsequent request URL carries the prior page's token.
2. A single-page regression case that asserts exactly one fetch call — so the pagination loop's addition doesn't inadvertently change behavior or add requests for the common, unpaginated case.

Any future endpoint wrapper that consumes a paginated upstream API should ship with both shapes of test from the start, not added after a user reports missing data.

## Related Issues

- `docs/solutions/integration-issues/google-photos-json-parse-failure-returns-200.md` — a related but distinct hazard in the same `useGooglePhotosPicker.ts` media-items fetch and the same `app/api/google-photos/sessions/[id]/route.ts` GET handler: that doc is about a JSON-parse failure being laundered into a false-success status code (a same-call control-flow bug), rather than this doc's missing continuation-loop omission across separate calls.
- `docs/solutions/logic-errors/stale-shared-ref-read-after-concurrent-invocation-in-async-hooks.md` — another related but distinct hazard in the same file: that doc is about a shared `useRef` value being read after an `await`, corrupted by a concurrent invocation of the same hook, rather than this doc's single-invocation, no-concurrency omission of a pagination loop.
- This fix lives on branch `fix/google-photos-sync`, unmerged into `main` as of this writing.
