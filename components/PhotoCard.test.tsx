import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

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

  describe('delete icon overlay (U2)', () => {
    it('renders the delete icon on every card, even without onSelect/debugMode/an onDelete handler', () => {
      const entry = makeEntry()
      render(<PhotoCard entry={entry} objectUrl="blob:test" />)

      expect(screen.getByRole('button', { name: 'Delete photo' })).toBeDefined()
    })

    it('clicking the delete icon calls onDelete exactly once', () => {
      const onDelete = vi.fn()
      const entry = makeEntry()
      render(<PhotoCard entry={entry} objectUrl="blob:test" onDelete={onDelete} />)

      fireEvent.click(screen.getByRole('button', { name: 'Delete photo' }))

      expect(onDelete).toHaveBeenCalledTimes(1)
      expect(onDelete).toHaveBeenCalledWith()
    })

    it('clicking the delete icon does not toggle the card\'s checked/selection state', () => {
      const onDelete = vi.fn()
      const onSelect = vi.fn()
      const entry = makeEntry()
      render(
        <PhotoCard
          entry={entry}
          objectUrl="blob:test"
          onDelete={onDelete}
          onSelect={onSelect}
          checked={false}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Delete photo' }))

      expect(onDelete).toHaveBeenCalledTimes(1)
      expect(onSelect).not.toHaveBeenCalled()
    })

    it('calls stopPropagation on both pointerdown and click (KTD3) so the icon never starts a drag or bubbles into the image wrapper\'s own click handler', () => {
      const onDelete = vi.fn()
      const entry = makeEntry()
      render(<PhotoCard entry={entry} objectUrl="blob:test" onDelete={onDelete} />)
      const button = screen.getByRole('button', { name: 'Delete photo' })

      // Dispatch real native events and spy directly on their
      // stopPropagation methods -- React's synthetic stopPropagation() also
      // stops the underlying native event, which is what actually prevents
      // dnd-kit's PointerSensor (a real onPointerDown listener on an
      // ancestor) from ever seeing the gesture.
      const pointerDownEvent = new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const pointerDownSpy = vi.spyOn(pointerDownEvent, 'stopPropagation')
      fireEvent(button, pointerDownEvent)
      expect(pointerDownSpy).toHaveBeenCalled()

      const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true })
      const clickSpy = vi.spyOn(clickEvent, 'stopPropagation')
      fireEvent(button, clickEvent)
      expect(clickSpy).toHaveBeenCalled()
    })

    it('renders a ~44x44px minimum tappable region via padding around a visually compact glyph', () => {
      const entry = makeEntry()
      render(<PhotoCard entry={entry} objectUrl="blob:test" onDelete={vi.fn()} />)

      const button = screen.getByRole('button', { name: 'Delete photo' })
      // p-3 (12px) padding on each side around a w-5 h-5 (20px) glyph is
      // exactly 44px total (12 + 20 + 12) -- the glyph itself stays visually
      // compact while the clickable box meets the ~44px minimum.
      expect(button.className).toContain('p-3')
      const svg = button.querySelector('svg')
      expect(svg?.getAttribute('class')).toContain('w-5')
      expect(svg?.getAttribute('class')).toContain('h-5')
    })
  })

  describe('zoom icon overlay (U4)', () => {
    it('renders the zoom icon on every card, even without onSelect/debugMode/an onZoom handler', () => {
      const entry = makeEntry()
      render(<PhotoCard entry={entry} objectUrl="blob:test" />)

      expect(screen.getByRole('button', { name: 'Zoom photo' })).toBeDefined()
    })

    it('clicking the zoom icon calls onZoom exactly once', () => {
      const onZoom = vi.fn()
      const entry = makeEntry()
      render(<PhotoCard entry={entry} objectUrl="blob:test" onZoom={onZoom} />)

      fireEvent.click(screen.getByRole('button', { name: 'Zoom photo' }))

      expect(onZoom).toHaveBeenCalledTimes(1)
      expect(onZoom).toHaveBeenCalledWith()
    })

    it('clicking the zoom icon does not toggle the card\'s checked/selection state', () => {
      const onZoom = vi.fn()
      const onSelect = vi.fn()
      const entry = makeEntry()
      render(
        <PhotoCard
          entry={entry}
          objectUrl="blob:test"
          onZoom={onZoom}
          onSelect={onSelect}
          checked={false}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Zoom photo' }))

      expect(onZoom).toHaveBeenCalledTimes(1)
      expect(onSelect).not.toHaveBeenCalled()
    })

    it('calls stopPropagation on both pointerdown and click (KTD3) so the icon never starts a drag or bubbles into the image wrapper\'s own click handler', () => {
      const onZoom = vi.fn()
      const entry = makeEntry()
      render(<PhotoCard entry={entry} objectUrl="blob:test" onZoom={onZoom} />)
      const button = screen.getByRole('button', { name: 'Zoom photo' })

      const pointerDownEvent = new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true })
      const pointerDownSpy = vi.spyOn(pointerDownEvent, 'stopPropagation')
      fireEvent(button, pointerDownEvent)
      expect(pointerDownSpy).toHaveBeenCalled()

      const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true })
      const clickSpy = vi.spyOn(clickEvent, 'stopPropagation')
      fireEvent(button, clickEvent)
      expect(clickSpy).toHaveBeenCalled()
    })

    it('renders a ~44x44px minimum tappable region via padding around a visually compact glyph', () => {
      const entry = makeEntry()
      render(<PhotoCard entry={entry} objectUrl="blob:test" onZoom={vi.fn()} />)

      const button = screen.getByRole('button', { name: 'Zoom photo' })
      expect(button.className).toContain('p-3')
      const svg = button.querySelector('svg')
      expect(svg?.getAttribute('class')).toContain('w-5')
      expect(svg?.getAttribute('class')).toContain('h-5')
    })
  })

  describe('delete and zoom icons coexist independently (U4)', () => {
    it('both icons render simultaneously on the same card, and clicking one never triggers the other', () => {
      const onDelete = vi.fn()
      const onZoom = vi.fn()
      const entry = makeEntry()
      render(<PhotoCard entry={entry} objectUrl="blob:test" onDelete={onDelete} onZoom={onZoom} />)

      const deleteButton = screen.getByRole('button', { name: 'Delete photo' })
      const zoomButton = screen.getByRole('button', { name: 'Zoom photo' })
      expect(deleteButton).toBeDefined()
      expect(zoomButton).toBeDefined()

      fireEvent.click(zoomButton)
      expect(onZoom).toHaveBeenCalledTimes(1)
      expect(onDelete).not.toHaveBeenCalled()

      fireEvent.click(deleteButton)
      expect(onDelete).toHaveBeenCalledTimes(1)
      expect(onZoom).toHaveBeenCalledTimes(1)
    })
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
