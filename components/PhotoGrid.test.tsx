import { useState } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { ClusterRenderBlock, UseClusteredPhotosResult } from '@/hooks/useClusteredPhotos'
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

/**
 * Builds `renderBlocks` the same way the real `useClusteredPhotos` does
 * (adjacent single-member "clusters" bundled into one `'singles'` block,
 * any 2+-member group standing alone as a `'cluster'` block) from a plain
 * ordered list of groups — each group either one id (a singleton) or
 * several (a cluster) — so tests can describe the exact DOM shape they want
 * without going through real clustering/hashing at all.
 */
function buildRenderBlocks(groups: string[][]): ClusterRenderBlock[] {
  const blocks: ClusterRenderBlock[] = []
  for (const members of groups) {
    if (members.length > 1) {
      blocks.push({ type: 'cluster', cluster: { id: `cluster-${members.join('-')}`, members } })
      continue
    }
    const single = { id: `single-${members[0]}`, members }
    const last = blocks[blocks.length - 1]
    if (last?.type === 'singles') last.clusters.push(single)
    else blocks.push({ type: 'singles', clusters: [single] })
  }
  return blocks
}

/** Builds a full `UseClusteredPhotosResult` mock return value from `photos` and a `groups` shape (see `buildRenderBlocks`). */
function clusteredResult(
  photos: PhotoEntry[],
  groups: string[][],
  overrides: Partial<UseClusteredPhotosResult> = {}
): UseClusteredPhotosResult {
  const photosById = new Map(photos.map((p) => [p.id, p]))
  const renderBlocks = buildRenderBlocks(groups)
  const visualOrder = renderBlocks.flatMap((block) =>
    block.type === 'cluster' ? block.cluster.members : block.clusters.map((c) => c.members[0])
  )
  return {
    renderBlocks,
    photosById,
    visualOrder,
    availability: 'available',
    isLoading: false,
    ...overrides,
  }
}

/** Shorthand for the common "no clusters, every photo a plain singleton" shape. */
function flatResult(photos: PhotoEntry[], overrides: Partial<UseClusteredPhotosResult> = {}): UseClusteredPhotosResult {
  return clusteredResult(
    photos,
    photos.map((p) => [p.id]),
    overrides
  )
}

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
