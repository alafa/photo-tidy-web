import { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { PhotoMetrics } from '@/lib/perceptual-hash'
import { range, makeHashFromPositions } from '@/lib/test-helpers/hash-fixtures'
import BatchEditPanel from './BatchEditPanel'

afterEach(cleanup)

// Mock dnd-kit so tests don't need a real DndContext. `items` passed to
// SortableContext is captured so U3's tests can prove it's the full flat
// chronological id list (KTD2) without simulating a real pointer drag --
// this repo has no precedent for that, and `useSortable`'s static
// `data-testid="drag-listener"` attribute (below) is instead used to prove
// the debug Compare button (KTD9) sits outside the drag-listener wrapper.
let capturedSortableItems: string[] | null = null

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children, items }: { children: React.ReactNode; items: string[] }) => {
    capturedSortableItems = items
    return <>{children}</>
  },
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

beforeEach(() => {
  capturedSortableItems = null
})

import PhotoGrid from './PhotoGrid'

// --- test helpers -------------------------------------------------------
//
// Hashes are built from explicit "on" bit positions (not raw hex literals)
// so cosine distances between fixtures are exactly predictable by hand —
// same technique as hooks/useClusteredPhotos.test.ts and the old
// components/ClusterView.test.tsx.

const HASH_TOTAL_BITS = 128

const hashFromPositions = makeHashFromPositions(HASH_TOTAL_BITS)

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

function makeMetrics(hash: string | null, width = 100, height = 100, size = 1000): PhotoMetrics {
  return { width, height, size, hash }
}

const getObjectUrl = (file: File) => `blob:${file.name}`
const emptyMetrics = new Map<string, PhotoMetrics | undefined>()

// Mirrors PhotoUploadPage's own selectedIds + toggleSelect (U4): a single
// page-level Set, passed to PhotoGrid and reflected in BatchEditPanel's
// count, exactly as the real app wires them. Used to prove selection is
// unified end to end rather than merely forwarded prop-for-prop within
// PhotoGrid in isolation.
function SelectionHarness({
  photos,
  metrics,
}: {
  photos: PhotoEntry[]
  metrics: Map<string, PhotoMetrics | undefined>
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  function toggleSelect(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  // Same dedup-by-ms-value, sort-ascending rule PhotoUploadPage itself uses
  // (R8/KTD7) to derive BatchEditPanel's distinctTimestamps prop.
  const seenTimestamps = new Map<number, Date>()
  for (const photo of photos) {
    if (!selectedIds.has(photo.id)) continue
    const capturedAt = photo.capturedAt
    if (capturedAt === null) continue
    if (!seenTimestamps.has(capturedAt.getTime())) seenTimestamps.set(capturedAt.getTime(), capturedAt)
  }
  const distinctTimestamps = [...seenTimestamps.values()].sort((a, b) => a.getTime() - b.getTime())

  return (
    <>
      <PhotoGrid
        photos={photos}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        selectedIds={selectedIds}
        onSelect={toggleSelect}
      />
      {selectedIds.size > 0 && (
        <BatchEditPanel
          selectedCount={selectedIds.size}
          distinctTimestamps={distinctTimestamps}
          onBatchRename={vi.fn()}
          onBatchSetTimestamp={vi.fn()}
          onBatchDelete={vi.fn()}
          onClearSelection={() => setSelectedIds(new Set())}
        />
      )}
    </>
  )
}

describe('PhotoGrid', () => {
  it('renders all photo filenames', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    render(<PhotoGrid photos={photos} metrics={emptyMetrics} getObjectUrl={getObjectUrl} />)
    expect(screen.getByText('a.jpg')).toBeDefined()
    expect(screen.getByText('b.jpg')).toBeDefined()
  })

  it('renders SortablePhotoCard (with drag attributes) when onReorder is provided', () => {
    const photos = [makeEntry('a.jpg', 0)]
    render(
      <PhotoGrid
        photos={photos}
        metrics={emptyMetrics}
        getObjectUrl={getObjectUrl}
        onReorder={vi.fn()}
      />
    )
    // useSortable adds aria-roledescription="sortable item" via attributes spread
    expect(document.querySelector('[aria-roledescription="sortable item"]')).not.toBeNull()
  })

  it('does NOT add drag attributes when onReorder is absent', () => {
    const photos = [makeEntry('a.jpg', 0)]
    render(<PhotoGrid photos={photos} metrics={emptyMetrics} getObjectUrl={getObjectUrl} />)
    expect(document.querySelector('[aria-roledescription="sortable item"]')).toBeNull()
  })

  it('renders the correct number of cards', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1), makeEntry('c.jpg', 2)]
    render(<PhotoGrid photos={photos} metrics={emptyMetrics} getObjectUrl={getObjectUrl} />)
    expect(screen.getAllByRole('img')).toHaveLength(3)
  })

  it('forwards selection props to cards (checked/onSelect reach the underlying card)', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    const onSelect = vi.fn()
    render(
      <PhotoGrid
        photos={photos}
        metrics={emptyMetrics}
        getObjectUrl={getObjectUrl}
        selectedIds={new Set(['a.jpg-0'])}
        onSelect={onSelect}
      />
    )
    fireEvent.click(screen.getByAltText('b.jpg'))
    expect(onSelect).toHaveBeenCalledWith('b.jpg-1', true)
  })

  it('AE1: at the 0% default with no exact duplicates, the grid renders like a flat timeline — no bordered cluster sections', () => {
    const photos = [
      makeEntry('a.jpg', 0),
      makeEntry('b.jpg', 1),
      makeEntry('c.jpg', 2),
    ]
    const metrics = new Map<string, PhotoMetrics | undefined>([
      ['a.jpg-0', makeMetrics(hashFromPositions(range(0, 9)))],
      ['b.jpg-1', makeMetrics(hashFromPositions(range(30, 39)))],
      ['c.jpg-2', makeMetrics(hashFromPositions(range(60, 69)))],
    ])

    render(<PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} />)

    expect(screen.getByText('a.jpg')).toBeDefined()
    expect(screen.getByText('b.jpg')).toBeDefined()
    expect(screen.getByText('c.jpg')).toBeDefined()
    expect(document.querySelectorAll('section')).toHaveLength(0)
    // Similarity slider defaults to 0%.
    expect((screen.getByLabelText(/Similarity/) as HTMLInputElement).value).toBe('0')
  })

  it('a 3-member cluster at the current threshold renders one bordered section with a "3 related photos" header, positioned chronologically among singleton blocks', () => {
    // p1/p2/p3 are hash-identical (distance 0, clusters at 0%); solo1 sorts
    // chronologically before them, solo2 sorts chronologically after them.
    const solo1 = makeEntry('solo1.jpg', 0, '2024-12-01T00:00:00Z')
    const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
    const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
    const p3 = makeEntry('p3.jpg', 3, '2025-01-03T00:00:00Z')
    const solo2 = makeEntry('solo2.jpg', 4, '2025-06-01T00:00:00Z')
    const photos = [solo1, p1, p2, p3, solo2]
    const metrics = new Map<string, PhotoMetrics | undefined>([
      [p1.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [p2.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [p3.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [solo1.id, makeMetrics(hashFromPositions(range(60, 69)))],
      [solo2.id, makeMetrics(hashFromPositions(range(90, 99)))],
    ])

    render(<PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} />)

    const sections = document.querySelectorAll('section')
    expect(sections).toHaveLength(1)
    expect(sections[0].textContent).toContain('3 related photos')

    // All five photos still render somewhere.
    expect(screen.getByText('solo1.jpg')).toBeDefined()
    expect(screen.getByText('p1.jpg')).toBeDefined()
    expect(screen.getByText('p2.jpg')).toBeDefined()
    expect(screen.getByText('p3.jpg')).toBeDefined()
    expect(screen.getByText('solo2.jpg')).toBeDefined()

    // Chronological position: the cluster section sits after solo1's card
    // and before solo2's card in document order.
    const solo1Img = screen.getByAltText('solo1.jpg')
    const solo2Img = screen.getByAltText('solo2.jpg')
    expect(solo1Img.compareDocumentPosition(sections[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(sections[0].compareDocumentPosition(solo2Img) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('moving the slider live re-renders blocks without tearing down and recreating an unrelated card', () => {
    // Both photos have no resolved hash, so they remain singletons at every
    // threshold — proving the re-render is a live update, not a remount.
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    render(<PhotoGrid photos={photos} metrics={emptyMetrics} getObjectUrl={getObjectUrl} />)

    const imgBefore = screen.getByAltText('a.jpg')
    fireEvent.change(screen.getByLabelText(/Similarity/), { target: { value: '50' } })
    const imgAfter = screen.getByAltText('a.jpg')

    expect(imgAfter).toBe(imgBefore)
  })

  it('debug mode is off by default: no checked toggle, no PairwiseDistances panel, no active Compare affordances', () => {
    const p1 = makeEntry('p1.jpg', 0)
    const p2 = makeEntry('p2.jpg', 1)
    const metrics = new Map<string, PhotoMetrics | undefined>([
      [p1.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [p2.id, makeMetrics(hashFromPositions(range(0, 9)))],
    ])

    render(<PhotoGrid photos={[p1, p2]} metrics={metrics} getObjectUrl={getObjectUrl} />)

    const debugToggle = screen.getByRole('checkbox', { name: 'Debug mode' }) as HTMLInputElement
    expect(debugToggle.checked).toBe(false)
    expect(screen.queryByText(/cosine distance/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Compare' })).toBeNull()
  })

  it('toggling debug mode on renders the PairwiseDistances panel for each multi-member cluster and a Compare button on every card', () => {
    const solo = makeEntry('solo.jpg', 0, '2024-12-01T00:00:00Z')
    const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
    const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
    const photos = [solo, p1, p2]
    const metrics = new Map<string, PhotoMetrics | undefined>([
      [p1.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [p2.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [solo.id, makeMetrics(hashFromPositions(range(60, 69)))],
    ])

    render(<PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} />)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Debug mode' }))

    // Pairwise distance line for the two-member cluster.
    expect(screen.getByText(/p1\.jpg ↔ p2\.jpg/)).toBeDefined()

    // A Compare button renders as a sibling on every card, clustered or not.
    expect(screen.getAllByRole('button', { name: 'Compare' })).toHaveLength(3)
  })

  // Finding #3: handleCompareClick's 3-branch state machine (no prior
  // selection -> pick first; one already picked -> pick second and
  // complete the pair; a complete pair already exists -> reset to a fresh
  // single pick) only had branch 1 covered previously. These two tests
  // cover branches 2 and 3.
  it('branch 2: clicking Compare on a second, different photo completes the pair and renders the computed Cosine distance', () => {
    const solo = makeEntry('solo.jpg', 0, '2024-12-01T00:00:00Z')
    const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
    const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
    const photos = [solo, p1, p2]
    const metrics = new Map<string, PhotoMetrics | undefined>([
      [p1.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [p2.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [solo.id, makeMetrics(hashFromPositions(range(60, 69)))],
    ])

    render(<PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Debug mode' }))

    // Blocks render chronologically: solo (earliest) first, then the
    // p1/p2 cluster section -- so Compare buttons in document order are
    // [solo, p1, p2].
    const compareButtons = screen.getAllByRole('button', { name: 'Compare' })
    fireEvent.click(compareButtons[1]) // p1: first pick (branch 1)
    fireEvent.click(compareButtons[2]) // p2: completes the pair (branch 2)

    expect(screen.getByText(/A: p1\.jpg/)).toBeDefined()
    expect(screen.getByText(/B: p2\.jpg/)).toBeDefined()
    // p1/p2 share an identical hash, so cosine distance is exactly 0.
    expect(screen.getByText(/Cosine distance: 0\.000/)).toBeDefined()
  })

  it('branch 3: clicking Compare on a third photo after a complete pair resets to a fresh single pick of that third photo', () => {
    const solo = makeEntry('solo.jpg', 0, '2024-12-01T00:00:00Z')
    const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
    const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
    const photos = [solo, p1, p2]
    const metrics = new Map<string, PhotoMetrics | undefined>([
      [p1.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [p2.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [solo.id, makeMetrics(hashFromPositions(range(60, 69)))],
    ])

    render(<PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Debug mode' }))

    const compareButtons = screen.getAllByRole('button', { name: 'Compare' })
    fireEvent.click(compareButtons[1]) // p1
    fireEvent.click(compareButtons[2]) // p2 -- completes the pair
    expect(screen.getByText(/Cosine distance:/)).toBeDefined()

    fireEvent.click(compareButtons[0]) // solo -- a complete pair already exists (branch 3)

    // Resets to a fresh single pick of solo -- not appended as a third
    // element, and not still showing the old p1/p2 pair.
    expect(screen.getByText(/A: solo\.jpg/)).toBeDefined()
    expect(screen.queryByText(/B: /)).toBeNull()
    expect(screen.getByText(/Click a second photo to compare\./)).toBeDefined()
    expect(screen.queryByText(/Cosine distance:/)).toBeNull()
  })

  // Finding #4: comparePair must reset (rather than keep a stale id) when
  // a compared photo is deleted -- otherwise `photosById.get(id)?.filename`
  // resolves to `undefined` and the panel literally renders "undefined".
  it('resets comparePair when one of the compared photos is removed from photos/metrics (e.g. deleted)', () => {
    const solo = makeEntry('solo.jpg', 0, '2024-12-01T00:00:00Z')
    const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
    const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
    const photos = [solo, p1, p2]
    const metrics = new Map<string, PhotoMetrics | undefined>([
      [p1.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [p2.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [solo.id, makeMetrics(hashFromPositions(range(60, 69)))],
    ])

    const { rerender } = render(
      <PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} />
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Debug mode' }))

    const compareButtons = screen.getAllByRole('button', { name: 'Compare' })
    fireEvent.click(compareButtons[1]) // p1
    fireEvent.click(compareButtons[2]) // p2 -- completes the pair
    expect(screen.getByText(/Cosine distance:/)).toBeDefined()

    // Simulate p2 being deleted: re-render with a shorter photos/metrics
    // list that excludes it, mirroring how PhotoUploadPage's
    // handleBatchDelete removes a photo from the `photos` prop.
    const remainingPhotos = [solo, p1]
    const remainingMetrics = new Map<string, PhotoMetrics | undefined>([
      [p1.id, makeMetrics(hashFromPositions(range(0, 9)))],
      [solo.id, makeMetrics(hashFromPositions(range(60, 69)))],
    ])
    rerender(
      <PhotoGrid photos={remainingPhotos} metrics={remainingMetrics} getObjectUrl={getObjectUrl} />
    )

    expect(screen.queryByText(/undefined/)).toBeNull()
    expect(
      screen.getByText(/Click "Compare" on any two photos to see their hashes and distance\./)
    ).toBeDefined()
  })
})

describe('PhotoGrid — U3: drag wiring spans the unified sequence (KTD2/KTD3)', () => {
  // solo1 and solo2 sit chronologically before/after a 2-member cluster.
  // m1/m2 are deliberately constructed with uploadIndex REVERSED relative
  // to capturedAt (m1: uploadIndex 5, captured first; m2: uploadIndex 1,
  // captured second) so any test that accidentally keyed off upload/insertion
  // order instead of capturedAt order would fail loudly. `photos` is passed
  // pre-sorted chronologically, exactly as hooks/usePhotos.ts's sortPhotos
  // would produce it -- PhotoGrid never re-sorts its `photos` prop itself.
  const solo1 = makeEntry('solo1.jpg', 0, '2024-12-01T00:00:00Z')
  const m1 = makeEntry('m1.jpg', 5, '2025-01-01T00:00:00Z')
  const m2 = makeEntry('m2.jpg', 1, '2025-01-02T00:00:00Z')
  const solo2 = makeEntry('solo2.jpg', 9, '2025-06-01T00:00:00Z')
  const photos = [solo1, m1, m2, solo2]
  const metrics = new Map<string, PhotoMetrics | undefined>([
    [m1.id, makeMetrics(hashFromPositions(range(0, 9)))],
    [m2.id, makeMetrics(hashFromPositions(range(0, 9)))],
    [solo1.id, makeMetrics(hashFromPositions(range(60, 69)))],
    [solo2.id, makeMetrics(hashFromPositions(range(90, 99)))],
  ])

  it("SortableContext's items is the full flat chronological id list, spanning across the cluster and both singleton runs (KTD2)", () => {
    render(
      <PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} onReorder={vi.fn()} />
    )

    // Sanity: m1/m2 really did cluster together into one bordered section.
    expect(document.querySelectorAll('section')).toHaveLength(1)

    expect(capturedSortableItems).toEqual([solo1.id, m1.id, m2.id, solo2.id])
  })

  it('renders cluster members in chronological (array) order, not upload-index order -- the critical KTD3 guarantee behind within-cluster drag resolution', () => {
    render(
      <PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} onReorder={vi.fn()} />
    )

    // m1 (uploadIndex 5, captured first) renders before m2 (uploadIndex 1,
    // captured second) -- the opposite of upload-index order, proving
    // capturedAt (not hierarchicalOrder or upload order) drives the visual
    // sequence that dnd-kit's `items` list and PhotoUploadPage's
    // handleDragEnd (`photos.findIndex`) both key off.
    const imgs = screen.getAllByRole('img').map((img) => (img as HTMLImageElement).alt)
    expect(imgs).toEqual(['solo1.jpg', 'm1.jpg', 'm2.jpg', 'solo2.jpg'])

    // Since `photos` is already in this exact order, dragging m2 onto m1 (a
    // within-cluster swap) resolves to (from=2, to=1) via
    // `photos.findIndex` -- identical to what a purely chronological
    // array-index computation over `photos` would produce. See
    // PhotoUploadPage.test.tsx's "within-cluster swap" test for the
    // corresponding handleDragEnd/reorderPhotos assertion using this same
    // fixture shape.
    expect(photos.findIndex((p) => p.id === m2.id)).toBe(2)
    expect(photos.findIndex((p) => p.id === m1.id)).toBe(1)
  })

  it('cluster member cards render as SortablePhotoCard (real drag sources), not plain PhotoCard, when onReorder is provided', () => {
    render(
      <PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} onReorder={vi.fn()} />
    )

    const section = document.querySelector('section') as HTMLElement
    const memberImgs = within(section).getAllByRole('img')
    expect(memberImgs).toHaveLength(2)
    // useSortable's mocked attributes (aria-roledescription) land on the
    // wrapper for every card -- cluster members included, not just singles.
    for (const img of memberImgs) {
      expect(img.closest('[aria-roledescription="sortable item"]')).not.toBeNull()
    }
  })

  it("debug mode's Compare button on a cluster member renders as a DOM sibling outside the card's drag-listener wrapper (KTD9), so clicking it cannot trigger a drag", () => {
    render(
      <PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} onReorder={vi.fn()} />
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'Debug mode' }))

    const img = screen.getByAltText('m1.jpg')
    const dragWrapper = img.closest('[data-testid="drag-listener"]') as HTMLElement
    expect(dragWrapper).not.toBeNull()

    const cardWrapper = dragWrapper.parentElement as HTMLElement
    const compareButton = within(cardWrapper).getByRole('button', { name: 'Compare' })

    // A true sibling of the drag wrapper, not nested inside it -- dnd-kit's
    // pointer listeners (spread onto dragWrapper) never cover this button,
    // so no stopPropagation is needed for it to avoid starting a drag.
    expect(dragWrapper.contains(compareButton)).toBe(false)
    expect(cardWrapper.contains(compareButton)).toBe(true)

    fireEvent.click(compareButton)
    expect(screen.getByText(/A: m1\.jpg/)).toBeDefined()
  })

  it('starting a drag from a card (interacting with the drag-listener wrapper itself) does not toggle its debug-mode compare state', () => {
    render(
      <PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} onReorder={vi.fn()} />
    )

    fireEvent.click(screen.getByRole('checkbox', { name: 'Debug mode' }))
    expect(screen.getByText(/on any two photos to see their hashes and distance/)).toBeDefined()

    const img = screen.getByAltText('m1.jpg')
    const dragWrapper = img.closest('[data-testid="drag-listener"]') as HTMLElement
    fireEvent.pointerDown(dragWrapper)
    fireEvent.click(dragWrapper)

    // comparePair is untouched by interacting with the drag-listener region
    // itself -- only the dedicated Compare button (outside that region)
    // sets it.
    expect(screen.getByText(/on any two photos to see their hashes and distance/)).toBeDefined()
  })
})

describe('PhotoGrid — U4: unified selection and inline editing across cluster and standalone cards', () => {
  // solo sits chronologically before a 2-member cluster (p1/p2, hash-identical
  // so they group at the 0% default threshold).
  const solo = makeEntry('solo.jpg', 0, '2024-12-01T00:00:00Z')
  const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
  const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
  const photos = [solo, p1, p2]
  const metrics = new Map<string, PhotoMetrics | undefined>([
    [p1.id, makeMetrics(hashFromPositions(range(0, 9)))],
    [p2.id, makeMetrics(hashFromPositions(range(0, 9)))],
    [solo.id, makeMetrics(hashFromPositions(range(60, 69)))],
  ])

  it('selecting a cluster member updates the same selectedIds a standalone selection would, visible in BatchEditPanel\'s count', () => {
    render(<SelectionHarness photos={photos} metrics={metrics} />)

    // No BatchEditPanel until something is selected.
    expect(screen.queryByText(/selected/)).toBeNull()

    // Select a cluster member (p1 sits inside the bordered section).
    const section = document.querySelector('section') as HTMLElement
    expect(within(section).getByAltText('p1.jpg')).toBeDefined()
    fireEvent.click(within(section).getByAltText('p1.jpg'))
    expect(screen.getByText('1 photo selected')).toBeDefined()

    // Select a standalone photo too -- same panel, same counting mechanism.
    fireEvent.click(screen.getByAltText('solo.jpg'))
    expect(screen.getByText('2 photos selected')).toBeDefined()
  })

  it('selecting photos both inside and outside a cluster in the same session produces one combined selection, not two separate ones', () => {
    render(<SelectionHarness photos={photos} metrics={metrics} />)

    fireEvent.click(screen.getByAltText('p1.jpg')) // cluster member
    fireEvent.click(screen.getByAltText('solo.jpg')) // standalone
    expect(screen.getByText('2 photos selected')).toBeDefined()

    // Deselecting the cluster member leaves exactly the standalone photo
    // selected -- if these were two independent selection mechanisms,
    // toggling one would not affect a shared count like this.
    fireEvent.click(screen.getByAltText('p1.jpg'))
    expect(screen.getByText('1 photo selected')).toBeDefined()

    const soloImg = screen.getByAltText('solo.jpg')
    expect(soloImg.closest('div')?.className).toContain('ring-2')
  })

  it("editing a cluster member's name or timestamp inline updates it the same way a standalone photo's inline edit does", () => {
    const onNameChange = vi.fn()
    const onTimestampChange = vi.fn()

    render(
      <PhotoGrid
        photos={photos}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        onNameChange={onNameChange}
        onTimestampChange={onTimestampChange}
      />
    )

    const section = document.querySelector('section') as HTMLElement
    expect(within(section).getByText('p1.jpg')).toBeDefined()

    // Rename the cluster member p1 inline.
    fireEvent.click(within(section).getByText('p1.jpg'))
    const clusterNameInput = within(section).getByDisplayValue('p1.jpg')
    fireEvent.change(clusterNameInput, { target: { value: 'renamed-p1.jpg' } })
    fireEvent.blur(clusterNameInput)
    expect(onNameChange).toHaveBeenCalledWith(p1.id, 'renamed-p1.jpg')

    // Rename the standalone solo photo the same way -- identical mechanism.
    fireEvent.click(screen.getByText('solo.jpg'))
    const soloNameInput = screen.getByDisplayValue('solo.jpg')
    fireEvent.change(soloNameInput, { target: { value: 'renamed-solo.jpg' } })
    fireEvent.blur(soloNameInput)
    expect(onNameChange).toHaveBeenCalledWith(solo.id, 'renamed-solo.jpg')

    // Edit the cluster member's timestamp inline too.
    const clusterDateText = within(section).getByText(/Jan 1, 2025/)
    fireEvent.click(clusterDateText)
    const clusterTsInput = within(section).getByDisplayValue('2025-01-01T00:00')
    fireEvent.change(clusterTsInput, { target: { value: '2025-01-01T12:30' } })
    fireEvent.blur(clusterTsInput)
    expect(onTimestampChange).toHaveBeenCalledWith(p1.id, new Date('2025-01-01T12:30:00Z'))

    // ...and the standalone photo's timestamp, the same way.
    const soloDateText = screen.getByText(/Dec 1, 2024/)
    fireEvent.click(soloDateText)
    const soloTsInput = screen.getByDisplayValue('2024-12-01T00:00')
    fireEvent.change(soloTsInput, { target: { value: '2024-12-01T08:15' } })
    fireEvent.blur(soloTsInput)
    expect(onTimestampChange).toHaveBeenCalledWith(solo.id, new Date('2024-12-01T08:15:00Z'))
  })
})

describe('PhotoGrid — U2: delete icon overlay', () => {
  const solo = makeEntry('solo.jpg', 0, '2024-12-01T00:00:00Z')
  const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
  const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
  const photos = [solo, p1, p2]
  const metrics = new Map<string, PhotoMetrics | undefined>([
    [p1.id, makeMetrics(hashFromPositions(range(0, 9)))],
    [p2.id, makeMetrics(hashFromPositions(range(0, 9)))],
    [solo.id, makeMetrics(hashFromPositions(range(60, 69)))],
  ])

  it('clicking a card\'s delete icon calls onDelete with that card\'s id, exactly once', () => {
    const onDelete = vi.fn()
    render(
      <PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} onDelete={onDelete} />
    )

    // p1 is a cluster member -- prove the id-bound wiring works there too.
    const section = document.querySelector('section') as HTMLElement
    const clusterCard = within(section).getByAltText('p1.jpg').closest('.flex.flex-col.gap-1') as HTMLElement
    fireEvent.click(within(clusterCard).getByRole('button', { name: 'Delete photo' }))

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(p1.id)
  })

  it('renders a delete icon on every card, with or without debug mode, clustered or not -- no card is missing it', () => {
    render(
      <PhotoGrid photos={photos} metrics={metrics} getObjectUrl={getObjectUrl} onDelete={vi.fn()} />
    )
    expect(screen.getAllByRole('button', { name: 'Delete photo' })).toHaveLength(3)

    fireEvent.click(screen.getByRole('checkbox', { name: 'Debug mode' }))
    expect(screen.getAllByRole('button', { name: 'Delete photo' })).toHaveLength(3)
  })

  it('clicking the delete icon on a SortablePhotoCard cluster member calls stopPropagation on pointerdown and click, so dnd-kit\'s drag listeners on the outer wrapper never see the gesture and no drag starts', () => {
    render(
      <PhotoGrid
        photos={photos}
        metrics={metrics}
        getObjectUrl={getObjectUrl}
        onReorder={vi.fn()}
        onDelete={vi.fn()}
      />
    )

    const img = screen.getByAltText('p1.jpg')
    const dragWrapper = img.closest('[data-testid="drag-listener"]') as HTMLElement
    expect(dragWrapper).not.toBeNull()

    const deleteButton = within(dragWrapper).getByRole('button', { name: 'Delete photo' })

    // dnd-kit's real `useSortable().listeners` (mocked here as a static
    // data-testid attribute) spreads a real onPointerDown React prop onto
    // this same wrapper in production -- what actually stops
    // PointerSensor from starting a drag on this gesture is the delete
    // icon's own handler calling stopPropagation() on the native event
    // before it can bubble up to that ancestor handler.
    const pointerDownEvent = new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    const pointerDownSpy = vi.spyOn(pointerDownEvent, 'stopPropagation')
    fireEvent(deleteButton, pointerDownEvent)
    expect(pointerDownSpy).toHaveBeenCalled()

    const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    const clickSpy = vi.spyOn(clickEvent, 'stopPropagation')
    fireEvent(deleteButton, clickEvent)
    expect(clickSpy).toHaveBeenCalled()
  })
})
