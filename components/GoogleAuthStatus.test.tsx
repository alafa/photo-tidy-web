import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'

afterEach(cleanup)

import GoogleAuthStatus from './GoogleAuthStatus'

describe('GoogleAuthStatus', () => {
  it('renders "Connect Google Photos" button when signed out', () => {
    const signIn = vi.fn()
    const signOut = vi.fn()

    render(
      <GoogleAuthStatus
        isSignedIn={false}
        accountEmail={null}
        isExpiringSoon={false}
        signIn={signIn}
        signOut={signOut}
      />
    )

    expect(screen.getByText('Connect Google Photos')).toBeDefined()
  })

  it('calls signIn when "Connect Google Photos" button is clicked', () => {
    const signIn = vi.fn()
    const signOut = vi.fn()

    render(
      <GoogleAuthStatus
        isSignedIn={false}
        accountEmail={null}
        isExpiringSoon={false}
        signIn={signIn}
        signOut={signOut}
      />
    )

    fireEvent.click(screen.getByText('Connect Google Photos'))
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it('renders account email and Disconnect link when signed in and not expiring', () => {
    const signIn = vi.fn()
    const signOut = vi.fn()

    render(
      <GoogleAuthStatus
        isSignedIn={true}
        accountEmail="user@example.com"
        isExpiringSoon={false}
        signIn={signIn}
        signOut={signOut}
      />
    )

    expect(screen.getByText('user@example.com')).toBeDefined()
    expect(screen.getByText('Disconnect')).toBeDefined()
  })

  it('does not render warning banner when signed in and not expiring', () => {
    const signIn = vi.fn()
    const signOut = vi.fn()

    render(
      <GoogleAuthStatus
        isSignedIn={true}
        accountEmail="user@example.com"
        isExpiringSoon={false}
        signIn={signIn}
        signOut={signOut}
      />
    )

    expect(screen.queryByText(/expires soon/)).toBeNull()
    expect(screen.queryByText(/click to refresh/)).toBeNull()
  })

  it('renders warning banner and "click to refresh" link when signed in and expiring soon', () => {
    const signIn = vi.fn()
    const signOut = vi.fn()

    render(
      <GoogleAuthStatus
        isSignedIn={true}
        accountEmail="user@example.com"
        isExpiringSoon={true}
        signIn={signIn}
        signOut={signOut}
      />
    )

    expect(screen.getByText(/expires soon/)).toBeDefined()
    expect(screen.getByText('click to refresh')).toBeDefined()
  })

  it('calls signIn when "click to refresh" link is clicked', () => {
    const signIn = vi.fn()
    const signOut = vi.fn()

    render(
      <GoogleAuthStatus
        isSignedIn={true}
        accountEmail="user@example.com"
        isExpiringSoon={true}
        signIn={signIn}
        signOut={signOut}
      />
    )

    fireEvent.click(screen.getByText('click to refresh'))
    expect(signIn).toHaveBeenCalledTimes(1)
  })

  it('renders "Google account connected" fallback when signed in and accountEmail is null', () => {
    const signIn = vi.fn()
    const signOut = vi.fn()

    render(
      <GoogleAuthStatus
        isSignedIn={true}
        accountEmail={null}
        isExpiringSoon={false}
        signIn={signIn}
        signOut={signOut}
      />
    )

    expect(screen.getByText('Google account connected')).toBeDefined()
  })

  it('calls signOut when "Disconnect" link is clicked', () => {
    const signIn = vi.fn()
    const signOut = vi.fn()

    render(
      <GoogleAuthStatus
        isSignedIn={true}
        accountEmail="user@example.com"
        isExpiringSoon={false}
        signIn={signIn}
        signOut={signOut}
      />
    )

    fireEvent.click(screen.getByText('Disconnect'))
    expect(signOut).toHaveBeenCalledTimes(1)
  })
})
