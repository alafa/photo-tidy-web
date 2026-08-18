import { useEffect, useRef, useState } from 'react'

type Props = {
  /** Used only for the image's alt text -- this component knows nothing else
   * about the photo (no id, no metadata) and nothing about the rest of the
   * batch, per R3's view-only scope. */
  filename: string
  objectUrl: string
  onClose: () => void
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Standalone, view-only full-size photo viewer. No portal, no external
 * dialog library -- there is no existing modal precedent in this codebase
 * (confirmed via repo research), so focus management is implemented here
 * from first principles:
 *   - on mount, focus moves to the close control
 *   - Tab/Shift+Tab is trapped within the lightbox's own focusable elements
 *   - on unmount (any close path), focus returns to whatever had it before
 *     the lightbox opened
 *
 * Deliberately has no id/next/prev props -- it must not know anything about
 * the rest of the photo batch.
 */
export default function PhotoLightbox({ filename, objectUrl, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  const [imageFailed, setImageFailed] = useState(false)

  // Capture the pre-open focus target before moving focus to the close
  // control, then restore it on unmount. Every close path (close-control
  // click, backdrop click, Escape) works by having the parent stop rendering
  // this component, so a single mount-effect cleanup covers all of them.
  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()

    return () => {
      previouslyFocusedRef.current?.focus()
    }
  }, [])

  // Escape-to-close and the Tab focus trap both need a document-level
  // keydown listener, since focus may be anywhere within the lightbox (or,
  // in principle, nowhere) when either key is pressed.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }

      if (e.key !== 'Tab') return

      const root = rootRef.current
      if (!root) return

      const focusable = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement

      if (e.shiftKey) {
        if (active === first || !(active instanceof Node) || !root.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else {
        if (active === last || !(active instanceof Node) || !root.contains(active)) {
          e.preventDefault()
          first.focus()
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      ref={rootRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
    >
      <button
        ref={closeButtonRef}
        type="button"
        aria-label="Close"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        className="absolute top-3 right-3 p-3 flex items-center justify-center rounded-full text-zinc-100 hover:text-white hover:bg-white/10"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M2 2l8 8M10 2L2 10" />
        </svg>
      </button>

      {imageFailed ? (
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex flex-col items-center gap-2 text-zinc-100 text-sm"
        >
          <p>Unable to load this image.</p>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- blob: URLs are incompatible with next/image optimizer
        <img
          src={objectUrl}
          alt={filename}
          onClick={(e) => e.stopPropagation()}
          onError={() => setImageFailed(true)}
          className="max-w-full max-h-full object-contain rounded-md"
        />
      )}
    </div>
  )
}
