import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { UseClusteredPhotosResult } from '@/hooks/useClusteredPhotos'
import { clusteredResult } from '@/lib/test-helpers/cluster-render-blocks'

afterEach(cleanup)

// Mock dnd-kit so tests don't need a real DndContext, mirroring
// PhotoGrid.test.tsx's setup exactly.
vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useSortable: () => ({
    attributes: { 'aria-roledescription': 'sortable item' },
    listeners: { 'data-testid': 'drag-listener' },
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  }),
  rectSortingStrategy: vi.fn(),
}))

// See PhotoGrid.test.tsx for the full rationale behind mocking
// useClusteredPhotos entirely (U5) -- this file only needs the same mock
// shape to drive PhotoGrid's cluster-section rendering.
const mockUseClusteredPhotos =
  vi.fn<(photos: PhotoEntry[], similarityPercent: number) => UseClusteredPhotosResult>()
vi.mock('@/hooks/useClusteredPhotos', () => ({
  useClusteredPhotos: (photos: PhotoEntry[], similarityPercent: number) =>
    mockUseClusteredPhotos(photos, similarityPercent),
  clusterKey: (cluster: { members: string[] }) => [...cluster.members].sort().join(','),
  earliestCapturedAtMs: (cluster: { members: string[] }, photosById: Map<string, PhotoEntry>) => {
    let earliest = Infinity
    for (const id of cluster.members) {
      const capturedAt = photosById.get(id)?.capturedAt ?? null
      if (capturedAt === null) continue
      earliest = Math.min(earliest, capturedAt.getTime())
    }
    return earliest
  },
}))

import PhotoGrid from './PhotoGrid'

// --- test helpers -------------------------------------------------------

function makeEntry(name: string, index: number, capturedAt: string | null = `2025-0${index + 1}-01T10:00:00Z`): PhotoEntry {
  return {
    id: `${name}-${index}`,
    file: new File([], name, { type: 'image/jpeg' }),
    filename: name,
    capturedAt: capturedAt ? new Date(capturedAt) : null,
    uploadIndex: index,
    source: 'local',
  }
}

const getObjectUrl = (file: File) => `blob:${file.name}`

// U4: copy-mode prop threading (isCopySource/isCopyModeActive/onPaste reach
// each PhotoCard) and the "paste to entire cluster" button on a cluster's
// own container. KTD6 is the load-bearing constraint here: cluster
// membership for "paste to entire cluster" must come from `cluster.members`
// (the same list the cluster <section> already renders from), never
// re-derived from the flat `photos` array -- see
// docs/solutions/logic-errors/cluster-drag-timestamp-visual-order-divergence.md
// for the P0 bug this guards against. The fixtures below deliberately build
// a cluster whose members are NOT contiguous in the flat `photos` array (a
// non-member photo sits between them chronologically), exactly mirroring
// that precedent's scenario 1, so a re-derivation-from-`photos` bug would be
// caught by these tests.
describe('PhotoGrid — U4: copy-mode prop threading and paste-to-cluster', () => {
  // Non-contiguous cluster fixture (KTD6): A and C cluster together; B (not
  // a cluster member) sits chronologically between them. Flat `photos`
  // order is [A, B, C] -- so `cluster.members` ([A.id, C.id]) is NOT a
  // contiguous slice of `photos`. A "paste to entire cluster" implementation
  // that re-derived membership from `photos` (e.g. by index range, or by
  // filtering `photos` for ids adjacent to the source) would silently
  // include B or miss a member; sourcing strictly from `cluster.members`
  // does neither.
  const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
  const b = makeEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
  const c = makeEntry('c.jpg', 2, '2025-01-03T00:00:00Z')
  const photos = [a, b, c]

  beforeEach(() => {
    mockUseClusteredPhotos.mockReturnValue(
      clusteredResult(photos, [[a.id, c.id], [b.id]])
    )
  })

  it('renders "Paste to entire cluster" only on the source photo\'s own cluster container while copy mode is active', () => {
    // Second, unrelated cluster (d/e) so we can prove the button does NOT
    // appear on a cluster the source isn't a member of.
    const d = makeEntry('d.jpg', 3, '2025-02-01T00:00:00Z')
    const e = makeEntry('e.jpg', 4, '2025-02-02T00:00:00Z')
    const allPhotos = [a, b, c, d, e]
    mockUseClusteredPhotos.mockReturnValue(
      clusteredResult(allPhotos, [[a.id, c.id], [b.id], [d.id, e.id]])
    )

    render(
      <PhotoGrid
        photos={allPhotos}
        getObjectUrl={getObjectUrl}
        isCopyModeActive
        copySourceId={a.id}
        onPasteToCluster={vi.fn()}
      />
    )

    const sections = document.querySelectorAll('section')
    expect(sections).toHaveLength(2)

    const sourceSection = Array.from(sections).find((s) => s.textContent?.includes('2 related photos') && within(s as HTMLElement).queryByAltText('a.jpg')) as HTMLElement
    const otherSection = Array.from(sections).find((s) => s !== sourceSection) as HTMLElement

    expect(within(sourceSection).getByRole('button', { name: 'Paste to entire cluster' })).toBeDefined()
    expect(within(otherSection).queryByRole('button', { name: 'Paste to entire cluster' })).toBeNull()
  })

  it('clicking "Paste to entire cluster" calls onPasteToCluster with every member id except the source, in cluster.members order (non-contiguous cluster)', () => {
    const onPasteToCluster = vi.fn()
    render(
      <PhotoGrid
        photos={photos}
        getObjectUrl={getObjectUrl}
        isCopyModeActive
        copySourceId={a.id}
        onPasteToCluster={onPasteToCluster}
      />
    )

    // Sanity: the cluster really is non-contiguous in `photos` (b sits
    // between a and c) -- if this ever stopped being true the test would no
    // longer exercise KTD6.
    expect(photos.map((p) => p.id)).toEqual([a.id, b.id, c.id])

    const section = document.querySelector('section') as HTMLElement
    fireEvent.click(within(section).getByRole('button', { name: 'Paste to entire cluster' }))

    expect(onPasteToCluster).toHaveBeenCalledTimes(1)
    // Only c.id (the other cluster member) -- NOT b.id, which sits between
    // a and c in the flat `photos` array but is not a cluster member.
    expect(onPasteToCluster).toHaveBeenCalledWith([c.id])
  })

  it('includes a cluster member with a null capturedAt in the paste-to-cluster id list -- it is a target, not a value source', () => {
    const nullDated = makeEntry('null.jpg', 5, null)
    const allPhotos = [a, nullDated, c]
    mockUseClusteredPhotos.mockReturnValue(
      clusteredResult(allPhotos, [[a.id, c.id, nullDated.id]])
    )
    const onPasteToCluster = vi.fn()
    render(
      <PhotoGrid
        photos={allPhotos}
        getObjectUrl={getObjectUrl}
        isCopyModeActive
        copySourceId={a.id}
        onPasteToCluster={onPasteToCluster}
      />
    )

    const section = document.querySelector('section') as HTMLElement
    fireEvent.click(within(section).getByRole('button', { name: 'Paste to entire cluster' }))

    expect(onPasteToCluster).toHaveBeenCalledWith([c.id, nullDated.id])
  })

  it('never renders "Paste to entire cluster" on a singleton (one-member) block, regardless of copy-mode state', () => {
    render(
      <PhotoGrid
        photos={photos}
        getObjectUrl={getObjectUrl}
        isCopyModeActive
        copySourceId={a.id}
        onPasteToCluster={vi.fn()}
      />
    )

    // b is rendered as a singleton (not inside a <section>).
    const bImg = screen.getByAltText('b.jpg')
    expect(bImg.closest('section')).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Paste to entire cluster' })).toHaveLength(1)
  })

  it('renders no "Paste to entire cluster" button anywhere when copy mode is inactive', () => {
    render(
      <PhotoGrid
        photos={photos}
        getObjectUrl={getObjectUrl}
        isCopyModeActive={false}
        copySourceId={null}
        onPasteToCluster={vi.fn()}
      />
    )

    expect(screen.queryByRole('button', { name: 'Paste to entire cluster' })).toBeNull()
  })

  it('threads isCopySource/isCopyModeActive/onPaste correctly to each PhotoCard: the source card gets isCopySource, other cards get a working paste button, and clicking it calls onPaste with that card\'s id', () => {
    const onPaste = vi.fn()
    render(
      <PhotoGrid
        photos={photos}
        getObjectUrl={getObjectUrl}
        isCopyModeActive
        copySourceId={a.id}
        onPaste={onPaste}
      />
    )

    // The source card (a.jpg) still shows the zoom button, not paste --
    // PhotoCard.tsx's own `!isCopySource` guard (U3), exercised here via
    // real prop threading rather than PhotoCard's isolated unit tests.
    const sourceCard = screen.getByAltText('a.jpg').closest('.flex.flex-col.gap-1') as HTMLElement
    expect(within(sourceCard).getByRole('button', { name: 'Zoom photo' })).toBeDefined()
    expect(within(sourceCard).queryByRole('button', { name: 'Paste timestamp' })).toBeNull()

    // A non-source card (b.jpg, a singleton) shows a working paste button.
    const bCard = screen.getByAltText('b.jpg').closest('.flex.flex-col.gap-1') as HTMLElement
    fireEvent.click(within(bCard).getByRole('button', { name: 'Paste timestamp' }))
    expect(onPaste).toHaveBeenCalledWith(b.id)

    // A non-source cluster member (c.jpg) also shows a working paste button.
    const cCard = screen.getByAltText('c.jpg').closest('.flex.flex-col.gap-1') as HTMLElement
    fireEvent.click(within(cCard).getByRole('button', { name: 'Paste timestamp' }))
    expect(onPaste).toHaveBeenCalledWith(c.id)
  })

  it('threads isSoleSelected/onCopyTimestamp correctly: only the sole-selected card shows the copy-timestamp button, and clicking it calls onCopyTimestamp with that card\'s id', () => {
    const onCopyTimestamp = vi.fn()

    // Nobody selected: no card shows the copy-timestamp button.
    const { rerender } = render(
      <PhotoGrid photos={photos} getObjectUrl={getObjectUrl} onCopyTimestamp={onCopyTimestamp} />
    )
    expect(screen.queryByRole('button', { name: 'Copy timestamp' })).toBeNull()

    // Two selected: still hidden everywhere.
    rerender(
      <PhotoGrid
        photos={photos}
        getObjectUrl={getObjectUrl}
        selectedIds={new Set([a.id, b.id])}
        onCopyTimestamp={onCopyTimestamp}
      />
    )
    expect(screen.queryByRole('button', { name: 'Copy timestamp' })).toBeNull()

    // Exactly one selected: only that card's button renders.
    rerender(
      <PhotoGrid
        photos={photos}
        getObjectUrl={getObjectUrl}
        selectedIds={new Set([b.id])}
        onCopyTimestamp={onCopyTimestamp}
      />
    )
    const bCard = screen.getByAltText('b.jpg').closest('.flex.flex-col.gap-1') as HTMLElement
    expect(within(bCard).getByRole('button', { name: 'Copy timestamp' })).toBeDefined()

    const aCard = screen.getByAltText('a.jpg').closest('.flex.flex-col.gap-1') as HTMLElement
    expect(within(aCard).queryByRole('button', { name: 'Copy timestamp' })).toBeNull()

    fireEvent.click(within(bCard).getByRole('button', { name: 'Copy timestamp' }))
    expect(onCopyTimestamp).toHaveBeenCalledWith(b.id)
  })
})
