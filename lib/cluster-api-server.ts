import { NextResponse } from 'next/server'
import { isTimeoutError, upstreamErrorBody } from '@/lib/google-photos-server'

// Shared fetch-plus-timeout handling for every route that proxies a request
// to photo-tidy-api. Centralizes the try/catch around the fetch (504 on
// timeout, 502 on any other failure to reach upstream) so each route only
// owns the parts that differ: building the request and interpreting the
// response.
//
// Returns the raw upstream Response on anything other than a timeout or
// unreachable-host failure — including every non-2xx status — so callers
// keep their own JSON-parsing/pass-through logic untouched.
export async function fetchUpstreamWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response } | { errorResponse: NextResponse }> {
  let response: Response
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if (isTimeoutError(err)) {
      return {
        errorResponse: NextResponse.json(
          upstreamErrorBody('Request to the clustering service timed out', 'REQUEST_TIMEOUT'),
          { status: 504 },
        ),
      }
    }
    return {
      errorResponse: NextResponse.json(
        upstreamErrorBody('Failed to reach the clustering service', 'UPSTREAM_UNREACHABLE'),
        { status: 502 },
      ),
    }
  }

  return { response }
}

// Parses the upstream JSON body with an explicit try/catch rather than
// `.catch(() => fallback)` — a malformed body must return an explicit error
// status, not silently pass through as if it were a valid success value.
// See docs/solutions/integration-issues/google-photos-json-parse-failure-returns-200.md.
export async function parseUpstreamJson(
  upstream: Response,
): Promise<{ data: unknown } | { errorResponse: NextResponse }> {
  try {
    const data: unknown = await upstream.json()
    return { data }
  } catch {
    return {
      errorResponse: NextResponse.json(
        upstreamErrorBody('Clustering service returned a non-JSON response', 'INVALID_UPSTREAM_RESPONSE'),
        { status: upstream.ok ? 502 : upstream.status },
      ),
    }
  }
}
