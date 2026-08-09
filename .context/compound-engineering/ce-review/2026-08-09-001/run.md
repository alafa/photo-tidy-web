# Code Review Run — 2026-08-09-001

**Scope:** `git diff 136889eec8f82615f0d2435682c6023b2291614c..HEAD` plus working-tree changes on `feat/google-photos-integration` — the "fix Google Photos import session error" bug fix.
**Plan:** `docs/plans/2026-08-09-001-fix-google-photos-import-session-error-plan.md`
**Files:** `app/api/google-photos/sessions/route.ts`, `app/api/google-photos/sessions/[id]/route.ts`, `hooks/useGooglePhotosPicker.ts`, `lib/google-photos-server.ts`, `lib/google-photos-types.ts`, plus their test files.
**Reviewers:** correctness, testing, maintainability, project-standards, security, reliability, api-contract, adversarial, kieran-typescript, julik-frontend-races (all haiku-tier), agent-native-reviewer, learnings-researcher.

## Verdict

Ready to merge after fixes below (all applied in this run).

## Fixes Applied

1. **Unguarded success-path `res.json()` in `hooks/useGooglePhotosPicker.ts`** (session-creation step, fetch-items step) — flagged independently at P0/P1/P2 by testing, reliability, kieran-typescript, julik-frontend-races, adversarial, correctness, and maintainability reviewers. The error-handling restructure earlier in this fix moved `res.json()` outside the try/catch that used to protect it; a malformed 200-OK body would throw unhandled. Wrapped both call sites in try/catch with a distinct fallback error message.
2. **Server routes returned an error-shaped body with a 200 status** (`app/api/google-photos/sessions/route.ts` POST, `app/api/google-photos/sessions/[id]/route.ts` GET) when `upstream.ok` was true but `upstream.json()` threw — flagged by correctness, maintainability, and adversarial reviewers. Restructured to return a proper 502 in that case instead of silently returning the error fallback body under a success status.
3. **Inconsistent 401 error-body shape** — the "Missing or invalid Authorization header" responses across all three route handlers used a flat `{ error: 'string' }` shape while every other error path used the nested `{ error: { message, status } }` shape the client's `describeApiError` reads. Flagged by api-contract reviewer (confidence 0.85). Standardized all three to the nested shape via the existing `upstreamErrorBody()` helper.

Regression tests added for all three: 2 new hook tests (`useGooglePhotosPicker.test.ts`), 2 new route tests (one per file, for the "ok:true + non-JSON body" case), and 3 updated 401 tests now assert the nested error shape. Full suite (150 tests), lint, and scoped `tsc` all pass after fixes.

## Residual / Not Fixed (low priority, noted not actioned)

- kieran-typescript (P2, 0.75): `parseErrorBody`'s `as GooglePhotosApiError` cast has no runtime validation. Low risk in practice — every read site uses optional chaining, so a shape mismatch degrades to "no detail" rather than crashing. Left as-is; a full runtime type guard is more machinery than this bug-fix warrants.
- security (residual, no P0-P2 findings): suggested a test asserting the exact `console.warn` payload shape (to catch accidental over-logging) and a test proving the Authorization header is never logged. Code inspection confirms neither currently happens; treated as nice-to-have, not required for this fix.
- adversarial (residual): cancellation timing between `await parseErrorBody(res)` and the `cancelledRef.current` check — pre-existing pattern, not introduced by this diff, guarded the same way the rest of the file already guards it.
- learnings-researcher: no `docs/solutions/` entry exists for Google API proxy error-handling; suggested documenting this pattern post-merge. Optional follow-up, not blocking.
- agent-native-reviewer: no gaps — this diff has no agent-facing surface.
- project-standards: no findings.
