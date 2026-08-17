import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

afterEach(cleanup)
import PhotoCard from './PhotoCard'
import type { PhotoEntry } from '@/hooks/usePhotos'

function makeEntry(overrides: Partial<PhotoEntry> = {}): PhotoEntry {
  const file = new File([], 'test.jpg', { type: 'image/jpeg' })
  return {
    file,
    filename: 'test.jpg',
    capturedAt: null,
    uploadIndex: 0,
    source: 'local',
    ...overrides,
  }
}

describe('PhotoCard', () => {
  it('renders filename and formatted date for a photo with capturedAt', () => {
    // 2025-01-03T14:32:00Z — stored as UTC by exifr
    const capturedAt = new Date('2025-01-03T14:32:00Z')
    const entry = makeEntry({ filename: 'beach.jpg', capturedAt })

    render(<PhotoCard entry={entry} objectUrl="blob:beach" />)

    expect(screen.getByText('beach.jpg')).toBeDefined()
    // Should show the UTC clock time: Jan 3, 2025 at 14:32
    const dateText = screen.getByText(/Jan 3, 2025/)
    expect(dateText.textContent).toMatch(/14:32/)
  })

  it('renders "No date" when capturedAt is null', () => {
    const entry = makeEntry({ filename: 'unknown.jpg', capturedAt: null })

    render(<PhotoCard entry={entry} objectUrl="blob:unknown" />)

    expect(screen.getByText('No date')).toBeDefined()
  })

  it('formats date as "Jan 3, 2025" with abbreviated month, no seconds, no timezone suffix', () => {
    const capturedAt = new Date('2025-01-03T14:32:00Z')
    const entry = makeEntry({ capturedAt })

    render(<PhotoCard entry={entry} objectUrl="blob:x" />)

    const dateEl = screen.getByText(/Jan 3, 2025/)
    // Should not include seconds (:00) or timezone (UTC, +00, etc.)
    expect(dateEl.textContent).not.toMatch(/:\d\d\s*(UTC|Z|\+)/)
  })

  it('renders an img element with the provided objectUrl', () => {
    const entry = makeEntry({ filename: 'photo.jpg' })

    const { container } = render(<PhotoCard entry={entry} objectUrl="blob:photo" />)

    const img = container.querySelector('img')
    expect(img?.getAttribute('src')).toBe('blob:photo')
    expect(img?.getAttribute('loading')).toBe('lazy')
  })

  it('renders origin badge when entry.source is google-photos', () => {
    const entry = makeEntry({ source: 'google-photos' })

    const { container } = render(<PhotoCard entry={entry} objectUrl="blob:test" />)

    const badge = container.querySelector('.bg-blue-600')
    expect(badge).not.toBeNull()
    expect(badge?.textContent).toBe('G')
  })

  it('renders no origin badge when entry.source is local', () => {
    const entry = makeEntry({ source: 'local' })

    const { container } = render(<PhotoCard entry={entry} objectUrl="blob:test" />)

    const badge = container.querySelector('.bg-blue-600')
    expect(badge).toBeNull()
  })
})

// A `describe('PhotoGrid', ...)` block used to live here, exercising
// PhotoGrid directly against its pre-refactor Props (`{photos, getObjectUrl}`
// only, no `metrics`). PhotoGrid's contract changed when clustering/debug
// mode/the similarity slider were absorbed into it (see
// hooks/useClusteredPhotos.ts, components/PhotoGrid.tsx) — `metrics` is now
// required, and the component always renders slider chrome even for an empty
// photos array, so that block's "empty grid has zero children" assertion no
// longer held. Removed as dead/superseded rather than patched: PhotoGrid's
// own rendering behavior (card count, empty state via its slider-only
// output, etc.) is now covered directly in components/PhotoGrid.test.tsx.
