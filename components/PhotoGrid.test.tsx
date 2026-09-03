import { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { UseClusteredPhotosResult } from '@/hooks/useClusteredPhotos'
import { clusteredResult, flatResult } from '@/lib/test-helpers/cluster-render-blocks'
import BatchEditPanel from './BatchEditPanel'

afterEach(cleanup)

// Mock dnd-kit so tests don't need a real DndContext. `items` passed to
// SortableContext is captured so U3's tests can prove it's the full flat
// chronological id list (KTD2) without simulating a real pointer drag.
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

// U5: `useClusteredPhotos` now wraps a real HTTP-backed hook
// (`hooks/useClusterApi.ts`) — its own shaping/availability/loading
// behavior is covered by hooks/useClusteredPhotos.test.ts and
// hooks/useClusterApi.test.ts. This file mocks it entirely and only
// exercises what PhotoGrid itself is responsible for: turning
// `renderBlocks` into DOM, and wiring `availability`/`isLoading` into the
// slider's disabled state, the unavailable message, and the loading
// indicator.
const mockUseClusteredPhotos =
  vi.fn<(photos: PhotoEntry[], similarityPercent: number) => UseClusteredPhotosResult>()
vi.mock('@/hooks/useClusteredPhotos', () => ({
  useClusteredPhotos: (photos: PhotoEntry[], similarityPercent: number) =>
    mockUseClusteredPhotos(photos, similarityPercent),
  clusterKey: (cluster: { members: string[] }) => [...cluster.members].sort().join(','),
  // Mirrors the real hook's semantics exactly (earliest non-null capturedAt
  // among members, Infinity when every member is null) — PhotoGrid.tsx's
  // day-bucketing pass calls this directly, so a stub that always returned
  // 0 (or omitted the export) would either sort every test cluster into one
  // bucket or crash with "no export defined on the mock".
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

beforeEach(() => {
  capturedSortableItems = null
})

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

// Mirrors PhotoUploadPage's own selectedIds + toggleSelect (U4): a single
// page-level Set, passed to PhotoGrid and reflected in BatchEditPanel's
// count, exactly as the real app wires them. Used to prove selection is
// unified end to end rather than merely forwarded prop-for-prop within
// PhotoGrid in isolation.
function SelectionHarness({ photos }: { photos: PhotoEntry[] }) {
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
    mockUseClusteredPhotos.mockReturnValue(flatResult(photos))
    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)
    expect(screen.getByText('a.jpg')).toBeDefined()
    expect(screen.getByText('b.jpg')).toBeDefined()
  })

  it('renders SortablePhotoCard (with drag attributes) when onReorder is provided', () => {
    const photos = [makeEntry('a.jpg', 0)]
    mockUseClusteredPhotos.mockReturnValue(flatResult(photos))
    render(
      <PhotoGrid
        photos={photos}
        getObjectUrl={getObjectUrl}
        onReorder={vi.fn()}
      />
    )
    // useSortable adds aria-roledescription="sortable item" via attributes spread
    expect(document.querySelector('[aria-roledescription="sortable item"]')).not.toBeNull()
  })

  it('does NOT add drag attributes when onReorder is absent', () => {
    const photos = [makeEntry('a.jpg', 0)]
    mockUseClusteredPhotos.mockReturnValue(flatResult(photos))
    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)
    expect(document.querySelector('[aria-roledescription="sortable item"]')).toBeNull()
  })

  it('renders the correct number of cards', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1), makeEntry('c.jpg', 2)]
    mockUseClusteredPhotos.mockReturnValue(flatResult(photos))
    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)
    expect(screen.getAllByRole('img')).toHaveLength(3)
  })

  it('forwards selection props to cards (checked/onSelect reach the underlying card)', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUseClusteredPhotos.mockReturnValue(flatResult(photos))
    const onSelect = vi.fn()
    render(
      <PhotoGrid
        photos={photos}
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
    mockUseClusteredPhotos.mockReturnValue(flatResult(photos))

    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

    expect(screen.getByText('a.jpg')).toBeDefined()
    expect(screen.getByText('b.jpg')).toBeDefined()
    expect(screen.getByText('c.jpg')).toBeDefined()
    expect(document.querySelectorAll('section')).toHaveLength(0)
    // Similarity slider defaults to 0%.
    expect((screen.getByLabelText(/Similarity/) as HTMLInputElement).value).toBe('0')
  })

  it('a 3-member cluster renders one bordered section with a "3 related photos" header, positioned chronologically among singleton blocks', () => {
    const solo1 = makeEntry('solo1.jpg', 0, '2024-12-01T00:00:00Z')
    const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
    const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
    const p3 = makeEntry('p3.jpg', 3, '2025-01-03T00:00:00Z')
    const solo2 = makeEntry('solo2.jpg', 4, '2025-06-01T00:00:00Z')
    const photos = [solo1, p1, p2, p3, solo2]
    mockUseClusteredPhotos.mockReturnValue(
      clusteredResult(photos, [[solo1.id], [p1.id, p2.id, p3.id], [solo2.id]])
    )

    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

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

  it('moving the slider updates similarityPercent and re-renders without tearing down and recreating an unrelated card', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUseClusteredPhotos.mockReturnValue(flatResult(photos))
    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

    const imgBefore = screen.getByAltText('a.jpg')
    const slider = screen.getByLabelText(/Similarity/) as HTMLInputElement
    fireEvent.change(slider, { target: { value: '50' } })
    const imgAfter = screen.getByAltText('a.jpg')

    expect(slider.value).toBe('50')
    expect(imgAfter).toBe(imgBefore)
  })

  // R14: the hash-distance debug panel (debug-mode toggle, pairwise-distance
  // display, per-card Compare button) is removed entirely.
  it('renders no debug-mode UI: no "Debug mode" checkbox, no pairwise-distance panel, no Compare buttons', () => {
    const solo1 = makeEntry('solo1.jpg', 0, '2024-12-01T00:00:00Z')
    const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
    const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
    const photos = [solo1, p1, p2]
    mockUseClusteredPhotos.mockReturnValue(clusteredResult(photos, [[solo1.id], [p1.id, p2.id]]))

    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

    expect(screen.queryByRole('checkbox', { name: 'Debug mode' })).toBeNull()
    expect(screen.queryByText(/cosine distance/i)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Compare' })).toBeNull()
  })

  describe('availability/loading wiring (R9, R12, R13, KTD13, KTD14)', () => {
    it("disables the slider and shows no message while availability is 'checking'", () => {
      const photos = [makeEntry('a.jpg', 0)]
      mockUseClusteredPhotos.mockReturnValue(flatResult(photos, { availability: 'checking' }))

      render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

      const slider = screen.getByLabelText(/Similarity/) as HTMLInputElement
      expect(slider.disabled).toBe(true)
      expect(screen.queryByText('Clustering service unavailable')).toBeNull()
    })

    it("disables the slider and shows 'Clustering service unavailable' while availability is 'unavailable'", () => {
      const photos = [makeEntry('a.jpg', 0)]
      mockUseClusteredPhotos.mockReturnValue(flatResult(photos, { availability: 'unavailable' }))

      render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

      const slider = screen.getByLabelText(/Similarity/) as HTMLInputElement
      expect(slider.disabled).toBe(true)
      expect(screen.getByText('Clustering service unavailable')).toBeDefined()
    })

    it('keeps the slider enabled when availability is available', () => {
      const photos = [makeEntry('a.jpg', 0)]
      mockUseClusteredPhotos.mockReturnValue(flatResult(photos, { availability: 'available' }))

      render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

      const slider = screen.getByLabelText(/Similarity/) as HTMLInputElement
      expect(slider.disabled).toBe(false)
      expect(screen.queryByText('Clustering service unavailable')).toBeNull()
    })

    it("keeps rendering the last-known renderBlocks when availability transitions from 'available' to 'unavailable' mid-session (KTD14)", () => {
      const solo1 = makeEntry('solo1.jpg', 0, '2024-12-01T00:00:00Z')
      const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
      const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
      const photos = [solo1, p1, p2]
      const lastKnown = clusteredResult(photos, [[solo1.id], [p1.id, p2.id]], { availability: 'available' })

      mockUseClusteredPhotos.mockReturnValue(lastKnown)
      const { rerender } = render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

      expect(document.querySelectorAll('section')).toHaveLength(1)
      expect(screen.getByText('solo1.jpg')).toBeDefined()
      expect(screen.getByText('p1.jpg')).toBeDefined()
      expect(screen.getByText('p2.jpg')).toBeDefined()

      // A mid-session cluster-call failure (per hooks/useClusterApi.ts) flips
      // availability to 'unavailable' but keeps the same last-successful
      // renderBlocks (this is useClusterApi/useClusteredPhotos's own
      // contract, covered by their own tests) — PhotoGrid must not gate its
      // grid render on availability.
      mockUseClusteredPhotos.mockReturnValue({ ...lastKnown, availability: 'unavailable' })
      rerender(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

      expect(document.querySelectorAll('section')).toHaveLength(1)
      expect(screen.getByText('solo1.jpg')).toBeDefined()
      expect(screen.getByText('p1.jpg')).toBeDefined()
      expect(screen.getByText('p2.jpg')).toBeDefined()
      expect(screen.getByText('Clustering service unavailable')).toBeDefined()
      expect((screen.getByLabelText(/Similarity/) as HTMLInputElement).disabled).toBe(true)
    })

    it('shows a non-blocking loading indicator and keeps the slider enabled and the grid rendered while isLoading is true (R9)', () => {
      const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
      mockUseClusteredPhotos.mockReturnValue(flatResult(photos, { availability: 'available', isLoading: true }))

      render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

      const slider = screen.getByLabelText(/Similarity/) as HTMLInputElement
      expect(slider.disabled).toBe(false)
      expect(screen.getByText('a.jpg')).toBeDefined()
      expect(screen.getByText('b.jpg')).toBeDefined()
      expect(screen.getByRole('status')).toBeDefined()
    })

    it('shows no loading indicator when isLoading is false', () => {
      const photos = [makeEntry('a.jpg', 0)]
      mockUseClusteredPhotos.mockReturnValue(flatResult(photos, { isLoading: false }))

      render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

      expect(screen.queryByRole('status')).toBeNull()
    })
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

  beforeEach(() => {
    mockUseClusteredPhotos.mockReturnValue(
      clusteredResult(photos, [[solo1.id], [m1.id, m2.id], [solo2.id]])
    )
  })

  it("SortableContext's items is the full flat chronological id list, spanning across the cluster and both singleton runs (KTD2)", () => {
    render(
      <PhotoGrid photos={photos} getObjectUrl={getObjectUrl} onReorder={vi.fn()} />
    )

    // Sanity: m1/m2 really did cluster together into one bordered section.
    expect(document.querySelectorAll('section')).toHaveLength(1)

    expect(capturedSortableItems).toEqual([solo1.id, m1.id, m2.id, solo2.id])
  })

  it('renders cluster members in the order the hook provides them (chronological, not upload-index order) -- the critical KTD3 guarantee behind within-cluster drag resolution', () => {
    render(
      <PhotoGrid photos={photos} getObjectUrl={getObjectUrl} onReorder={vi.fn()} />
    )

    // m1 (uploadIndex 5, captured first) renders before m2 (uploadIndex 1,
    // captured second) -- the opposite of upload-index order, proving
    // PhotoGrid renders `renderBlocks` in the order given rather than
    // re-deriving its own order from `photos`.
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
      <PhotoGrid photos={photos} getObjectUrl={getObjectUrl} onReorder={vi.fn()} />
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
})

describe('PhotoGrid — U4: unified selection and inline editing across cluster and standalone cards', () => {
  // solo sits chronologically before a 2-member cluster (p1/p2).
  const solo = makeEntry('solo.jpg', 0, '2024-12-01T00:00:00Z')
  const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
  const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
  const photos = [solo, p1, p2]

  beforeEach(() => {
    mockUseClusteredPhotos.mockReturnValue(clusteredResult(photos, [[solo.id], [p1.id, p2.id]]))
  })

  it('selecting a cluster member updates the same selectedIds a standalone selection would, visible in BatchEditPanel\'s count', () => {
    render(<SelectionHarness photos={photos} />)

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
    render(<SelectionHarness photos={photos} />)

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

  beforeEach(() => {
    mockUseClusteredPhotos.mockReturnValue(clusteredResult(photos, [[solo.id], [p1.id, p2.id]]))
  })

  it('clicking a card\'s delete icon calls onDelete with that card\'s id, exactly once', () => {
    const onDelete = vi.fn()
    render(
      <PhotoGrid photos={photos} getObjectUrl={getObjectUrl} onDelete={onDelete} />
    )

    // p1 is a cluster member -- prove the id-bound wiring works there too.
    const section = document.querySelector('section') as HTMLElement
    const clusterCard = within(section).getByAltText('p1.jpg').closest('.flex.flex-col.gap-1') as HTMLElement
    fireEvent.click(within(clusterCard).getByRole('button', { name: 'Delete photo' }))

    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(p1.id)
  })

  it('renders a delete icon on every card, clustered or not -- no card is missing it', () => {
    render(
      <PhotoGrid photos={photos} getObjectUrl={getObjectUrl} onDelete={vi.fn()} />
    )
    expect(screen.getAllByRole('button', { name: 'Delete photo' })).toHaveLength(3)
  })

  it('clicking the delete icon on a SortablePhotoCard cluster member calls stopPropagation on pointerdown and click, so dnd-kit\'s drag listeners on the outer wrapper never see the gesture and no drag starts', () => {
    render(
      <PhotoGrid
        photos={photos}
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

describe('PhotoGrid — U4: zoom icon overlay', () => {
  const solo = makeEntry('solo.jpg', 0, '2024-12-01T00:00:00Z')
  const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
  const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
  const photos = [solo, p1, p2]

  beforeEach(() => {
    mockUseClusteredPhotos.mockReturnValue(clusteredResult(photos, [[solo.id], [p1.id, p2.id]]))
  })

  it('clicking a card\'s zoom icon calls onZoom with that card\'s id, exactly once', () => {
    const onZoom = vi.fn()
    render(
      <PhotoGrid photos={photos} getObjectUrl={getObjectUrl} onZoom={onZoom} />
    )

    // p1 is a cluster member -- prove the id-bound wiring works there too.
    const section = document.querySelector('section') as HTMLElement
    const clusterCard = within(section).getByAltText('p1.jpg').closest('.flex.flex-col.gap-1') as HTMLElement
    fireEvent.click(within(clusterCard).getByRole('button', { name: 'Zoom photo' }))

    expect(onZoom).toHaveBeenCalledTimes(1)
    expect(onZoom).toHaveBeenCalledWith(p1.id)
  })

  it('clicking the zoom icon on a SortablePhotoCard cluster member calls stopPropagation on pointerdown and click, so dnd-kit\'s drag listeners on the outer wrapper never see the gesture and no drag starts', () => {
    render(
      <PhotoGrid
        photos={photos}
        getObjectUrl={getObjectUrl}
        onReorder={vi.fn()}
        onZoom={vi.fn()}
      />
    )

    const img = screen.getByAltText('p1.jpg')
    const dragWrapper = img.closest('[data-testid="drag-listener"]') as HTMLElement
    expect(dragWrapper).not.toBeNull()

    const zoomButton = within(dragWrapper).getByRole('button', { name: 'Zoom photo' })

    // dnd-kit's real `useSortable().listeners` (mocked here as a static
    // data-testid attribute) spreads a real onPointerDown React prop onto
    // this same wrapper in production -- what actually stops
    // PointerSensor from starting a drag on this gesture is the zoom
    // icon's own handler calling stopPropagation() on the native event
    // before it can bubble up to that ancestor handler.
    const pointerDownEvent = new window.PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    const pointerDownSpy = vi.spyOn(pointerDownEvent, 'stopPropagation')
    fireEvent(zoomButton, pointerDownEvent)
    expect(pointerDownSpy).toHaveBeenCalled()

    const clickEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    const clickSpy = vi.spyOn(clickEvent, 'stopPropagation')
    fireEvent(zoomButton, clickEvent)
    expect(clickSpy).toHaveBeenCalled()
  })
})

describe('PhotoGrid — U5: day-boundary headers', () => {
  // Day headers are queried as headings whose accessible name is the
  // full-month formatted date (KTD9) -- distinct from the "N related
  // photos" per-cluster <h2> and any filename/date text on the cards
  // themselves, so `getByRole('heading', { name: ... })` unambiguously
  // targets the day header, not card content.
  function dayHeadings() {
    return screen.getAllByRole('heading').filter((h) => h.textContent !== null && /related photos/.test(h.textContent) === false)
  }

  it('a batch spanning 3 distinct UTC calendar days produces exactly 3 day headers, each with the correct full-month date, each immediately before that day\'s content', () => {
    const day1 = makeEntry('day1.jpg', 0, '2026-08-20T10:00:00Z')
    const day2 = makeEntry('day2.jpg', 1, '2026-08-21T10:00:00Z')
    const day3 = makeEntry('day3.jpg', 2, '2026-08-22T10:00:00Z')
    const photos = [day1, day2, day3]
    mockUseClusteredPhotos.mockReturnValue(flatResult(photos))

    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

    const headings = dayHeadings()
    expect(headings.map((h) => h.textContent)).toEqual(['August 20, 2026', 'August 21, 2026', 'August 22, 2026'])

    // Each header sits immediately before that day's photo in DOM order.
    const img1 = screen.getByAltText('day1.jpg')
    const img2 = screen.getByAltText('day2.jpg')
    const img3 = screen.getByAltText('day3.jpg')
    expect(headings[0].compareDocumentPosition(img1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(img1.compareDocumentPosition(headings[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(headings[1].compareDocumentPosition(img2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(img2.compareDocumentPosition(headings[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(headings[2].compareDocumentPosition(img3) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('AE2: a cluster whose earliest member is on day 1 and latest member on day 3 renders once, under day 1\'s header only -- not split, not duplicated', () => {
    // p1 (day1) is hash-identical to p2 (day3) so they cluster at the 0%
    // default threshold, spanning 3 calendar days end to end.
    const p1 = makeEntry('p1.jpg', 0, '2026-08-20T00:00:00Z')
    const p2 = makeEntry('p2.jpg', 1, '2026-08-22T00:00:00Z')
    const photos = [p1, p2]
    mockUseClusteredPhotos.mockReturnValue(clusteredResult(photos, [[p1.id, p2.id]]))

    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

    // Sanity: they really did cluster into one 2-member section.
    const sections = document.querySelectorAll('section')
    expect(sections).toHaveLength(1)
    expect(sections[0].textContent).toContain('2 related photos')

    // Exactly one day header, for day 1 -- not day 3, not two headers.
    const headings = dayHeadings()
    expect(headings.map((h) => h.textContent)).toEqual(['August 20, 2026'])

    // Both members render exactly once each, inside that one section.
    expect(screen.getAllByAltText('p1.jpg')).toHaveLength(1)
    expect(screen.getAllByAltText('p2.jpg')).toHaveLength(1)
  })

  it('AE5: a run of chronologically-adjacent singleton photos spanning two UTC days with no intervening cluster splits into two day groups, not one', () => {
    // None of these three photos share a hash with any other, so all three
    // stay singletons (one 'singles' render block) -- but two different
    // capturedAt calendar days, with no cluster in between to force a
    // block boundary.
    const s1 = makeEntry('s1.jpg', 0, '2026-08-20T23:00:00Z')
    const s2 = makeEntry('s2.jpg', 1, '2026-08-21T01:00:00Z')
    const s3 = makeEntry('s3.jpg', 2, '2026-08-21T02:00:00Z')
    const photos = [s1, s2, s3]
    mockUseClusteredPhotos.mockReturnValue(flatResult(photos))

    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

    // Sanity: still a flat run of singles, no cluster section.
    expect(document.querySelectorAll('section')).toHaveLength(0)

    const headings = dayHeadings()
    expect(headings.map((h) => h.textContent)).toEqual(['August 20, 2026', 'August 21, 2026'])

    const img1 = screen.getByAltText('s1.jpg')
    const img2 = screen.getByAltText('s2.jpg')
    const img3 = screen.getByAltText('s3.jpg')
    // s1 under day-1 header, s2/s3 under day-2 header.
    expect(headings[0].compareDocumentPosition(img1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(headings[1].compareDocumentPosition(img2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(headings[1].compareDocumentPosition(img3) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // img1 comes before headings[1] (day-1 content ends before day-2 starts).
    expect(img1.compareDocumentPosition(headings[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('AE3: a batch mixing dated and undated photos produces every dated header first (chronological), then exactly one trailing "Undated" header holding every null-timestamp entry', () => {
    const dated1 = makeEntry('dated1.jpg', 0, '2026-08-20T00:00:00Z')
    const dated2 = makeEntry('dated2.jpg', 1, '2026-08-21T00:00:00Z')
    const undated1 = makeEntry('undated1.jpg', 2, null)
    const undated2 = makeEntry('undated2.jpg', 3, null)
    // Passed with undated photos interleaved in the input array -- ordering
    // must come from the hook's null-last sort, not input order.
    const photos = [undated1, dated1, undated2, dated2]
    // Display order is chronological (null-last, tie-broken by uploadIndex)
    // regardless of input order -- mirrors what the real hook would produce.
    mockUseClusteredPhotos.mockReturnValue(
      clusteredResult(photos, [[dated1.id], [dated2.id], [undated1.id], [undated2.id]])
    )

    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

    const headings = dayHeadings()
    expect(headings.map((h) => h.textContent)).toEqual(['August 20, 2026', 'August 21, 2026', 'Undated'])

    // Both undated photos render after the last dated header, under the
    // single trailing "Undated" header.
    const undatedHeading = headings[2]
    const img1 = screen.getByAltText('undated1.jpg')
    const img2 = screen.getByAltText('undated2.jpg')
    expect(undatedHeading.compareDocumentPosition(img1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(undatedHeading.compareDocumentPosition(img2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('a batch with zero dated photos (all null capturedAt) renders exactly one "Undated" header and no dated headers', () => {
    const photos = [makeEntry('u1.jpg', 0, null), makeEntry('u2.jpg', 1, null)]
    mockUseClusteredPhotos.mockReturnValue(flatResult(photos))

    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

    expect(dayHeadings().map((h) => h.textContent)).toEqual(['Undated'])
  })

  it('a single-day, fully-dated batch renders exactly one day header, above all photos', () => {
    const a = makeEntry('a.jpg', 0, '2026-08-20T01:00:00Z')
    const b = makeEntry('b.jpg', 1, '2026-08-20T22:00:00Z')
    const photos = [a, b]
    mockUseClusteredPhotos.mockReturnValue(flatResult(photos))

    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

    const headings = dayHeadings()
    expect(headings.map((h) => h.textContent)).toEqual(['August 20, 2026'])

    const imgA = screen.getByAltText('a.jpg')
    const imgB = screen.getByAltText('b.jpg')
    expect(headings[0].compareDocumentPosition(imgA) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(headings[0].compareDocumentPosition(imgB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('moving the similarity slider (changing cluster membership) re-renders day headers without duplicating or dropping any -- same count/order regardless of clustering state', () => {
    // p1/p2 only cluster once the slider is raised past 50%; both are on
    // the same calendar day, s1/s2 fall on two other distinct days that
    // never change membership.
    const s1 = makeEntry('s1.jpg', 0, '2026-08-19T00:00:00Z')
    const p1 = makeEntry('p1.jpg', 1, '2026-08-20T00:00:00Z')
    const p2 = makeEntry('p2.jpg', 2, '2026-08-20T01:00:00Z')
    const s2 = makeEntry('s2.jpg', 3, '2026-08-21T00:00:00Z')
    const photos = [s1, p1, p2, s2]
    mockUseClusteredPhotos.mockImplementation((_photos, similarityPercent) =>
      similarityPercent >= 70
        ? clusteredResult(photos, [[s1.id], [p1.id, p2.id], [s2.id]])
        : flatResult(photos)
    )

    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

    // Before: p1/p2 too strict to cluster at the 0% default -- no section.
    expect(document.querySelectorAll('section')).toHaveLength(0)
    const before = dayHeadings().map((h) => h.textContent)
    expect(before).toEqual(['August 19, 2026', 'August 20, 2026', 'August 21, 2026'])

    fireEvent.change(screen.getByLabelText(/Similarity/), { target: { value: '70' } })

    // After: p1/p2 now cluster into one section, but the day-header
    // count/order is identical -- clustering state never perturbs it.
    expect(document.querySelectorAll('section')).toHaveLength(1)
    const after = dayHeadings().map((h) => h.textContent)
    expect(after).toEqual(before)
  })

  it('a day bucket mixing two standalone singles and a 2-member cluster renders exactly one day header, with both singles runs and the cluster section under it, in chronological order', () => {
    // Two standalone singles, then a 2-member cluster, then a third
    // standalone single -- all on the same UTC calendar day, so
    // `flushSinglesRun` pushes more than one block (a singles grid, the
    // cluster section, then another singles grid) into a single day
    // bucket. clusterA/clusterB share a hash (distance 0) so they merge at
    // the 0% default threshold; every single has a distinct hash so none
    // of them accidentally cluster together or with clusterA/clusterB.
    const single1 = makeEntry('single1.jpg', 0, '2026-08-20T01:00:00Z')
    const single2 = makeEntry('single2.jpg', 1, '2026-08-20T02:00:00Z')
    const clusterA = makeEntry('clusterA.jpg', 2, '2026-08-20T03:00:00Z')
    const clusterB = makeEntry('clusterB.jpg', 3, '2026-08-20T04:00:00Z')
    const single3 = makeEntry('single3.jpg', 4, '2026-08-20T05:00:00Z')
    const photos = [single1, single2, clusterA, clusterB, single3]
    mockUseClusteredPhotos.mockReturnValue(
      clusteredResult(photos, [[single1.id], [single2.id], [clusterA.id, clusterB.id], [single3.id]])
    )

    render(<PhotoGrid photos={photos} getObjectUrl={getObjectUrl} />)

    // Sanity: exactly one 2-member cluster section formed.
    const sections = document.querySelectorAll('section')
    expect(sections).toHaveLength(1)
    expect(sections[0].textContent).toContain('2 related photos')

    // Exactly one day header for the shared day -- not one per singles run.
    const headings = dayHeadings()
    expect(headings.map((h) => h.textContent)).toEqual(['August 20, 2026'])

    // Every photo renders exactly once -- no duplicate-key-driven double
    // render, none dropped.
    expect(screen.getAllByAltText('single1.jpg')).toHaveLength(1)
    expect(screen.getAllByAltText('single2.jpg')).toHaveLength(1)
    expect(screen.getAllByAltText('clusterA.jpg')).toHaveLength(1)
    expect(screen.getAllByAltText('clusterB.jpg')).toHaveLength(1)
    expect(screen.getAllByAltText('single3.jpg')).toHaveLength(1)

    // Chronological order under the one header: first singles run, then
    // the cluster section, then the second singles run.
    const heading = headings[0]
    const img1 = screen.getByAltText('single1.jpg')
    const img2 = screen.getByAltText('single2.jpg')
    const imgA = screen.getByAltText('clusterA.jpg')
    const imgB = screen.getByAltText('clusterB.jpg')
    const img3 = screen.getByAltText('single3.jpg')

    expect(heading.compareDocumentPosition(img1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(img1.compareDocumentPosition(img2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(img2.compareDocumentPosition(imgA) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(imgA.compareDocumentPosition(imgB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(imgB.compareDocumentPosition(img3) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
