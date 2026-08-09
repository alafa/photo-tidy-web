'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { generatePKCE, buildGoogleAuthUrl } from '@/lib/pkce'

const PKCE_STORAGE_KEY = 'google_auth_pkce'
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/photospicker.mediaitems.readonly',
  'https://www.googleapis.com/auth/photoslibrary.appendonly',
]

interface PkceStorageEntry {
  verifier: string
  state: string
}

interface TokenApiResponse {
  accessToken: string
  expiresIn: number
  idToken: string | null
}

function parseEmailFromIdToken(idToken: string): string | null {
  try {
    const parts = idToken.split('.')
    if (parts.length < 2) return null
    const payload = parts[1]
    // Re-pad base64url to base64
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const decoded = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = JSON.parse(decoded)
    return typeof claims.email === 'string' ? claims.email : null
  } catch {
    return null
  }
}

export function useGoogleAuth() {
  const [accessToken, setAccessToken] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [accountEmail, setAccountEmail] = useState<string | null>(null)
  const [isExpiringSoon, setIsExpiringSoon] = useState(false)

  const popupRef = useRef<Window | null>(null)
  const listenerRef = useRef<((event: MessageEvent) => void) | null>(null)

  const isSignedIn = accessToken !== null

  // Poll every 60 seconds to keep isExpiringSoon current
  useEffect(() => {
    const checkExpiry = () => {
      setIsExpiringSoon(expiresAt !== null && expiresAt - Date.now() < 5 * 60 * 1000)
    }
    const interval = setInterval(checkExpiry, 60_000)
    return () => clearInterval(interval)
  }, [expiresAt])

  // Cleanup listener on unmount
  useEffect(() => {
    return () => {
      if (listenerRef.current) {
        window.removeEventListener('message', listenerRef.current)
        listenerRef.current = null
      }
    }
  }, [])

  const signIn = useCallback(async () => {
    // If popup already open, focus it
    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.focus()
      return
    }

    const { verifier, challenge } = await generatePKCE()
    const state = base64UrlRandom()

    const pkceEntry: PkceStorageEntry = { verifier, state }
    sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(pkceEntry))

    const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? ''
    const redirectUri = `${window.location.origin}/api/google/auth/callback`

    const authUrl = buildGoogleAuthUrl({
      clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
      scopes: SCOPES,
    })

    const popup = window.open(authUrl, 'google-auth', 'width=500,height=650')
    popupRef.current = popup

    // Remove any existing listener before adding a new one
    if (listenerRef.current) {
      window.removeEventListener('message', listenerRef.current)
    }

    const handleMessage = async (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (!event.data || event.data.type !== 'GOOGLE_AUTH_CALLBACK') return

      // Always clean up listener after handling
      window.removeEventListener('message', handleMessage)
      listenerRef.current = null

      // Read stored entry before removing it
      const storedEntry = getStoredPkce()
      sessionStorage.removeItem(PKCE_STORAGE_KEY)

      // Validate state first — CSRF protection applies to all paths including errors
      if (!storedEntry || event.data.state !== storedEntry.state) {
        // State mismatch — potential CSRF, ignore
        setAccessToken(null)
        setExpiresAt(null)
        setIsExpiringSoon(false)
        setAccountEmail(null)
        return
      }

      if (event.data.error) {
        setAccessToken(null)
        setExpiresAt(null)
        setIsExpiringSoon(false)
        setAccountEmail(null)
        return
      }

      const { code } = event.data
      const codeVerifier = storedEntry.verifier

      try {
        const response = await fetch('/api/google/auth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, codeVerifier, redirectUri }),
        })

        if (!response.ok) {
          setAccessToken(null)
          setExpiresAt(null)
          setIsExpiringSoon(false)
          setAccountEmail(null)
          return
        }

        const data: TokenApiResponse = await response.json()
        const newExpiresAt = Date.now() + data.expiresIn * 1000
        const email = data.idToken ? parseEmailFromIdToken(data.idToken) : null

        setAccessToken(data.accessToken)
        setExpiresAt(newExpiresAt)
        setIsExpiringSoon(newExpiresAt - Date.now() < 5 * 60 * 1000)
        setAccountEmail(email)
      } catch {
        setAccessToken(null)
        setExpiresAt(null)
        setIsExpiringSoon(false)
        setAccountEmail(null)
      }
    }

    listenerRef.current = handleMessage
    window.addEventListener('message', handleMessage)
  }, [])

  const signOut = useCallback(() => {
    setAccessToken(null)
    setExpiresAt(null)
    setIsExpiringSoon(false)
    setAccountEmail(null)
  }, [])

  return {
    accessToken,
    expiresAt,
    accountEmail,
    isSignedIn,
    isExpiringSoon,
    signIn,
    signOut,
  }
}

function base64UrlRandom(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
}

function getStoredPkce(): PkceStorageEntry | null {
  try {
    const raw = sessionStorage.getItem(PKCE_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PkceStorageEntry
  } catch {
    return null
  }
}
