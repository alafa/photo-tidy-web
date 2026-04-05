import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

afterEach(cleanup)
import PhotoCard from './PhotoCard'
import PhotoGrid from './PhotoGrid'
import type { PhotoEntry } from '@/hooks/usePhotos'

function makeEntry(overrides: Partial<PhotoEntry> = {}): PhotoEntry {
  const file = new File([], 'test.jpg', { type: 'image/jpeg' })
  return {
    file,
    filename: 'test.jpg',
    capturedAt: null,
    uploadIndex: 0,
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
})

describe('PhotoGrid', () => {
  it('renders the correct number of PhotoCard elements', () => {
    const photos = [
      makeEntry({ filename: 'a.jpg', uploadIndex: 0 }),
      makeEntry({ filename: 'b.jpg', uploadIndex: 1 }),
      makeEntry({ filename: 'c.jpg', uploadIndex: 2 }),
    ]
    const getObjectUrl = vi.fn((file: File) => `blob:${file.name}`)

    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

    expect(screen.getByText('a.jpg')).toBeDefined()
    expect(screen.getByText('b.jpg')).toBeDefined()
    expect(screen.getByText('c.jpg')).toBeDefined()
  })

  it('renders empty grid without errors when photos array is empty', () => {
    const { container } = render(
      <PhotoGrid photos={[]} getObjectUrl={vi.fn()} />
    )
    const grid = container.firstChild as HTMLElement
    expect(grid.children.length).toBe(0)
  })
})
