export function extractBearer(request: Request): string | null {
  const auth = request.headers.get('Authorization')
  if (!auth || !auth.startsWith('Bearer ')) return null
  return auth
}

export interface UpstreamErrorBody {
  error: { message: string; status: string; retryAfterMs?: number }
}

export function upstreamErrorBody(
  message: string,
  status: string,
  retryAfterMs?: number,
): UpstreamErrorBody {
  const error: UpstreamErrorBody['error'] = { message, status }
  if (retryAfterMs !== undefined) {
    error.retryAfterMs = retryAfterMs
  }
  return { error }
}

// Google's documented minimum backoff for a 429 when no Retry-After header
// is present. Recovery stays manual (the "Retry failed" action) — this is
// only used to populate a value the client can display, not to drive any
// automatic retry.
export const RATE_LIMIT_FLOOR_MS = 30_000

// Retry-After can be seconds (per RFC 9110) or an HTTP-date; Google's API
// documents the seconds form, so that's all this parses. Anything else
// (missing header, non-numeric, negative) falls back to the documented floor.
export function parseRetryAfterMs(retryAfterHeader: string | null): number {
  if (!retryAfterHeader) return RATE_LIMIT_FLOOR_MS
  const seconds = Number(retryAfterHeader)
  if (!Number.isFinite(seconds) || seconds < 0) return RATE_LIMIT_FLOOR_MS
  return seconds * 1000
}

// AbortSignal.timeout(ms) aborts fetch with a TimeoutError DOMException.
// Some runtimes surface a plain AbortError instead, so check both names
// rather than relying on one specific error shape. Checked via a `name`
// property rather than `instanceof Error`/`instanceof DOMException` —
// DOMException doesn't reliably extend Error (or exist as the same
// constructor) across every runtime this code can run in.
export function isTimeoutError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('name' in err)) return false
  const name = (err as { name: unknown }).name
  return name === 'TimeoutError' || name === 'AbortError'
}
