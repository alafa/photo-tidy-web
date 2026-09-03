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

export function CopyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 4.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.5 7.5h-1a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v1" />
    </svg>
  )
}

export function PasteIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 12 12" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.25 2h3.5M3.5 2.5h5a.5.5 0 0 1 .5.5v7.5a.5.5 0 0 1-.5.5h-6a.5.5 0 0 1-.5-.5V3a.5.5 0 0 1 .5-.5Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M4.25 1.75h3.5a.5.5 0 0 1 .5.5v.5a.5.5 0 0 1-.5.5h-3.5a.5.5 0 0 1-.5-.5v-.5a.5.5 0 0 1 .5-.5Z" />
    </svg>
  )
}
