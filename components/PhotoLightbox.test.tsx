import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

afterEach(cleanup)

import PhotoLightbox from './PhotoLightbox'

describe('PhotoLightbox', () => {
  it('renders the given photo\'s image and filename-derived alt text, nothing else from the batch', () => {
    const { container } = render(
      <PhotoLightbox filename="beach.jpg" objectUrl="blob:beach" onClose={vi.fn()} />
    )

    const img = screen.getByAltText('beach.jpg')
    expect(img.getAttribute('src')).toBe('blob:beach')
    // Exactly one image in the whole render tree -- no other photo reference.
    expect(container.querySelectorAll('img').length).toBe(1)
  })

  it('moves focus to the close control on mount', () => {
    render(<PhotoLightbox filename="a.jpg" objectUrl="blob:a" onClose={vi.fn()} />)

    const closeButton = screen.getByRole('button', { name: 'Close' })
    expect(document.activeElement).toBe(closeButton)
  })

  it('traps Tab within the lightbox: Tab from the last focusable element cycles back to the first', () => {
    render(<PhotoLightbox filename="a.jpg" objectUrl="blob:a" onClose={vi.fn()} />)

    const closeButton = screen.getByRole('button', { name: 'Close' })
    // The close button is the only focusable element inside the lightbox, so
    // it is simultaneously first and last -- Tab from it must not escape to
    // the page behind it, it must land back on itself.
    expect(document.activeElement).toBe(closeButton)

    fireEvent.keyDown(closeButton, { key: 'Tab' })
    expect(document.activeElement).toBe(closeButton)

    fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(closeButton)
  })

  it('calls onClose when the close control is clicked', () => {
    const onClose = vi.fn()
    render(<PhotoLightbox filename="a.jpg" objectUrl="blob:a" onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the backdrop (outside the image) is clicked', () => {
    const onClose = vi.fn()
    const { container } = render(
      <PhotoLightbox filename="a.jpg" objectUrl="blob:a" onClose={onClose} />
    )

    // The root fixed-inset-0 div is the backdrop.
    fireEvent.click(container.firstElementChild as Element)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose when the image itself is clicked', () => {
    const onClose = vi.fn()
    render(<PhotoLightbox filename="a.jpg" objectUrl="blob:a" onClose={onClose} />)

    fireEvent.click(screen.getByAltText('a.jpg'))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('calls onClose on Escape keydown while rendered', () => {
    const onClose = vi.fn()
    render(<PhotoLightbox filename="a.jpg" objectUrl="blob:a" onClose={onClose} />)

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('returns focus to the element that had it before the lightbox opened, once onClose unmounts it', () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>trigger</button>
          {open && (
            <PhotoLightbox filename="a.jpg" objectUrl="blob:a" onClose={() => setOpen(false)} />
          )}
        </>
      )
    }

    render(<Host />)

    const triggerButton = screen.getByRole('button', { name: 'trigger' })
    triggerButton.focus()
    expect(document.activeElement).toBe(triggerButton)

    fireEvent.click(triggerButton)

    const closeButton = screen.getByRole('button', { name: 'Close' })
    expect(document.activeElement).toBe(closeButton)

    fireEvent.click(closeButton)

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    expect(document.activeElement).toBe(triggerButton)
  })

  it('renders a fallback state on image load error, with the close control still present and functional', () => {
    const onClose = vi.fn()
    render(<PhotoLightbox filename="a.jpg" objectUrl="blob:a" onClose={onClose} />)

    const img = screen.getByAltText('a.jpg')
    fireEvent.error(img)

    expect(screen.queryByAltText('a.jpg')).toBeNull()
    expect(screen.getByText(/unable to load/i)).toBeDefined()

    const closeButton = screen.getByRole('button', { name: 'Close' })
    fireEvent.click(closeButton)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('renders no next/prev navigation control', () => {
    render(<PhotoLightbox filename="a.jpg" objectUrl="blob:a" onClose={vi.fn()} />)

    expect(screen.queryByRole('button', { name: /next/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /prev/i })).toBeNull()
    // Only the close button should be a button in the whole component.
    expect(screen.getAllByRole('button').length).toBe(1)
  })
})
