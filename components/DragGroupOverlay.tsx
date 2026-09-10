import type { PhotoEntry } from '@/hooks/usePhotos'

/**
 * U4 (KTD7): a multi-photo drag renders a stacked-thumbnail preview instead
 * of the bare single-card overlay (R9) -- capped at 3 rendered layers
 * regardless of group size (plan-review decision), with the count badge
 * always showing the TRUE total.
 *
 * `aria-hidden` + empty `alt`s throughout: this whole stack is a decorative,
 * purely-visual drag preview -- every underlying photo already has its own
 * accessible `<img alt="filename">` in the live grid, so giving these
 * previews the same alt text would put duplicate, ambiguous accessible
 * names in the tree for no benefit (and would make `getByAltText`-style
 * lookups of a grid card ambiguous while a group drag is in flight).
 */
export default function DragGroupOverlay({
  ids,
  photosById,
  getObjectUrl,
}: {
  ids: string[]
  photosById: Map<string, PhotoEntry>
  getObjectUrl: (file: File) => string
}) {
  return (
    <div
      className="relative w-28 aspect-square"
      data-testid="drag-group-overlay"
      aria-hidden="true"
    >
      {ids.slice(0, 3).map((id, indexFromFront) => {
        const stackEntry = photosById.get(id)
        if (!stackEntry) return null
        // Back-to-front depth: index 0 is frontmost, unoffset, matching the
        // bare single-card overlay's own position; the LAST rendered layer
        // (index 2, or fewer when the group has only 2 members) sits at the
        // back with the largest offset/lowest z-index.
        const depth = indexFromFront
        return (
          <div
            key={id}
            className="absolute inset-0 rounded-md overflow-hidden ring-2 ring-white dark:ring-zinc-900"
            style={{
              transform: `translate(${depth * 6}px, ${depth * 6}px)`,
              zIndex: 3 - depth,
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- blob: URLs are incompatible with next/image optimizer */}
            <img
              src={getObjectUrl(stackEntry.file)}
              alt=""
              className="w-full aspect-square object-cover bg-zinc-100"
            />
          </div>
        )
      })}
      {/* Count badge -- always the true group size (R9), even when the
          stack above is capped at 3 layers. */}
      <div className="absolute -top-2 -right-2 z-10 whitespace-nowrap bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-xs font-medium px-2 py-0.5 rounded-full leading-none">
        {ids.length} photos
      </div>
    </div>
  )
}
