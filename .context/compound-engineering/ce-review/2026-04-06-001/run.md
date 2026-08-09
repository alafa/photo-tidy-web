# CE Review Run — 2026-04-06-001

**Branch:** feat/google-photos-integration  
**Base:** 1284e4caaa58d60a99f87bd70c46e03a4617c70f  
**Mode:** autofix  
**Plan:** docs/plans/2026-04-06-001-feat-google-photos-integration-plan.md  
**Reviewers:** security, correctness, reliability, testing, adversarial, kieran-typescript, maintainability

---

## Auto-fixes Applied (9)

1. **`hooks/useGooglePhotosPicker.ts`** — Promoted `CONCURRENCY = 5` to module-level `DOWNLOAD_CONCURRENCY` constant (maintainability)
2. **`hooks/useGooglePhotosPicker.ts`** — Moved poll timeout check to after each poll attempt so at least one poll fires before timeout (correctness P1)
3. **`hooks/useGooglePhotosPicker.ts`** — Added `cancelledRef.current` check after `await addPhotos(...)` to prevent adding photos post-cancel (correctness P2)
4. **`hooks/useGoogleAuth.ts`** — Moved CSRF state validation before the error branch so state is always checked (security P2)
5. **`app/api/google-photos/sessions/[id]/route.ts`** — Wrapped `id` path parameter with `encodeURIComponent()` in all upstream URLs to prevent query-string injection (security P2)
6. **`hooks/useGooglePhotosUpload.ts`** — Imported `UploadToken` and `Album` from `@/lib/google-photos-types`; removed duplicate local `UploadToken` interface (TypeScript P1)
7. **`hooks/useGooglePhotosUpload.ts`** — Cast `albumData` as `Album` type (TypeScript P1)
8. **`hooks/useGooglePhotosUpload.ts`** — Added `response.ok` check inside `batchCreate` that throws on failure (reliability/correctness P0/P1)
9. **`hooks/useGooglePhotosUpload.ts`** — Wrapped `batchCreate` calls in `startUpload` and `retryFailed` with try/catch → `setUploadState('error')` (reliability P1); fixed `retryFailed` to only submit new tokens, not previously committed ones (correctness P0)
10. **`hooks/useGooglePhotosUpload.test.ts`** — Updated `retryFailed` test to assert correct behavior (only retry tokens in batchCreate #2)

**Tests:** 128/128 passing after fixes.

---

## Residual Findings (requires judgment)

### P0
- **SSRF in download proxy** (`app/api/google-photos/download/route.ts:22`) — `baseUrl` is client-supplied, server fetches it with the user's Bearer token, response returned verbatim. Allowlist to `https://lh3.googleusercontent.com/` required. [security + adversarial]

### P1
- **`retryFailed` batchCreate fetch throw** — handled by auto-fix #9 above
- **Upload route no body size cap** (`app/api/google-photos/upload/route.ts:13`) — `await request.arrayBuffer()` has no size limit; potential memory exhaustion. Add Content-Length check or stream directly. [adversarial]
- **Popup message spoofing** (`hooks/useGoogleAuth.ts:103`) — state value is re-read from sessionStorage at message time; any same-origin script can read it first. Bind expected state in closure and verify `event.source === popupRef.current`. [adversarial]
- **Unvalidated `redirectUri` in token exchange** (`app/api/google/auth/token/route.ts:25`) — derive server-side from `Host` header or env var instead of trusting client body. [security + adversarial]
- **`startImport` stale closure guard** — `status !== 'idle'` check uses React state (not a ref), allowing two concurrent imports if called twice before re-render. Use `useRef` in-progress guard. [correctness + adversarial]
- **`startUpload` stale closure guard** — same pattern. [correctness]
- **`signOut` leaves dangling message listener** (`hooks/useGoogleAuth.ts:169`) — add `window.removeEventListener` + `popupRef.close()` in `signOut`. [correctness]

### P2
- **No proxy fetch timeouts** — upload, download, token exchange, and sessions routes have no `AbortSignal.timeout()`. Serverless functions can hang. Add 10–30s timeouts. [reliability]
- **`window.open` null not checked** (auth + picker) — popup blocked = silent hang. Capture return value, surface error. [correctness]
- **`sessionIdRef` not set before `setStatus`** — component unmount between session creation and ref assignment leaks Google Picker session. Move assignment earlier; add cleanup `useEffect`. [adversarial]
- **idToken decoded without signature verification** — cosmetic risk only; add advisory note. [security + adversarial]
- **Access token in JS memory** — XSS risk; HttpOnly cookie preferred but architectural change. [security]
- **`session-open` status never visibly renders** — `setStatus('picking')` follows synchronously after `window.open` with no await. Remove `session-open` from union or document this. [maintainability]
- **`startImport` 147-line function** — extract poll waiter and items fetch as separate helpers. [maintainability]
- **`getStoredPkce` unchecked cast** — add structural guard after `JSON.parse`. [TypeScript]

### P3 / Advisory
- No timeouts on sessions route proxied fetches
- Fire-and-forget session DELETE (acceptable)
- `lib/google-photos-server.ts` naming (rename to `api-auth.ts` or add comment)
- API route handlers untested (advisory — Next.js convention)
- Multiple testing gaps documented below

---

## Testing Gaps

- `batchCreate` failure path now fixed — but no test yet for the new `setUploadState('error')` behavior
- `visibilitychange` triggering immediate poll — untested
- Poll HTTP error swallowed, polling continues — untested
- Media items fetch failure path — untested
- `retryFailed` no-op when no failures — untested
- `batchCreate` chunking (>50 tokens) — untested
- `window.open` returning null — untested in both auth and picker hooks
- `useGoogleAuth` fetch rejection (network error during token exchange) — untested
- API route handler branches — untested (advisory)
