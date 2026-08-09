import { describe, it, expect } from 'vitest'
import { generatePKCE, buildGoogleAuthUrl } from './pkce'

describe('generatePKCE', () => {
  it('returns a verifier and challenge', async () => {
    const { verifier, challenge } = await generatePKCE()
    expect(typeof verifier).toBe('string')
    expect(verifier.length).toBeGreaterThan(0)
    expect(typeof challenge).toBe('string')
    expect(challenge.length).toBeGreaterThan(0)
  })

  it('challenge is URL-safe base64 with no padding', async () => {
    const { challenge } = await generatePKCE()
    // Must not contain +, /, or =
    expect(challenge).not.toMatch(/[+/=]/)
    // Must only contain URL-safe base64 chars
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/)
  })

  it('challenge is SHA-256 of verifier encoded as URL-safe base64', async () => {
    const { verifier, challenge } = await generatePKCE()

    // Independently compute expected challenge
    const encoder = new TextEncoder()
    const data = encoder.encode(verifier)
    const hashBuffer = await crypto.subtle.digest('SHA-256', data)
    const bytes = new Uint8Array(hashBuffer)
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    const expected = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')

    expect(challenge).toBe(expected)
  })

  it('returns different pairs on successive calls', async () => {
    const first = await generatePKCE()
    const second = await generatePKCE()

    expect(first.verifier).not.toBe(second.verifier)
    expect(first.challenge).not.toBe(second.challenge)
  })
})

describe('buildGoogleAuthUrl', () => {
  const baseParams = {
    clientId: 'test-client-id',
    redirectUri: 'https://example.com/callback',
    state: 'random-state-value',
    codeChallenge: 'test-challenge',
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/photoslibrary.readonly'],
  }

  it('returns a URL for Google OAuth endpoint', () => {
    const url = buildGoogleAuthUrl(baseParams)
    expect(url).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth/)
  })

  it('includes response_type=code', () => {
    const url = buildGoogleAuthUrl(baseParams)
    const params = new URL(url).searchParams
    expect(params.get('response_type')).toBe('code')
  })

  it('includes code_challenge', () => {
    const url = buildGoogleAuthUrl(baseParams)
    const params = new URL(url).searchParams
    expect(params.get('code_challenge')).toBe('test-challenge')
  })

  it('includes code_challenge_method=S256', () => {
    const url = buildGoogleAuthUrl(baseParams)
    const params = new URL(url).searchParams
    expect(params.get('code_challenge_method')).toBe('S256')
  })

  it('includes state', () => {
    const url = buildGoogleAuthUrl(baseParams)
    const params = new URL(url).searchParams
    expect(params.get('state')).toBe('random-state-value')
  })

  it('includes scope with space-joined scopes', () => {
    const url = buildGoogleAuthUrl(baseParams)
    const params = new URL(url).searchParams
    expect(params.get('scope')).toBe(baseParams.scopes.join(' '))
  })

  it('includes redirect_uri', () => {
    const url = buildGoogleAuthUrl(baseParams)
    const params = new URL(url).searchParams
    expect(params.get('redirect_uri')).toBe('https://example.com/callback')
  })

  it('includes client_id', () => {
    const url = buildGoogleAuthUrl(baseParams)
    const params = new URL(url).searchParams
    expect(params.get('client_id')).toBe('test-client-id')
  })

  it('includes access_type=online', () => {
    const url = buildGoogleAuthUrl(baseParams)
    const params = new URL(url).searchParams
    expect(params.get('access_type')).toBe('online')
  })

  it('includes prompt=consent', () => {
    const url = buildGoogleAuthUrl(baseParams)
    const params = new URL(url).searchParams
    expect(params.get('prompt')).toBe('consent')
  })
})
