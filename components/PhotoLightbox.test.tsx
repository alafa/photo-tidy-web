import { useState } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

afterEach(cleanup)

import PhotoLightbox from './PhotoLightbox'

const CAPTURED_AT = new Date('2025-01-03T14:32:00Z')

function renderLightbox(overrides: Partial<React.ComponentProps<typeof PhotoLightbox>> = {}) {
  const onClose = vi.fn()
  const onDelete = vi.fn()
  const onTimestampChange = vi.fn()
  const props = {
    filename: 'a.jpg',
    objectUrl: 'blob:a',
    capturedAt: CAPTURED_AT,
    onClose,
    onDelete,
    onTimestampChange,
    ...overrides,
  }
  const utils = render(<PhotoLightbox {...props} />)
  return { ...utils, onClose, onDelete, onTimestampChange }
}

function enterEditMode() {
  // The timestamp label is clicked to enter edit mode -- it displays the
  // formatted date when not editing.
  fireEvent.click(screen.getByText(/Jan 3, 2025/))
  return document.querySelector('input[type="datetime-local"]') as HTMLInputElement
}

describe('PhotoLightbox — keyboard guard (KTD4) and commit-before-action (KTD5)', () => {
  describe('while NOT editing', () => {
    it('Escape calls onClose', () => {
      const { onClose } = renderLightbox()
      fireEvent.keyDown(document, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('ArrowLeft calls onNavigatePrev when defined', () => {
      const onNavigatePrev = vi.fn()
      renderLightbox({ onNavigatePrev })
      fireEvent.keyDown(document, { key: 'ArrowLeft' })
      expect(onNavigatePrev).toHaveBeenCalledTimes(1)
    })

    it('ArrowRight calls onNavigateNext when defined', () => {
      const onNavigateNext = vi.fn()
      renderLightbox({ onNavigateNext })
      fireEvent.keyDown(document, { key: 'ArrowRight' })
      expect(onNavigateNext).toHaveBeenCalledTimes(1)
    })

    it('ArrowLeft/ArrowRight do nothing when the corresponding prop is undefined', () => {
      // No onNavigatePrev/onNavigateNext passed -- must not throw, must not
      // call onClose or onDelete either.
      const { onClose, onDelete } = renderLightbox()
      fireEvent.keyDown(document, { key: 'ArrowLeft' })
      fireEvent.keyDown(document, { key: 'ArrowRight' })
      expect(onClose).not.toHaveBeenCalled()
      expect(onDelete).not.toHaveBeenCalled()
    })
  })

  describe('while editing', () => {
    it('Escape calls cancel() instead of onClose (no onClose, no onTimestampChange)', () => {
      const { onClose, onTimestampChange } = renderLightbox()
      const input = enterEditMode()
      expect(input).toBeTruthy()

      fireEvent.keyDown(document, { key: 'Escape' })

      expect(onClose).not.toHaveBeenCalled()
      expect(onTimestampChange).not.toHaveBeenCalled()
      // Exits edit mode: the formatted label is back, input is gone.
      expect(screen.getByText(/Jan 3, 2025/)).toBeDefined()
      expect(document.querySelector('input[type="datetime-local"]')).toBeNull()
    })

    it('ArrowLeft does NOT call onNavigatePrev while editing', () => {
      const onNavigatePrev = vi.fn()
      renderLightbox({ onNavigatePrev })
      enterEditMode()

      fireEvent.keyDown(document, { key: 'ArrowLeft' })

      expect(onNavigatePrev).not.toHaveBeenCalled()
    })

    it('ArrowRight does NOT call onNavigateNext while editing', () => {
      const onNavigateNext = vi.fn()
      renderLightbox({ onNavigateNext })
      enterEditMode()

      fireEvent.keyDown(document, { key: 'ArrowRight' })

      expect(onNavigateNext).not.toHaveBeenCalled()
    })

    it('ArrowLeft/ArrowRight keydown at the document listener does not call preventDefault (native input must still handle it)', () => {
      renderLightbox()
      enterEditMode()

      const leftEvent = new window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true })
      document.dispatchEvent(leftEvent)
      expect(leftEvent.defaultPrevented).toBe(false)

      const rightEvent = new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      document.dispatchEvent(rightEvent)
      expect(rightEvent.defaultPrevented).toBe(false)
    })
  })

  describe('commit-before-action across all four action paths', () => {
    it('delete button click commits the in-progress edit before onDelete fires', () => {
      const { onDelete, onTimestampChange } = renderLightbox()
      enterEditMode()

      fireEvent.click(screen.getByRole('button', { name: 'Delete photo' }))

      expect(onTimestampChange).toHaveBeenCalledTimes(1)
      expect(onDelete).toHaveBeenCalledTimes(1)
    })

    it('nav button click commits the in-progress edit before onNavigatePrev/onNavigateNext fires', () => {
      const onNavigatePrev = vi.fn()
      const onNavigateNext = vi.fn()
      const { onTimestampChange } = renderLightbox({ onNavigatePrev, onNavigateNext })
      enterEditMode()

      fireEvent.click(screen.getByRole('button', { name: 'Next photo' }))

      expect(onTimestampChange).toHaveBeenCalledTimes(1)
      expect(onNavigateNext).toHaveBeenCalledTimes(1)
      expect(onNavigatePrev).not.toHaveBeenCalled()
    })

    it('close button click commits the in-progress edit before onClose fires', () => {
      const { onClose, onTimestampChange } = renderLightbox()
      enterEditMode()

      fireEvent.click(screen.getByRole('button', { name: 'Close' }))

      expect(onTimestampChange).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('backdrop click commits the in-progress edit before onClose fires', () => {
      const { onClose, onTimestampChange, container } = renderLightbox()
      enterEditMode()

      fireEvent.click(container.firstElementChild as Element)

      expect(onTimestampChange).toHaveBeenCalledTimes(1)
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})

describe('PhotoLightbox — keydown listener identity stability (perf regression)', () => {
  it('typing into the timestamp input does not re-register the document keydown listener', () => {
    // Regression guard for the fix to useTimestampEdit's `cancel`/`startEdit`
    // not being memoized: PhotoLightbox's document keydown effect depends on
    // `cancelTimestamp`, so before the fix, typing a character (which
    // re-renders PhotoLightbox via the input's onChange) produced a fresh
    // `cancel` reference every keystroke, tearing down and re-adding the
    // document listener each time. Spying on add/removeEventListener proves
    // that no longer happens.
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')

    renderLightbox()
    const input = enterEditMode()

    // Entering edit mode legitimately flips `isEditing` (a real dependency
    // of the effect), so it's expected to re-run the effect once here --
    // clear the spies before the part under test.
    addSpy.mockClear()
    removeSpy.mockClear()

    fireEvent.change(input, { target: { value: '2025-06-15T10:00' } })
    fireEvent.change(input, { target: { value: '2025-06-15T10:01' } })
    fireEvent.change(input, { target: { value: '2025-06-15T10:02' } })

    const keydownAddCalls = addSpy.mock.calls.filter(([type]) => type === 'keydown')
    const keydownRemoveCalls = removeSpy.mock.calls.filter(([type]) => type === 'keydown')

    expect(keydownAddCalls).toHaveLength(0)
    expect(keydownRemoveCalls).toHaveLength(0)

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })
})

describe('PhotoLightbox — delete', () => {
  it('renders the delete button with the shared trash icon and correct aria-label', () => {
    renderLightbox()
    const button = screen.getByRole('button', { name: 'Delete photo' })
    expect(button.querySelectorAll('svg path').length).toBe(2)
  })

  it('clicking delete calls onDelete', () => {
    const { onDelete } = renderLightbox()
    fireEvent.click(screen.getByRole('button', { name: 'Delete photo' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})

describe('PhotoLightbox — navigation controls', () => {
  it('renders neither nav button when both onNavigatePrev/onNavigateNext are undefined', () => {
    renderLightbox()
    expect(screen.queryByRole('button', { name: 'Previous photo' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Next photo' })).toBeNull()
  })

  it('renders only the prev button when only onNavigatePrev is defined', () => {
    renderLightbox({ onNavigatePrev: vi.fn() })
    expect(screen.getByRole('button', { name: 'Previous photo' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Next photo' })).toBeNull()
  })

  it('renders only the next button when only onNavigateNext is defined', () => {
    renderLightbox({ onNavigateNext: vi.fn() })
    expect(screen.queryByRole('button', { name: 'Previous photo' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Next photo' })).toBeDefined()
  })

  it('renders both nav buttons when both props are defined', () => {
    renderLightbox({ onNavigatePrev: vi.fn(), onNavigateNext: vi.fn() })
    expect(screen.getByRole('button', { name: 'Previous photo' })).toBeDefined()
    expect(screen.getByRole('button', { name: 'Next photo' })).toBeDefined()
  })

  it('clicking prev calls onNavigatePrev', () => {
    const onNavigatePrev = vi.fn()
    renderLightbox({ onNavigatePrev })
    fireEvent.click(screen.getByRole('button', { name: 'Previous photo' }))
    expect(onNavigatePrev).toHaveBeenCalledTimes(1)
  })

  it('clicking next calls onNavigateNext', () => {
    const onNavigateNext = vi.fn()
    renderLightbox({ onNavigateNext })
    fireEvent.click(screen.getByRole('button', { name: 'Next photo' }))
    expect(onNavigateNext).toHaveBeenCalledTimes(1)
  })
})

describe('PhotoLightbox — inline timestamp editing', () => {
  it('clicking the timestamp enters edit mode, showing a datetime-local input', () => {
    renderLightbox()
    fireEvent.click(screen.getByText(/Jan 3, 2025/))
    const input = document.querySelector('input[type="datetime-local"]')
    expect(input).not.toBeNull()
  })

  it('Enter commits via onTimestampChange with the parsed date and exits edit mode', () => {
    const { onTimestampChange } = renderLightbox()
    fireEvent.click(screen.getByText(/Jan 3, 2025/))
    const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement

    fireEvent.change(input, { target: { value: '2025-06-15T10:00' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onTimestampChange).toHaveBeenCalledTimes(1)
    const [calledWith] = onTimestampChange.mock.calls[0]
    expect(calledWith.toISOString()).toBe(new Date('2025-06-15T10:00:00Z').toISOString())
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull()
  })

  it('Escape while editing cancels: calls neither onTimestampChange nor onClose, exits edit mode', () => {
    const { onTimestampChange, onClose } = renderLightbox()
    fireEvent.click(screen.getByText(/Jan 3, 2025/))
    const input = document.querySelector('input[type="datetime-local"]') as HTMLInputElement

    fireEvent.change(input, { target: { value: '2025-06-15T10:00' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onTimestampChange).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('input[type="datetime-local"]')).toBeNull()
    expect(screen.getByText(/Jan 3, 2025/)).toBeDefined()
  })
})

describe('PhotoLightbox — focus restore guard (KTD7)', () => {
  it('calls .focus() on the pre-open element on unmount when it is still connected', () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>trigger</button>
          {open && (
            <PhotoLightbox
              filename="a.jpg"
              objectUrl="blob:a"
              capturedAt={null}
              onClose={() => setOpen(false)}
              onDelete={vi.fn()}
              onTimestampChange={vi.fn()}
            />
          )}
        </>
      )
    }

    render(<Host />)
    const triggerButton = screen.getByRole('button', { name: 'trigger' })
    triggerButton.focus()
    fireEvent.click(triggerButton)

    const closeButton = screen.getByRole('button', { name: 'Close' })
    fireEvent.click(closeButton)

    expect(document.activeElement).toBe(triggerButton)
  })

  it('does not throw when the pre-open element has been removed from the DOM', () => {
    function Host() {
      const [open, setOpen] = useState(false)
      const [showTrigger, setShowTrigger] = useState(true)
      return (
        <>
          {showTrigger && <button onClick={() => setOpen(true)}>trigger</button>}
          {open && (
            <PhotoLightbox
              filename="a.jpg"
              objectUrl="blob:a"
              capturedAt={null}
              onClose={() => {
                setOpen(false)
              }}
              onDelete={vi.fn()}
              onTimestampChange={vi.fn()}
            />
          )}
          <button onClick={() => setShowTrigger(false)}>remove-trigger</button>
        </>
      )
    }

    render(<Host />)
    const triggerButton = screen.getByRole('button', { name: 'trigger' })
    triggerButton.focus()
    fireEvent.click(triggerButton)

    // Remove the originally-focused element from the DOM while the
    // lightbox is open (simulating navigating/deleting through photos).
    fireEvent.click(screen.getByRole('button', { name: 'remove-trigger' }))
    expect(screen.queryByRole('button', { name: 'trigger' })).toBeNull()

    const closeButton = screen.getByRole('button', { name: 'Close' })
    expect(() => fireEvent.click(closeButton)).not.toThrow()
  })
})

describe('PhotoLightbox — pre-existing behavior (unchanged)', () => {
  it('renders the given photo\'s image and filename-derived alt text', () => {
    const { container } = renderLightbox({ filename: 'beach.jpg', objectUrl: 'blob:beach' })

    const img = screen.getByAltText('beach.jpg')
    expect(img.getAttribute('src')).toBe('blob:beach')
    expect(container.querySelectorAll('img').length).toBe(1)
  })

  it('moves focus to the close control on mount', () => {
    renderLightbox()
    const closeButton = screen.getByRole('button', { name: 'Close' })
    expect(document.activeElement).toBe(closeButton)
  })

  it('calls onClose when the close control is clicked (not editing)', () => {
    const { onClose } = renderLightbox()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose when the backdrop (outside the image) is clicked (not editing)', () => {
    const { onClose, container } = renderLightbox()
    fireEvent.click(container.firstElementChild as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not call onClose when the image itself is clicked', () => {
    const { onClose } = renderLightbox()
    fireEvent.click(screen.getByAltText('a.jpg'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('returns focus to the element that had it before the lightbox opened, once onClose unmounts it', () => {
    function Host() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>trigger</button>
          {open && (
            <PhotoLightbox
              filename="a.jpg"
              objectUrl="blob:a"
              capturedAt={null}
              onClose={() => setOpen(false)}
              onDelete={vi.fn()}
              onTimestampChange={vi.fn()}
            />
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
    const { onClose } = renderLightbox()

    const img = screen.getByAltText('a.jpg')
    fireEvent.error(img)

    expect(screen.queryByAltText('a.jpg')).toBeNull()
    expect(screen.getByText(/unable to load/i)).toBeDefined()

    const closeButton = screen.getByRole('button', { name: 'Close' })
    fireEvent.click(closeButton)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
