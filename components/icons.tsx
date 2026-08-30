/**
 * Shared icon components, matching the inline SVG convention used across
 * PhotoCard/PhotoLightbox: `viewBox="0 0 12 12"`, `stroke="currentColor"`,
 * `strokeWidth={2.5}`, `fill="none"` -- stroke-only glyphs sized by the
 * caller via `className` (e.g. `w-5 h-5`).
 */

export function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2 3.5h8M4.5 3.5V2.25a.75.75 0 0 1 .75-.75h1.5a.75.75 0 0 1 .75.75V3.5" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3.5l.5 6.75a1 1 0 0 0 1 .75h3a1 1 0 0 0 1-.75l.5-6.75" />
    </svg>
  )
}

export function ChevronLeftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 2.5L3 6l4.5 3.5" />
    </svg>
  )
}

export function ChevronRightIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 2.5L9 6l-4.5 3.5" />
    </svg>
  )
}

export function CloseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2 2l8 8M10 2L2 10" />
    </svg>
  )
}
