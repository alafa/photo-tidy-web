import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

afterEach(cleanup)

// --- Mocks ---

vi.mock('@/lib/pkce', () => ({
  generatePKCE: vi.fn(),
  buildGoogleAuthUrl: vi.fn(),
}))

import { generatePKCE, buildGoogleAuthUrl } from '@/lib/pkce'
const mockGeneratePKCE = vi.mocked(generatePKCE)
const mockBuildGoogleAuthUrl = vi.mocked(buildGoogleAuthUrl)

// Mock sessionStorage
const sessionStorageData: Record<string, string> = {}
vi.stubGlobal('sessionStorage', {
  getItem: vi.fn((key: string) => sessionStorageData[key] ?? null),
  setItem: vi.fn((key: string, value: string) => {
    sessionStorageData[key] = value
  }),
  removeItem: vi.fn((key: string) => {
    delete sessionStorageData[key]
  }),
})

// Mock fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Mock popup object
const mockPopup = {
  closed: false,
  focus: vi.fn(),
  close: vi.fn(),
}

import { useGoogleAuth } from './useGoogleAuth'

// Helper: build a minimal id_token with the given email
function makeIdToken(email: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }))
  const payload = btoa(JSON.stringify({ email, sub: '123' }))
  return `${header}.${payload}.signature`
}

function setupDefaultMocks() {
  mockGeneratePKCE.mockResolvedValue({ verifier: 'test-verifier', challenge: 'test-challenge' })
  mockBuildGoogleAuthUrl.mockReturnValue('https://accounts.google.com/auth?...')
}

beforeEach(() => {
  vi.clearAllMocks()
  // Clear sessionStorageData
  Object.keys(sessionStorageData).forEach((k) => delete sessionStorageData[k])
  mockPopup.closed = false
  mockPopup.focus.mockReset()
  vi.spyOn(window, 'open').mockReturnValue(mockPopup as unknown as Window)
  // Mock window.location.origin
  Object.defineProperty(window, 'location', {
    value: { origin: 'http://localhost:3000' },
    writable: true,
    configurable: true,
  })
  setupDefaultMocks()
})

// Helper: simulate a postMessage event
function dispatchAuthMessage(data: Record<string, unknown>) {
  const event = new MessageEvent('message', {
    data,
    origin: 'http://localhost:3000',
  })
  window.dispatchEvent(event)
}

// After signIn, sessionStorage is populated with verifier+state.
// We capture the state that was stored so the postMessage state matches.
function captureStoredState(): string | null {
  const raw = sessionStorageData['google_auth_pkce']
  if (!raw) return null
  try {
    return JSON.parse(raw).state as string
  } catch {
    return null
  }
}

describe('useGoogleAuth', () => {
  it('starts with isSignedIn=false', () => {
    const { result } = renderHook(() => useGoogleAuth())
    expect(result.current.isSignedIn).toBe(false)
    expect(result.current.accessToken).toBeNull()
  })

  describe('happy path: signIn flow', () => {
    it('opens a popup and sets isSignedIn=true after successful token exchange', async () => {
      const { result } = renderHook(() => useGoogleAuth())

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessToken: 'test-access-token',
          expiresIn: 3600,
          idToken: makeIdToken('user@example.com'),
        }),
      })

      await act(async () => {
        await result.current.signIn()
      })

      const storedState = captureStoredState()
      expect(storedState).not.toBeNull()

      await act(async () => {
        dispatchAuthMessage({
          type: 'GOOGLE_AUTH_CALLBACK',
          code: 'auth-code-123',
          state: storedState,
          error: null,
        })
      })

      expect(result.current.isSignedIn).toBe(true)
      expect(result.current.accessToken).toBe('test-access-token')
      expect(result.current.accountEmail).toBe('user@example.com')
    })

    it('calls token API with correct parameters', async () => {
      const { result } = renderHook(() => useGoogleAuth())

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessToken: 'tok',
          expiresIn: 3600,
          idToken: null,
        }),
      })

      await act(async () => {
        await result.current.signIn()
      })

      const storedState = captureStoredState()

      await act(async () => {
        dispatchAuthMessage({
          type: 'GOOGLE_AUTH_CALLBACK',
          code: 'code-abc',
          state: storedState,
          error: null,
        })
      })

      expect(mockFetch).toHaveBeenCalledWith('/api/google/auth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'code-abc',
          codeVerifier: 'test-verifier',
          redirectUri: 'http://localhost:3000/api/google/auth/callback',
        }),
      })
    })
  })

  describe('edge case: state mismatch', () => {
    it('does not exchange token and leaves isSignedIn=false', async () => {
      const { result } = renderHook(() => useGoogleAuth())

      await act(async () => {
        await result.current.signIn()
      })

      await act(async () => {
        dispatchAuthMessage({
          type: 'GOOGLE_AUTH_CALLBACK',
          code: 'auth-code-123',
          state: 'WRONG_STATE_VALUE',
          error: null,
        })
      })

      expect(mockFetch).not.toHaveBeenCalled()
      expect(result.current.isSignedIn).toBe(false)
    })
  })

  describe('edge case: postMessage with error field', () => {
    it('leaves isSignedIn=false and does not call token API', async () => {
      const { result } = renderHook(() => useGoogleAuth())

      await act(async () => {
        await result.current.signIn()
      })

      await act(async () => {
        dispatchAuthMessage({
          type: 'GOOGLE_AUTH_CALLBACK',
          code: null,
          state: null,
          error: 'access_denied',
        })
      })

      expect(mockFetch).not.toHaveBeenCalled()
      expect(result.current.isSignedIn).toBe(false)
    })
  })

  describe('edge case: token API returns non-200', () => {
    it('leaves isSignedIn=false', async () => {
      const { result } = renderHook(() => useGoogleAuth())

      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: 'invalid_grant' }),
      })

      await act(async () => {
        await result.current.signIn()
      })

      const storedState = captureStoredState()

      await act(async () => {
        dispatchAuthMessage({
          type: 'GOOGLE_AUTH_CALLBACK',
          code: 'bad-code',
          state: storedState,
          error: null,
        })
      })

      expect(result.current.isSignedIn).toBe(false)
      expect(result.current.accessToken).toBeNull()
    })
  })

  describe('signOut', () => {
    it('clears accessToken and sets isSignedIn=false', async () => {
      const { result } = renderHook(() => useGoogleAuth())

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessToken: 'token-to-clear',
          expiresIn: 3600,
          idToken: null,
        }),
      })

      await act(async () => {
        await result.current.signIn()
      })

      const storedState = captureStoredState()

      await act(async () => {
        dispatchAuthMessage({
          type: 'GOOGLE_AUTH_CALLBACK',
          code: 'code-xyz',
          state: storedState,
          error: null,
        })
      })

      expect(result.current.isSignedIn).toBe(true)

      act(() => {
        result.current.signOut()
      })

      expect(result.current.isSignedIn).toBe(false)
      expect(result.current.accessToken).toBeNull()
      expect(result.current.accountEmail).toBeNull()
    })
  })

  describe('isExpiringSoon', () => {
    it('is true when expiresAt is less than 5 minutes from now', async () => {
      const { result } = renderHook(() => useGoogleAuth())

      // expiresIn = 240 seconds = 4 minutes < 5 minutes
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessToken: 'token',
          expiresIn: 240,
          idToken: null,
        }),
      })

      await act(async () => {
        await result.current.signIn()
      })

      const storedState = captureStoredState()

      await act(async () => {
        dispatchAuthMessage({
          type: 'GOOGLE_AUTH_CALLBACK',
          code: 'code',
          state: storedState,
          error: null,
        })
      })

      expect(result.current.isExpiringSoon).toBe(true)
    })

    it('is false when expiresAt is more than 5 minutes from now', async () => {
      const { result } = renderHook(() => useGoogleAuth())

      // expiresIn = 3600 seconds = 1 hour > 5 minutes
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          accessToken: 'token',
          expiresIn: 3600,
          idToken: null,
        }),
      })

      await act(async () => {
        await result.current.signIn()
      })

      const storedState = captureStoredState()

      await act(async () => {
        dispatchAuthMessage({
          type: 'GOOGLE_AUTH_CALLBACK',
          code: 'code',
          state: storedState,
          error: null,
        })
      })

      expect(result.current.isExpiringSoon).toBe(false)
    })

    it('is false before sign-in', () => {
      const { result } = renderHook(() => useGoogleAuth())
      expect(result.current.isExpiringSoon).toBe(false)
    })
  })

  describe('popup already open', () => {
    it('focuses existing popup instead of opening a new one', async () => {
      const { result } = renderHook(() => useGoogleAuth())
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(mockPopup as unknown as Window)

      await act(async () => {
        await result.current.signIn()
      })

      // Call signIn again while popup is still open (mockPopup.closed = false)
      openSpy.mockClear()

      await act(async () => {
        await result.current.signIn()
      })

      expect(openSpy).not.toHaveBeenCalled()
      expect(mockPopup.focus).toHaveBeenCalled()
    })
  })

  describe('ignores messages from other origins', () => {
    it('does not process messages from a different origin', async () => {
      const { result } = renderHook(() => useGoogleAuth())

      await act(async () => {
        await result.current.signIn()
      })

      await act(async () => {
        const event = new MessageEvent('message', {
          data: { type: 'GOOGLE_AUTH_CALLBACK', code: 'code', state: 'state', error: null },
          origin: 'https://evil.example.com',
        })
        window.dispatchEvent(event)
      })

      expect(mockFetch).not.toHaveBeenCalled()
      expect(result.current.isSignedIn).toBe(false)
    })
  })
})
