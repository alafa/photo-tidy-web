import { describe, it, expect } from 'vitest'
import { parseRetryAfterMs, isTimeoutError, RATE_LIMIT_FLOOR_MS } from './google-photos-server'

describe('parseRetryAfterMs', () => {
  it('returns the 30s floor when the header is absent', () => {
    expect(parseRetryAfterMs(null)).toBe(RATE_LIMIT_FLOOR_MS)
    expect(parseRetryAfterMs(null)).toBe(30000)
  })

  it('converts a valid positive-seconds string to milliseconds', () => {
    expect(parseRetryAfterMs('8')).toBe(8000)
  })

  it('returns the 30s floor for a non-numeric string (HTTP-date form)', () => {
    expect(parseRetryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT')).toBe(RATE_LIMIT_FLOOR_MS)
  })

  it('returns the 30s floor for garbage input', () => {
    expect(parseRetryAfterMs('abc')).toBe(RATE_LIMIT_FLOOR_MS)
  })

  it('returns the 30s floor for a negative numeric string', () => {
    expect(parseRetryAfterMs('-5')).toBe(RATE_LIMIT_FLOOR_MS)
  })
})

describe('isTimeoutError', () => {
  it('returns true for an object with name TimeoutError', () => {
    expect(isTimeoutError({ name: 'TimeoutError' })).toBe(true)
  })

  it('returns true for an object with name AbortError', () => {
    expect(isTimeoutError({ name: 'AbortError' })).toBe(true)
  })

  it('returns false for an object with an unrelated name', () => {
    expect(isTimeoutError({ name: 'SyntaxError' })).toBe(false)
  })

  it('returns false for non-object values', () => {
    expect(isTimeoutError('TimeoutError')).toBe(false)
    expect(isTimeoutError(null)).toBe(false)
    expect(isTimeoutError(undefined)).toBe(false)
  })
})
