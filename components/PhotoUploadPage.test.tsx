import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act, within } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { UseClusteredPhotosResult } from '@/hooks/useClusteredPhotos'
import { clusteredResult, flatResult } from '@/lib/test-helpers/cluster-render-blocks'
import { formatDate } from '@/lib/datetime-local'
import PhotoUploadPage from './PhotoUploadPage'

afterEach(cleanup)

// Mock hooks so we can control EXIF output. `usePhotos` itself is mocked --
// `compareByCapturedAt` is kept real (via importOriginal) since
// `hooks/useClusteredPhotos.ts` imports it from this module for chronological
// member ordering.
//
// `useClusteredPhotos` is mocked entirely (same technique as
// `components/PhotoGrid.test.tsx`) rather than left real: real clustering now
// goes through `useClusterApi` -> an actual network `fetch` to
// photo-tidy-api's proxy routes, which this file has no interest in
// exercising -- these tests care about PhotoUploadPage's own wiring (drag,
// delete, batch editing, Google Photos import/upload), not the clustering
// pipeline itself (covered by hooks/useClusteredPhotos.test.ts and
// hooks/useClusterApi.test.ts). A handful of tests below still want a real
// multi-member cluster on screen to exercise cluster-aware drag/delete/
// batch-timestamp logic; they get one by overriding this mock's
// implementation to return a specific `renderBlocks` shape, the same way
// PhotoGrid.test.tsx's `clusteredResult` helper does.
vi.mock('@/hooks/usePhotos', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/usePhotos')>()
  return { ...actual, usePhotos: vi.fn() }
})
vi.mock('@/hooks/useObjectUrls', () => ({
  useObjectUrls: vi.fn(),
}))
vi.mock('@/hooks/useGoogleAuth', () => ({
  useGoogleAuth: vi.fn(),
}))
vi.mock('@/hooks/useGooglePhotosPicker', () => ({
  useGooglePhotosPicker: vi.fn(),
}))
vi.mock('@/hooks/useGooglePhotosUpload', () => ({
  useGooglePhotosUpload: vi.fn(),
}))
vi.mock('@/hooks/usePhotoPersistence', () => ({
  usePhotoPersistence: vi.fn(),
}))
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

// U2: `PhotoUploadPage`'s "Download all" handler calls `buildPhotoZipBlob`/
// `triggerDownload` (lib/download.ts, U1) directly -- mocked here the same
// closure-capture way `useClusteredPhotos` is mocked above, so individual
// tests below can control resolution/rejection and inspect exactly what
// entries were passed.
// `buildOrderedZipEntries`/`buildZipFilename` (Fix 5) are kept real here via
// importOriginal -- several tests below assert on their actual behavior
// (visual-order/KTD9 reconciliation, filename sanitization/fallback), so
// stubbing them out would defeat those assertions. Only `buildPhotoZipBlob`/
// `triggerDownload` are replaced, same closure-capture technique as
// `useClusteredPhotos` above.
const mockBuildPhotoZipBlob =
  vi.fn<(entries: PhotoEntry[], onProgress?: (done: number, total: number) => void) => Promise<Blob>>()
const mockTriggerDownload = vi.fn<(blob: Blob, filename: string) => void>()
vi.mock('@/lib/download', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/download')>()
  return {
    ...actual,
    buildPhotoZipBlob: (
      entries: PhotoEntry[],
      onProgress?: (done: number, total: number) => void
    ) => mockBuildPhotoZipBlob(entries, onProgress),
    triggerDownload: (blob: Blob, filename: string) => mockTriggerDownload(blob, filename),
  }
})

// U2 (Keep best): `getPhotoDimensions` is mocked (async decode via
// createImageBitmap isn't available in jsdom) the same closure-capture
// technique as `buildPhotoZipBlob` above; `pickBestPhoto` is kept real via
// importOriginal since it's pure logic already covered by
// lib/photo-quality.test.ts, and these tests want to exercise the real
// comparator wired into the component, not a stub of it.
const mockGetPhotoDimensions = vi.fn<(file: File) => Promise<{ width: number; height: number }>>()
vi.mock('@/lib/photo-quality', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/photo-quality')>()
  return {
    ...actual,
    getPhotoDimensions: (file: File) => mockGetPhotoDimensions(file),
  }
})

// Capture dnd-kit callbacks so tests can invoke them directly
let capturedOnDragStart: ((e: { active: { id: string } }) => void) | null = null
let capturedOnDragEnd: ((e: { active: { id: string }; over: { id: string } | null }) => void) | null = null

// Capture the exact `onBatchDelete` prop PhotoUploadPage hands to
// BatchEditPanel, so tests can invoke it directly without going through a
// real click. The real BatchEditPanel is still rendered underneath (via
// importOriginal), so every other test in this file that exercises "Delete
// selected" through the actual UI is completely unaffected.
let capturedOnBatchDelete: (() => void) | null = null

vi.mock('./BatchEditPanel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./BatchEditPanel')>()
  const Actual = actual.default
  return {
    ...actual,
    default: (props: React.ComponentProps<typeof Actual> & { onBatchDelete: () => void }) => {
      capturedOnBatchDelete = props.onBatchDelete
      return <Actual {...props} />
    },
  }
})

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({
    children,
    onDragStart,
    onDragEnd,
  }: {
    children: React.ReactNode
    onDragStart: (e: { active: { id: string } }) => void
    onDragEnd: (e: { active: { id: string }; over: { id: string } | null }) => void
  }) => {
    capturedOnDragStart = onDragStart
    capturedOnDragEnd = onDragEnd
    return <>{children}</>
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="drag-overlay">{children}</div>
  ),
  closestCenter: vi.fn(),
  PointerSensor: vi.fn(),
  useSensor: vi.fn(),
  useSensors: vi.fn(() => []),
}))

// `arrayMove` is kept real (via importOriginal) -- `handleDragEnd`
// (components/PhotoUploadPage.tsx) uses it directly, on the real visual
// order, to resolve a drop's true final neighbors.
vi.mock('@dnd-kit/sortable', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/sortable')>()
  return {
    ...actual,
    SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useSortable: () => ({
      attributes: {},
      listeners: {},
      setNodeRef: vi.fn(),
      transform: null,
      transition: null,
      isDragging: false,
    }),
    rectSortingStrategy: vi.fn(),
  }
})

import { usePhotos } from '@/hooks/usePhotos'
import { useObjectUrls } from '@/hooks/useObjectUrls'
import { useGoogleAuth } from '@/hooks/useGoogleAuth'
import { useGooglePhotosPicker } from '@/hooks/useGooglePhotosPicker'
import { useGooglePhotosUpload } from '@/hooks/useGooglePhotosUpload'
import { usePhotoPersistence } from '@/hooks/usePhotoPersistence'
const mockUsePhotos = vi.mocked(usePhotos)
const mockUseObjectUrls = vi.mocked(useObjectUrls)
const mockUseGoogleAuth = vi.mocked(useGoogleAuth)
const mockUseGooglePhotosPicker = vi.mocked(useGooglePhotosPicker)
const mockUseGooglePhotosUpload = vi.mocked(useGooglePhotosUpload)
const mockUsePhotoPersistence = vi.mocked(usePhotoPersistence)

function makeFile(name: string): File {
  return new File([], name, { type: 'image/jpeg' })
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedOnDragStart = null
  capturedOnDragEnd = null
  capturedOnBatchDelete = null
  // Default: no clustering (every photo its own singleton) -- matches the
  // pre-U6 "no metrics -> no clustering" baseline most tests below rely on.
  // Tests that need a real multi-member cluster on screen override this with
  // their own `mockUseClusteredPhotos.mockImplementation(...)` before
  // rendering (see `renderWithCluster` and similar below).
  mockUseClusteredPhotos.mockImplementation((photos) => flatResult(photos))
  mockUseObjectUrls.mockReturnValue({
    getObjectUrl: (file: File) => `blob:${file.name}`,
    releaseObjectUrl: vi.fn(),
  })
  mockUseGoogleAuth.mockReturnValue({
    accessToken: null,
    expiresAt: null,
    accountEmail: null,
    isSignedIn: false,
    isExpiringSoon: false,
    signIn: vi.fn(),
    signOut: vi.fn(),
  })
  mockUseGooglePhotosPicker.mockReturnValue({
    status: 'idle',
    error: null,
    startImport: vi.fn(),
    cancelImport: vi.fn(),
  })
  mockUseGooglePhotosUpload.mockReturnValue({
    uploadState: 'idle',
    photoStates: new Map(),
    startUpload: vi.fn(),
    retryFailed: vi.fn(),
    reset: vi.fn(),
    seedPhotoStates: vi.fn(),
    notifyPhotoRemoved: vi.fn(),
  })
  mockUsePhotoPersistence.mockReturnValue({
    isRestoring: false,
    storageWarning: null,
    clearAllPersisted: vi.fn(),
  })
  // Default: every file decodes to {0, 0} ("failed") unless a test
  // overrides this with its own per-file mapping.
  mockGetPhotoDimensions.mockReset()
  mockGetPhotoDimensions.mockResolvedValue({ width: 0, height: 0 })
})

describe('PhotoUploadPage', () => {
  it('shows upload prompt and hides grid before any files are selected', () => {
    mockUsePhotos.mockReturnValue({
      photos: [],
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
    })

    render(<PhotoUploadPage />)

    expect(screen.getByText(/click to select photos/i)).toBeDefined()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('renders sorted grid after selecting files with EXIF', async () => {
    const processFilesMock = vi.fn()

    // Start empty, then simulate photos being set after processFiles resolves
    mockUsePhotos
      .mockReturnValueOnce({ photos: [], processFiles: processFilesMock, reorderPhotos: vi.fn() })
      .mockReturnValue({
        photos: [
          {
            id: 'a.jpg-0',
            file: makeFile('a.jpg'),
            filename: 'a.jpg',
            capturedAt: new Date('2024-01-01T10:00:00Z'),
            uploadIndex: 0,
            source: 'local',
          },
          {
            id: 'b.jpg-1',
            file: makeFile('b.jpg'),
            filename: 'b.jpg',
            capturedAt: new Date('2025-06-15T08:30:00Z'),
            uploadIndex: 1,
            source: 'local',
          },
          {
            id: 'c.jpg-2',
            file: makeFile('c.jpg'),
            filename: 'c.jpg',
            capturedAt: new Date('2023-03-20T16:45:00Z'),
            uploadIndex: 2,
            source: 'local',
          },
        ],
        processFiles: processFilesMock,
      reorderPhotos: vi.fn(),
      })

    const { rerender } = render(<PhotoUploadPage />)

    // Trigger rerender with photos populated
    rerender(<PhotoUploadPage />)

    await waitFor(() => {
      expect(screen.getByText('a.jpg')).toBeDefined()
      expect(screen.getByText('b.jpg')).toBeDefined()
      expect(screen.getByText('c.jpg')).toBeDefined()
    })
  })

  it('shows no-date files with "No date" label', async () => {
    mockUsePhotos.mockReturnValue({
      photos: [
        {
          file: makeFile('nodates.jpg'),
          filename: 'nodates.jpg',
          capturedAt: null,
          uploadIndex: 0,
        },
      ],
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
    })

    render(<PhotoUploadPage />)

    expect(screen.getByText('No date')).toBeDefined()
  })

  it('calls processFiles when files are selected', async () => {
    const processFilesMock = vi.fn()
    mockUsePhotos.mockReturnValue({ photos: [], processFiles: processFilesMock, reorderPhotos: vi.fn() })

    render(<PhotoUploadPage />)

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = makeFile('photo.jpg')
    Object.defineProperty(input, 'files', { value: [file], writable: false })
    fireEvent.change(input)

    expect(processFilesMock).toHaveBeenCalled()
  })

  it('calls processFiles when files are dropped onto the drop zone', () => {
    const processFilesMock = vi.fn()
    mockUsePhotos.mockReturnValue({ photos: [], processFiles: processFilesMock, reorderPhotos: vi.fn() })

    render(<PhotoUploadPage />)

    const label = document.querySelector('label') as HTMLLabelElement
    const file = makeFile('dropped.jpg')
    fireEvent.drop(label, {
      dataTransfer: { files: [file] },
    })

    expect(processFilesMock).toHaveBeenCalled()
  })

  it('hides the grid when photos array is empty', () => {
    mockUsePhotos.mockReturnValue({ photos: [], processFiles: vi.fn(), reorderPhotos: vi.fn() })

    render(<PhotoUploadPage />)

    // No img elements rendered
    expect(screen.queryAllByRole('img')).toHaveLength(0)
  })
})

describe('PhotoUploadPage — drag and drop reorder', () => {
  function makeEntry(name: string, index: number) {
    const file = makeFile(name)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: new Date(`2025-0${index + 1}-01T10:00:00Z`),
      uploadIndex: index,
    }
  }

  function photoId(entry: ReturnType<typeof makeEntry>) {
    return entry.id
  }

  it('calls updatePhotoTimestamp with the timestamp computed from true visual neighbors on dragEnd', () => {
    // No metrics -> no clustering, so visual order equals the flat
    // chronological array here; this proves handleDragEnd's new
    // visual-order-based resolution still produces the right result for the
    // simple (non-clustered) case.
    const updatePhotoTimestampMock = vi.fn()
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1), makeEntry('c.jpg', 2)]
    mockUsePhotos.mockReturnValue({
      photos,
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
      updatePhotoTimestamp: updatePhotoTimestampMock,
    })

    render(<PhotoUploadPage />)

    act(() => {
      capturedOnDragEnd?.({
        active: { id: photoId(photos[2]) },
        over: { id: photoId(photos[0]) },
      })
    })

    // c dropped at the very front: no prev neighbor, next neighbor is a --
    // slotTimestamp's edge-offset rule (ported into handleDragEnd via
    // computeDroppedTimestamp) gives a's timestamp minus 1 second.
    expect(updatePhotoTimestampMock).toHaveBeenCalledWith(
      photoId(photos[2]),
      new Date(photos[0].capturedAt.getTime() - 1000)
    )
  })

  it('does not call updatePhotoTimestamp when dropped outside the grid (over is null)', () => {
    const updatePhotoTimestampMock = vi.fn()
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUsePhotos.mockReturnValue({
      photos,
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
      updatePhotoTimestamp: updatePhotoTimestampMock,
    })

    render(<PhotoUploadPage />)

    act(() => {
      capturedOnDragEnd?.({
        active: { id: photoId(photos[0]) },
        over: null,
      })
    })

    expect(updatePhotoTimestampMock).not.toHaveBeenCalled()
  })

  it('renders a floating PhotoCard in DragOverlay when drag is active', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUsePhotos.mockReturnValue({
      photos,
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
    })

    render(<PhotoUploadPage />)

    act(() => {
      capturedOnDragStart?.({ active: { id: photoId(photos[0]) } })
    })

    const overlay = document.querySelector('[data-testid="drag-overlay"]')
    expect(overlay?.textContent).toContain('a.jpg')
  })

  // U3: PhotoGrid now spans the whole chronological sequence -- cluster
  // sections and singleton runs -- in one DndContext/SortableContext
  // (KTD2). `handleDragEnd` itself needs no changes (it only ever resolves
  // from/to via `photos.findIndex`), but these scenarios prove that holds
  // once a real cluster is in the picture -- `useClusteredPhotos` is mocked
  // (see top of file) to report m1/m2 as a 2-member cluster; only dnd-kit
  // itself is mocked otherwise, same as the rest of this describe block.
  describe('across a real cluster (KTD2/KTD3)', () => {
    // solo1, then a 2-member cluster (m1, m2), then solo2 -- passed
    // pre-sorted chronologically, exactly as hooks/usePhotos.ts would
    // produce. m1/m2 are reported as a cluster by the mocked
    // useClusteredPhotos below.
    const solo1 = makeEntry('solo1.jpg', 0)
    const m1 = makeEntry('m1.jpg', 1)
    const m2 = makeEntry('m2.jpg', 2)
    const solo2 = makeEntry('solo2.jpg', 3)
    const photos = [solo1, m1, m2, solo2]

    function renderWithCluster(updatePhotoTimestampMock: ReturnType<typeof vi.fn>) {
      mockUsePhotos.mockReturnValue({
        photos,
        processFiles: vi.fn(),
        reorderPhotos: vi.fn(),
        updatePhotoTimestamp: updatePhotoTimestampMock,
      })
      mockUseClusteredPhotos.mockImplementation((currentPhotos) =>
        clusteredResult(currentPhotos, [[solo1.id], [m1.id, m2.id], [solo2.id]])
      )
      render(<PhotoUploadPage />)
      // Sanity: m1/m2 really did render as a bordered cluster section.
      expect(document.querySelectorAll('section')).toHaveLength(1)
    }

    it('AE2: dragging a standalone photo to a position inside a cluster\'s visual span resolves the timestamp from its true visual neighbors', () => {
      const updatePhotoTimestampMock = vi.fn()
      renderWithCluster(updatePhotoTimestampMock)

      // solo1 (index 0) dropped onto m2 (index 2, inside the cluster's
      // span). This cluster is array-contiguous, so visual order equals
      // flat order here -- the true final neighbors after the drop are m2
      // (prev) and solo2 (next).
      act(() => {
        capturedOnDragEnd?.({ active: { id: photoId(solo1) }, over: { id: photoId(m2) } })
      })

      const expectedTimestamp = new Date(
        Math.round((m2.capturedAt.getTime() + solo2.capturedAt.getTime()) / 2)
      )
      expect(updatePhotoTimestampMock).toHaveBeenCalledWith(photoId(solo1), expectedTimestamp)
    })

    it('dragging a cluster member to a position outside any cluster resolves the timestamp from its true visual neighbors', () => {
      const updatePhotoTimestampMock = vi.fn()
      renderWithCluster(updatePhotoTimestampMock)

      // m1 (index 1, inside the cluster) dropped onto solo2 (index 3,
      // outside any cluster). True final neighbors: solo2 (prev), no next.
      act(() => {
        capturedOnDragEnd?.({ active: { id: photoId(m1) }, over: { id: photoId(solo2) } })
      })

      const expectedTimestamp = new Date(solo2.capturedAt.getTime() + 1000)
      expect(updatePhotoTimestampMock).toHaveBeenCalledWith(photoId(m1), expectedTimestamp)
      expect(updatePhotoTimestampMock).toHaveBeenCalledOnce()
    })

    it('CRITICAL (KTD3): dragging one cluster member to swap with another member of the same cluster resolves the timestamp the same way a purely chronological computation would', () => {
      const updatePhotoTimestampMock = vi.fn()
      renderWithCluster(updatePhotoTimestampMock)

      // m2 (index 2) dropped onto m1 (index 1) -- both inside the same
      // cluster. Chronological member ordering (KTD3) keeps visual order in
      // agreement with `photos`' flat order for this fixture, so the true
      // final neighbors are solo1 (prev) and m1 (next).
      act(() => {
        capturedOnDragEnd?.({ active: { id: photoId(m2) }, over: { id: photoId(m1) } })
      })

      const expectedTimestamp = new Date(
        Math.round((solo1.capturedAt.getTime() + m1.capturedAt.getTime()) / 2)
      )
      expect(updatePhotoTimestampMock).toHaveBeenCalledWith(photoId(m2), expectedTimestamp)
    })

    it('DragOverlay renders correctly for a card that started inside a cluster section', () => {
      const updatePhotoTimestampMock = vi.fn()
      renderWithCluster(updatePhotoTimestampMock)

      act(() => {
        capturedOnDragStart?.({ active: { id: photoId(m1) } })
      })

      const overlay = document.querySelector('[data-testid="drag-overlay"]')
      expect(overlay?.textContent).toContain('m1.jpg')
    })
  })

  // P0 fix regression tests: a cluster's members are NOT guaranteed to be
  // array-contiguous in the flat `photos` array (clustering is by hash
  // similarity, not time), so `photos.findIndex` on `over.id` could
  // silently resolve the wrong neighbors and corrupt the written-back
  // timestamp. These reproduce the two concrete divergence scenarios from
  // the post-implementation code review and prove handleDragEnd's
  // visual-order-based resolution (hooks/useClusteredPhotos.ts's
  // `visualOrder`) fixes both.
  describe('non-contiguous cluster and null-timestamp visual-order fix (P0)', () => {
    function makeDatedEntry(name: string, index: number, capturedAt: string) {
      const file = makeFile(name)
      return {
        id: `${name}-${index}`,
        file,
        filename: name,
        capturedAt: new Date(capturedAt),
        uploadIndex: index,
      }
    }

    it('non-contiguous cluster: resolves the dropped timestamp from the true visual neighbors, not the flat-array neighbors', () => {
      // A and C are reported as a cluster by the mocked useClusteredPhotos
      // below; B is not, and B's capturedAt sits strictly between A's and
      // C's. The flat, purely-chronological `photos` array is [A, B, C], but
      // the cluster (anchored to A, its earliest member) renders visually as
      // [A, C, B] -- the cluster section first, B's singleton run after.
      const a = makeDatedEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
      const b = makeDatedEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
      const c = makeDatedEntry('c.jpg', 2, '2025-01-03T00:00:00Z')
      const photos = [a, b, c] // pre-sorted chronologically, as usePhotos would produce

      const updatePhotoTimestampMock = vi.fn()
      mockUsePhotos.mockReturnValue({
        photos,
        processFiles: vi.fn(),
        reorderPhotos: vi.fn(),
        updatePhotoTimestamp: updatePhotoTimestampMock,
      })
      mockUseClusteredPhotos.mockImplementation((currentPhotos) =>
        clusteredResult(currentPhotos, [[a.id, c.id], [b.id]])
      )

      render(<PhotoUploadPage />)

      // Confirm the visual order really is A, C, B (one cluster section
      // followed by B's singleton), diverging from flat photos [A, B, C].
      expect(document.querySelectorAll('section')).toHaveLength(1)
      const imgs = screen.getAllByRole('img').map((img) => (img as HTMLImageElement).alt)
      expect(imgs).toEqual(['a.jpg', 'c.jpg', 'b.jpg'])

      // Drag B and drop it onto C -- visually, dropping B "onto" C in
      // [A, C, B] slots B back between A and C, so B's true final
      // neighbors are A (prev) and C (next).
      act(() => {
        capturedOnDragEnd?.({ active: { id: b.id }, over: { id: c.id } })
      })

      const expectedTimestamp = new Date(Math.round((a.capturedAt.getTime() + c.capturedAt.getTime()) / 2))
      expect(updatePhotoTimestampMock).toHaveBeenCalledWith(b.id, expectedTimestamp)

      // Prove the fix: the OLD buggy flat-array computation
      // (photos.findIndex over [A, B, C]) would instead resolve C as the
      // sole (prev) neighbor with no next, yielding C's timestamp + 1s.
      const buggyFlatTimestamp = new Date(c.capturedAt.getTime() + 1000)
      expect(updatePhotoTimestampMock).not.toHaveBeenCalledWith(b.id, buggyFlatTimestamp)
    })

    it("null-timestamp cluster-mate: resolves the dropped timestamp from the true visual neighbor, not the null-dated member's flat-array tail position", () => {
      // D1 (dated) and N1 (null capturedAt) are reported as a cluster by the
      // mocked useClusteredPhotos below. D2 is dated earlier than D1; D3 is
      // dated later than D1. `sortPhotos` (hooks/usePhotos.ts) puts every
      // dated photo before every null-dated one regardless of cluster
      // membership, so the flat
      // array is [D2, D1, D3, N1] -- N1 always at the tail. But the cluster
      // (anchored to D1, its only dated member) renders mid-grid, right
      // after D2 and before D3 -- so N1's true visual position is
      // immediately after D1, not at the tail.
      const d2 = makeDatedEntry('d2.jpg', 0, '2025-01-01T00:00:00Z')
      const d1 = makeDatedEntry('d1.jpg', 1, '2025-01-02T00:00:00Z')
      const d3 = makeDatedEntry('d3.jpg', 2, '2025-01-03T00:00:00Z')
      const n1 = { ...makeDatedEntry('n1.jpg', 3, '2025-01-04T00:00:00Z'), capturedAt: null }
      const photos = [d2, d1, d3, n1] // pre-sorted per sortPhotos' null-last convention

      const updatePhotoTimestampMock = vi.fn()
      mockUsePhotos.mockReturnValue({
        photos,
        processFiles: vi.fn(),
        reorderPhotos: vi.fn(),
        updatePhotoTimestamp: updatePhotoTimestampMock,
      })
      mockUseClusteredPhotos.mockImplementation((currentPhotos) =>
        clusteredResult(currentPhotos, [[d2.id], [d1.id, n1.id], [d3.id]])
      )

      render(<PhotoUploadPage />)

      // Confirm the cluster (d1, n1) renders mid-grid, between d2 and d3 --
      // diverging from the flat array's [d2, d1, d3, n1] tail position for n1.
      expect(document.querySelectorAll('section')).toHaveLength(1)
      const imgs = screen.getAllByRole('img').map((img) => (img as HTMLImageElement).alt)
      expect(imgs).toEqual(['d2.jpg', 'd1.jpg', 'n1.jpg', 'd3.jpg'])

      // Drag d3 and drop it onto n1 -- visually, d3's true final prev
      // neighbor becomes d1 (n1 has no timestamp to average with), so the
      // edge-offset rule applies: d1's timestamp + 1 second.
      act(() => {
        capturedOnDragEnd?.({ active: { id: d3.id }, over: { id: n1.id } })
      })

      const expectedTimestamp = new Date(d1.capturedAt.getTime() + 1000)
      expect(updatePhotoTimestampMock).toHaveBeenCalledWith(d3.id, expectedTimestamp)

      // Prove the fix: the OLD buggy flat-array computation would have
      // resolved n1 itself as the (null-timestamp) prev neighbor with no
      // next, landing in the "keep as-is" branch -- d3's timestamp
      // unchanged -- instead of properly slotting it after d1.
      expect(updatePhotoTimestampMock).not.toHaveBeenCalledWith(d3.id, d3.capturedAt)
    })
  })
})

describe('PhotoUploadPage — Google Photos batch naming', () => {
  function makeEntry(name: string, index: number) {
    const file = makeFile(name)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: new Date(`2025-0${index + 1}-01T10:00:00Z`),
      uploadIndex: index,
    }
  }

  function signIn() {
    mockUseGoogleAuth.mockReturnValue({
      accessToken: 'token-123',
      expiresAt: Date.now() + 60_000,
      accountEmail: 'user@example.com',
      isSignedIn: true,
      isExpiringSoon: false,
      signIn: vi.fn(),
      signOut: vi.fn(),
    })
  }

  it('prompts for a batch name when importing and stores it in albumName', () => {
    signIn()
    const startImportMock = vi.fn()
    mockUseGooglePhotosPicker.mockReturnValue({
      status: 'idle',
      error: null,
      startImport: startImportMock,
      cancelImport: vi.fn(),
    })
    mockUsePhotos.mockReturnValue({
      photos: [makeEntry('a.jpg', 0)],
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
    })

    render(<PhotoUploadPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Import from Google Photos' }))

    const nameInput = screen.getByPlaceholderText('Name this batch')
    fireEvent.change(nameInput, { target: { value: 'Vacaciones 2024' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(startImportMock).toHaveBeenCalledOnce()
    const albumInput = screen.getByPlaceholderText('Album name') as HTMLInputElement
    expect(albumInput.value).toBe('Vacaciones 2024')
  })

  it('cancelling the name prompt collapses it without starting the picker session', () => {
    signIn()
    const startImportMock = vi.fn()
    mockUseGooglePhotosPicker.mockReturnValue({
      status: 'idle',
      error: null,
      startImport: startImportMock,
      cancelImport: vi.fn(),
    })
    mockUsePhotos.mockReturnValue({
      photos: [makeEntry('a.jpg', 0)],
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
    })

    render(<PhotoUploadPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Import from Google Photos' }))
    fireEvent.change(screen.getByPlaceholderText('Name this batch'), {
      target: { value: 'Abandoned Name' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(startImportMock).not.toHaveBeenCalled()
    expect(screen.queryByPlaceholderText('Name this batch')).toBeNull()
    const albumInput = screen.getByPlaceholderText('Album name') as HTMLInputElement
    expect(albumInput.value).toBe('')
  })

  it('local-only session: typing directly into the Album Name field enables upload', () => {
    signIn()
    mockUsePhotos.mockReturnValue({
      photos: [makeEntry('a.jpg', 0)],
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
    })

    render(<PhotoUploadPage />)

    const albumInput = screen.getByPlaceholderText('Album name') as HTMLInputElement
    const uploadButton = screen.getByRole('button', { name: 'Upload to Google Photos' }) as HTMLButtonElement
    expect(uploadButton.disabled).toBe(true)

    fireEvent.change(albumInput, { target: { value: 'Trip Photos' } })

    expect(uploadButton.disabled).toBe(false)
  })

  it('importing twice with different names: the second name replaces the first', () => {
    signIn()
    const startImportMock = vi.fn()
    mockUseGooglePhotosPicker.mockReturnValue({
      status: 'idle',
      error: null,
      startImport: startImportMock,
      cancelImport: vi.fn(),
    })
    mockUsePhotos.mockReturnValue({
      photos: [makeEntry('a.jpg', 0)],
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
    })

    render(<PhotoUploadPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Import from Google Photos' }))
    fireEvent.change(screen.getByPlaceholderText('Name this batch'), {
      target: { value: 'First Trip' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    let albumInput = screen.getByPlaceholderText('Album name') as HTMLInputElement
    expect(albumInput.value).toBe('First Trip')

    fireEvent.click(screen.getByRole('button', { name: 'Import from Google Photos' }))
    const namePromptInput = screen.getByPlaceholderText('Name this batch') as HTMLInputElement
    expect(namePromptInput.value).toBe('First Trip')
    fireEvent.change(namePromptInput, { target: { value: 'Second Trip' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))

    expect(startImportMock).toHaveBeenCalledTimes(2)
    albumInput = screen.getByPlaceholderText('Album name') as HTMLInputElement
    expect(albumInput.value).toBe('Second Trip')
  })

  it('whitespace-only name leaves the upload button disabled with helper text', () => {
    signIn()
    mockUsePhotos.mockReturnValue({
      photos: [makeEntry('a.jpg', 0)],
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
    })

    render(<PhotoUploadPage />)

    const albumInput = screen.getByPlaceholderText('Album name') as HTMLInputElement
    fireEvent.change(albumInput, { target: { value: '   ' } })

    const uploadButton = screen.getByRole('button', { name: 'Upload to Google Photos' }) as HTMLButtonElement
    expect(uploadButton.disabled).toBe(true)
    expect(screen.getByText('Enter a name to enable upload')).toBeDefined()
  })

  it('toggles upload button disabled state as the album name is entered and cleared', () => {
    signIn()
    mockUsePhotos.mockReturnValue({
      photos: [makeEntry('a.jpg', 0)],
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
    })

    render(<PhotoUploadPage />)

    const albumInput = screen.getByPlaceholderText('Album name') as HTMLInputElement
    const uploadButton = screen.getByRole('button', { name: 'Upload to Google Photos' }) as HTMLButtonElement
    expect(uploadButton.disabled).toBe(true)

    fireEvent.change(albumInput, { target: { value: 'Some Name' } })
    expect(uploadButton.disabled).toBe(false)

    fireEvent.change(albumInput, { target: { value: '' } })
    expect(uploadButton.disabled).toBe(true)
  })
})

describe('PhotoUploadPage — batch delete', () => {
  function makeEntry(name: string, index: number) {
    const file = makeFile(name)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: new Date(`2025-0${index + 1}-01T10:00:00Z`),
      uploadIndex: index,
    }
  }

  function basePhotosReturn(photos: ReturnType<typeof makeEntry>[], removePhotos = vi.fn()) {
    return {
      photos,
      hasEdits: false,
      processFiles: vi.fn(),
      addPhotos: vi.fn(),
      reorderPhotos: vi.fn(),
      updatePhotoName: vi.fn(),
      updatePhotoTimestamp: vi.fn(),
      batchUpdateNames: vi.fn(),
      batchSetTimestamps: vi.fn(),
      removePhotos,
    }
  }

  /**
   * Wires mockUsePhotos to a mutable photo list: removePhotos filters the
   * list in place, so the *next* render (triggered by any state change,
   * e.g. clearSelection) reflects the deletion — mirroring how the real
   * usePhotos hook re-renders after setPhotos.
   */
  function makeStatefulPhotosMock(initialPhotos: ReturnType<typeof makeEntry>[]) {
    let current = initialPhotos
    const removePhotosMock = vi.fn((ids: string[]) => {
      const idSet = new Set(ids)
      current = current.filter((p) => !idSet.has(p.id))
    })
    mockUsePhotos.mockImplementation(() => basePhotosReturn(current, removePhotosMock))
    return removePhotosMock
  }

  function signIn() {
    mockUseGoogleAuth.mockReturnValue({
      accessToken: 'token-123',
      expiresAt: Date.now() + 60_000,
      accountEmail: 'user@example.com',
      isSignedIn: true,
      isExpiringSoon: false,
      signIn: vi.fn(),
      signOut: vi.fn(),
    })
  }

  it('selecting 2 of 5 photos and clicking Delete selected shrinks the list to 3, removing the deleted photos', () => {
    const photos = [
      makeEntry('a.jpg', 0),
      makeEntry('b.jpg', 1),
      makeEntry('c.jpg', 2),
      makeEntry('d.jpg', 3),
      makeEntry('e.jpg', 4),
    ]
    const removePhotosMock = makeStatefulPhotosMock(photos)

    render(<PhotoUploadPage />)

    fireEvent.click(screen.getByAltText('b.jpg'))
    fireEvent.click(screen.getByAltText('d.jpg'))

    expect(screen.getByText('2 photos selected')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))

    expect(removePhotosMock).toHaveBeenCalledOnce()
    const removedIds = removePhotosMock.mock.calls[0][0] as string[]
    expect(new Set(removedIds)).toEqual(new Set([photos[1].id, photos[3].id]))

    expect(screen.queryAllByRole('img')).toHaveLength(3)
    expect(screen.queryByAltText('b.jpg')).toBeNull()
    expect(screen.queryByAltText('d.jpg')).toBeNull()
    expect(screen.getByAltText('a.jpg')).toBeDefined()
    expect(screen.getByAltText('c.jpg')).toBeDefined()
    expect(screen.getByAltText('e.jpg')).toBeDefined()
  })

  it('deleting every selected photo empties the list with no error and clears the selection', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    const removePhotosMock = makeStatefulPhotosMock(photos)

    render(<PhotoUploadPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByText('2 photos selected')).toBeDefined()

    expect(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    }).not.toThrow()

    expect(removePhotosMock).toHaveBeenCalledOnce()
    const removedIds = removePhotosMock.mock.calls[0][0] as string[]
    expect(new Set(removedIds)).toEqual(new Set([photos[0].id, photos[1].id]))

    // Selection cleared and grid/batch UI gone since photos is now empty
    expect(screen.queryAllByRole('img')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Delete selected' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Select all' })).toBeNull()
    expect(screen.getByText(/click to select photos/i)).toBeDefined()
  })

  it('integration: after deleting a photo, the next startUpload call no longer includes that photo id', () => {
    signIn()
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    const startUploadMock = vi.fn()

    mockUseGooglePhotosUpload.mockReturnValue({
      uploadState: 'idle',
      photoStates: new Map(),
      startUpload: startUploadMock,
      retryFailed: vi.fn(),
      reset: vi.fn(),
      seedPhotoStates: vi.fn(),
      notifyPhotoRemoved: vi.fn(),
    })

    const removePhotosMock = makeStatefulPhotosMock(photos)

    render(<PhotoUploadPage />)

    // Enable the upload button
    fireEvent.change(screen.getByPlaceholderText('Album name'), {
      target: { value: 'Trip Photos' },
    })

    // Select and delete a.jpg
    fireEvent.click(screen.getByAltText('a.jpg'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
    expect(removePhotosMock).toHaveBeenCalledWith([photos[0].id])

    // Now trigger the upload — should only see the remaining photo
    fireEvent.click(screen.getByRole('button', { name: 'Upload to Google Photos' }))

    expect(startUploadMock).toHaveBeenCalledOnce()
    const uploadedPhotos = startUploadMock.mock.calls[0][0] as typeof photos
    const uploadedIds = uploadedPhotos.map((p) => p.id)
    expect(uploadedIds).not.toContain(photos[0].id)
    expect(uploadedIds).toEqual([photos[1].id])
  })

  // U6: with handleClusterDelete gone, every delete -- cluster-originated or
  // not -- flows through handleBatchDelete. These two scenarios prove that
  // path still does both jobs it always did (object URL release + selectedIds
  // pruning) for a photo that would render inside a cluster section, exactly
  // as it does for a plain standalone photo -- there's nothing structurally
  // special about a "cluster member" now that selection/delete are unified.
  it('U6: deleting a selection that includes a photo that would render inside a cluster releases its object URL, same as a standalone delete', () => {
    const photos = [
      makeEntry('solo1.jpg', 0),
      makeEntry('m1.jpg', 1),
      makeEntry('m2.jpg', 2),
      makeEntry('solo2.jpg', 3),
    ]
    const removePhotosMock = makeStatefulPhotosMock(photos)
    const releaseObjectUrlMock = vi.fn()
    mockUseObjectUrls.mockReturnValue({
      getObjectUrl: (file: File) => `blob:${file.name}`,
      releaseObjectUrl: releaseObjectUrlMock,
    })
    // m1/m2 are reported as a cluster by the mocked useClusteredPhotos below
    // -- same fixture technique as the "across a real cluster" drag tests
    // above.
    mockUseClusteredPhotos.mockImplementation((currentPhotos) =>
      clusteredResult(currentPhotos, [[photos[0].id], [photos[1].id, photos[2].id], [photos[3].id]])
    )

    render(<PhotoUploadPage />)
    // Sanity: m1/m2 really did render as a bordered cluster section.
    expect(document.querySelectorAll('section')).toHaveLength(1)

    fireEvent.click(screen.getByAltText('m1.jpg'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))

    expect(removePhotosMock).toHaveBeenCalledWith([photos[1].id])
    expect(releaseObjectUrlMock).toHaveBeenCalledWith(photos[1].file)
    expect(releaseObjectUrlMock).toHaveBeenCalledOnce()
  })

  it('U6: deleting a mixed selection of a cluster member and a standalone photo releases both object URLs and prunes selectedIds in one call', () => {
    const photos = [
      makeEntry('solo1.jpg', 0),
      makeEntry('m1.jpg', 1),
      makeEntry('m2.jpg', 2),
      makeEntry('solo2.jpg', 3),
    ]
    const removePhotosMock = makeStatefulPhotosMock(photos)
    const releaseObjectUrlMock = vi.fn()
    mockUseObjectUrls.mockReturnValue({
      getObjectUrl: (file: File) => `blob:${file.name}`,
      releaseObjectUrl: releaseObjectUrlMock,
    })
    mockUseClusteredPhotos.mockImplementation((currentPhotos) =>
      clusteredResult(currentPhotos, [[photos[0].id], [photos[1].id, photos[2].id], [photos[3].id]])
    )

    render(<PhotoUploadPage />)
    expect(document.querySelectorAll('section')).toHaveLength(1)

    // Mixed selection: solo1 (standalone) + m1 (cluster member), one delete.
    fireEvent.click(screen.getByAltText('solo1.jpg'))
    fireEvent.click(screen.getByAltText('m1.jpg'))
    expect(screen.getByText('2 photos selected')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))

    expect(removePhotosMock).toHaveBeenCalledOnce()
    const removedIds = removePhotosMock.mock.calls[0][0] as string[]
    expect(new Set(removedIds)).toEqual(new Set([photos[0].id, photos[1].id]))

    expect(releaseObjectUrlMock).toHaveBeenCalledWith(photos[0].file)
    expect(releaseObjectUrlMock).toHaveBeenCalledWith(photos[1].file)
    expect(releaseObjectUrlMock).toHaveBeenCalledTimes(2)

    // Selection pruned for both deleted ids in the same call -- no lingering
    // BatchEditPanel/count survives for the remaining photos (m2, solo2).
    expect(screen.queryByText(/photos? selected/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete selected' })).toBeNull()
  })

  // handleBatchDelete accepts an explicit `ids` param so the per-card
  // delete icon can delete a single photo that isn't necessarily selected
  // -- these prove the selection-pruning behavior is scoped to exactly the
  // deleted id(s) rather than unconditionally clearing the whole selection.
  // The "no arguments" case is driven through `capturedOnBatchDelete`
  // (module-level, captured from the real BatchEditPanel's `onBatchDelete`
  // prop via the mock at the top of this file); the explicit-id cases are
  // driven through the real per-card delete icon, since that's its only
  // production entry point.
  describe('explicit-id delete', () => {
    it('calling with no arguments still deletes every selected photo and clears the whole selection (unchanged default behavior)', () => {
      const photos = [
        makeEntry('a.jpg', 0),
        makeEntry('b.jpg', 1),
        makeEntry('c.jpg', 2),
      ]
      const removePhotosMock = makeStatefulPhotosMock(photos)
      const releaseObjectUrlMock = vi.fn()
      mockUseObjectUrls.mockReturnValue({
        getObjectUrl: (file: File) => `blob:${file.name}`,
        releaseObjectUrl: releaseObjectUrlMock,
      })

      render(<PhotoUploadPage />)

      fireEvent.click(screen.getByAltText('a.jpg'))
      fireEvent.click(screen.getByAltText('b.jpg'))
      expect(screen.getByText('2 photos selected')).toBeDefined()

      act(() => {
        capturedOnBatchDelete?.()
      })

      expect(removePhotosMock).toHaveBeenCalledOnce()
      const removedIds = removePhotosMock.mock.calls[0][0] as string[]
      expect(new Set(removedIds)).toEqual(new Set([photos[0].id, photos[1].id]))

      expect(releaseObjectUrlMock).toHaveBeenCalledWith(photos[0].file)
      expect(releaseObjectUrlMock).toHaveBeenCalledWith(photos[1].file)
      expect(releaseObjectUrlMock).toHaveBeenCalledTimes(2)

      // Whole selection cleared -- c.jpg (never selected) remains untouched.
      expect(screen.queryAllByRole('img')).toHaveLength(1)
      expect(screen.getByAltText('c.jpg')).toBeDefined()
    })

    it('calling with a single id from a 3-photo selection removes only that photo and prunes only its id, leaving the other 2 still selected', () => {
      const photos = [
        makeEntry('a.jpg', 0),
        makeEntry('b.jpg', 1),
        makeEntry('c.jpg', 2),
        makeEntry('d.jpg', 3),
      ]
      const removePhotosMock = makeStatefulPhotosMock(photos)
      const releaseObjectUrlMock = vi.fn()
      mockUseObjectUrls.mockReturnValue({
        getObjectUrl: (file: File) => `blob:${file.name}`,
        releaseObjectUrl: releaseObjectUrlMock,
      })

      render(<PhotoUploadPage />)

      // 3-photo selection: a, b, c. d stays unselected throughout.
      fireEvent.click(screen.getByAltText('a.jpg'))
      fireEvent.click(screen.getByAltText('b.jpg'))
      fireEvent.click(screen.getByAltText('c.jpg'))
      expect(screen.getByText('3 photos selected')).toBeDefined()

      // Delete a via its own per-card delete icon, not the batch button.
      const deleteButtons = screen.getAllByRole('button', { name: 'Delete photo' })
      fireEvent.click(deleteButtons[0])

      expect(removePhotosMock).toHaveBeenCalledWith([photos[0].id])
      expect(releaseObjectUrlMock).toHaveBeenCalledWith(photos[0].file)
      expect(releaseObjectUrlMock).toHaveBeenCalledOnce()

      // a is gone; b, c, d remain, and b/c are still selected (only a's id
      // was pruned from selectedIds) -- so the "2 photos selected" count
      // (b, c) still reflects on the still-mounted BatchEditPanel mock.
      expect(screen.queryByAltText('a.jpg')).toBeNull()
      expect(screen.getByAltText('b.jpg')).toBeDefined()
      expect(screen.getByAltText('c.jpg')).toBeDefined()
      expect(screen.getByAltText('d.jpg')).toBeDefined()
      expect(screen.getByText('2 photos selected')).toBeDefined()
    })

    it('deleting an id that is not currently selected still deletes that photo and leaves selectedIds completely unchanged', () => {
      const photos = [
        makeEntry('a.jpg', 0),
        makeEntry('b.jpg', 1),
        makeEntry('c.jpg', 2),
      ]
      const removePhotosMock = makeStatefulPhotosMock(photos)
      const releaseObjectUrlMock = vi.fn()
      mockUseObjectUrls.mockReturnValue({
        getObjectUrl: (file: File) => `blob:${file.name}`,
        releaseObjectUrl: releaseObjectUrlMock,
      })

      render(<PhotoUploadPage />)

      // Select only b -- a 1-photo selection that does NOT include c.
      fireEvent.click(screen.getByAltText('b.jpg'))
      expect(screen.getByText('1 photo selected')).toBeDefined()

      // Delete c, which was never in the selection, via its own per-card
      // delete icon.
      const deleteButtons = screen.getAllByRole('button', { name: 'Delete photo' })
      fireEvent.click(deleteButtons[2])

      expect(removePhotosMock).toHaveBeenCalledWith([photos[2].id])
      expect(releaseObjectUrlMock).toHaveBeenCalledWith(photos[2].file)
      expect(releaseObjectUrlMock).toHaveBeenCalledOnce()

      // c is gone; a, b remain. selectedIds is completely unchanged -- b is
      // still the sole selected photo.
      expect(screen.queryByAltText('c.jpg')).toBeNull()
      expect(screen.getByAltText('a.jpg')).toBeDefined()
      expect(screen.getByAltText('b.jpg')).toBeDefined()
      expect(screen.getByText('1 photo selected')).toBeDefined()
    })
  })
})

// U7: the timeline/cluster-view toggle is gone entirely -- one grid renders
// whenever photos are loaded, with no "Group similar photos" / "Back to
// timeline view" control anywhere, and the page-level selection controls
// ("Select all" / "Clear selection") render unconditionally rather than
// being gated on a now-removed `viewMode`. `components/ClusterView.tsx`
// itself was deleted in this unit -- everything it did was already ported
// into `PhotoGrid`/`useClusteredPhotos` (U1-U6).
describe('PhotoUploadPage — unified grid (no view toggle)', () => {
  function makeEntry(name: string, index: number) {
    const file = makeFile(name)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: new Date(`2025-0${index + 1}-01T10:00:00Z`),
      uploadIndex: index,
    }
  }

  function basePhotosReturn(photos: ReturnType<typeof makeEntry>[]) {
    return {
      photos,
      processFiles: vi.fn(),
      addPhotos: vi.fn(),
      reorderPhotos: vi.fn(),
      updatePhotoName: vi.fn(),
      updatePhotoTimestamp: vi.fn(),
      batchUpdateNames: vi.fn(),
      batchSetTimestamps: vi.fn(),
      removePhotos: vi.fn(),
    }
  }

  it('renders the grid directly with no view-mode toggle button anywhere', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    expect(screen.getByAltText('a.jpg')).toBeDefined()
    expect(screen.getByAltText('b.jpg')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Group similar photos' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back to timeline view' })).toBeNull()
  })

  it('"Select all" and "Clear selection" render unconditionally, regardless of any cluster grouping', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    expect(screen.getByRole('button', { name: 'Select all' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull()

    fireEvent.click(screen.getByAltText('a.jpg'))
    expect(screen.getByText('1 photo selected')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Select all' })).toBeDefined()
    // Once selected, both the page-level "Clear selection" link and
    // BatchEditPanel's own "Clear selection" button render (unrelated to
    // this unit) -- assert at least one exists rather than exactly one.
    expect(screen.getAllByRole('button', { name: 'Clear selection' }).length).toBeGreaterThan(0)
  })

  it('calls useClusteredPhotos (via PhotoGrid) unconditionally with the current photos', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    expect(mockUseClusteredPhotos).toHaveBeenCalledWith(photos, expect.any(Number))
  })
})

// Finding #2: distinctSelectedTimestamps (PhotoUploadPage.tsx) dedupes the
// current selection's existing capturedAt values by exact millisecond and
// feeds BatchEditPanel's quick-pick buttons. This exercises the real
// derivation -- not a mock or a hand-duplicated copy of its logic -- with a
// selection spanning two distinct clusters reported by the mocked
// useClusteredPhotos (see top of file).
describe('PhotoUploadPage — cross-cluster batch quick-pick timestamps (finding #2)', () => {
  function makeEntry(name: string, index: number, capturedAt: string) {
    const file = makeFile(name)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: new Date(capturedAt),
      uploadIndex: index,
    }
  }

  // Mirrors BatchEditPanel's own quickPickFormatter (components/BatchEditPanel.tsx)
  // exactly, purely to compute the expected button label text for assertions --
  // production code is not touched here.
  const quickPickFormatter = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'UTC',
  })

  it('quick-pick buttons show the union of distinct timestamps from both clusters, not either cluster alone', () => {
    // Two distinct clusters: m1a/m1b (cluster A), m2a/m2b (cluster B),
    // reported by the mocked useClusteredPhotos below. Each member carries
    // its own distinct capturedAt, so a selection spanning one member from
    // each cluster spans two distinct timestamps.
    const m1a = makeEntry('m1a.jpg', 0, '2025-01-01T10:00:00Z')
    const m1b = makeEntry('m1b.jpg', 1, '2025-01-02T10:00:00Z')
    const m2a = makeEntry('m2a.jpg', 2, '2025-02-01T10:00:00Z')
    const m2b = makeEntry('m2b.jpg', 3, '2025-02-02T10:00:00Z')
    const photos = [m1a, m1b, m2a, m2b]

    mockUsePhotos.mockReturnValue({
      photos,
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
    })
    mockUseClusteredPhotos.mockImplementation((currentPhotos) =>
      clusteredResult(currentPhotos, [
        [m1a.id, m1b.id],
        [m2a.id, m2b.id],
      ])
    )

    render(<PhotoUploadPage />)

    // Sanity: two distinct bordered cluster sections really did render.
    expect(document.querySelectorAll('section')).toHaveLength(2)

    // Select one member from cluster A and one member from cluster B --
    // a selection spanning two distinct real clusters.
    fireEvent.click(screen.getByAltText('m1a.jpg'))
    fireEvent.click(screen.getByAltText('m2a.jpg'))
    expect(screen.getByText('2 photos selected')).toBeDefined()

    const expectedLabelA = `Use ${quickPickFormatter.format(m1a.capturedAt)}`
    const expectedLabelB = `Use ${quickPickFormatter.format(m2a.capturedAt)}`

    // Both clusters' distinct timestamps appear -- the union, not either
    // cluster's alone.
    expect(screen.getByRole('button', { name: expectedLabelA })).toBeDefined()
    expect(screen.getByRole('button', { name: expectedLabelB })).toBeDefined()
  })
})

// U4: the zoom icon (components/PhotoCard.tsx) opens PhotoLightbox
// (components/PhotoLightbox.tsx, U3) for that specific card's photo.
// PhotoUploadPage owns the single zoomedPhotoId state and resolves it to an
// object URL/filename via photosById + getObjectUrl, exactly like every
// other photo lookup in this component.
describe('PhotoUploadPage — zoom lightbox (U4)', () => {
  function makeEntry(name: string, index: number) {
    const file = makeFile(name)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: new Date(`2025-0${index + 1}-01T10:00:00Z`),
      uploadIndex: index,
    }
  }

  function basePhotosReturn(photos: ReturnType<typeof makeEntry>[]) {
    return {
      photos,
      processFiles: vi.fn(),
      addPhotos: vi.fn(),
      reorderPhotos: vi.fn(),
      updatePhotoName: vi.fn(),
      updatePhotoTimestamp: vi.fn(),
      batchUpdateNames: vi.fn(),
      batchSetTimestamps: vi.fn(),
      removePhotos: vi.fn(),
    }
  }

  it('clicking a card\'s zoom icon opens the lightbox showing that exact photo (correct object URL and filename)', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    // Photos render in ascending capturedAt order -- a.jpg then b.jpg -- so
    // the second "Zoom photo" button in DOM order belongs to b.jpg.
    const zoomButtons = screen.getAllByRole('button', { name: 'Zoom photo' })
    expect(zoomButtons).toHaveLength(2)
    fireEvent.click(zoomButtons[1])

    const closeButton = screen.getByRole('button', { name: 'Close' })
    const overlay = closeButton.parentElement as HTMLElement
    const lightboxImg = overlay.querySelector('img')
    expect(lightboxImg?.getAttribute('alt')).toBe('b.jpg')
    expect(lightboxImg?.getAttribute('src')).toBe('blob:b.jpg')
  })

  it('closing the lightbox via its close button returns to the grid with no photo zoomed and restores focus to the zoom icon that opened it', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    const zoomButtons = screen.getAllByRole('button', { name: 'Zoom photo' })
    const bZoomButton = zoomButtons[1]
    // jsdom, unlike a real browser, doesn't move focus to a button merely
    // because it was clicked -- explicitly focusing it here reproduces the
    // real-browser precondition PhotoLightbox's own mount effect depends on
    // (it captures document.activeElement at mount time), exactly as U3's
    // own isolated focus-restore test does.
    bZoomButton.focus()
    expect(document.activeElement).toBe(bZoomButton)

    fireEvent.click(bZoomButton)

    const closeButton = screen.getByRole('button', { name: 'Close' })
    expect(document.activeElement).toBe(closeButton)

    fireEvent.click(closeButton)

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    // Grid is back, unaffected by the zoom/close round-trip.
    expect(screen.getByAltText('a.jpg')).toBeDefined()
    expect(screen.getByAltText('b.jpg')).toBeDefined()
    // Focus returned to the exact zoom icon that opened the lightbox -- the
    // integration proof that U3's focus-restore works end-to-end with a
    // real trigger element from the grid, not just PhotoLightbox's own
    // isolated fixture.
    expect(document.activeElement).toBe(bZoomButton)
  })

  it('the delete and zoom icons on the same card work independently -- deleting one photo does not open or affect the lightbox for another', () => {
    const removePhotosMock = vi.fn()
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUsePhotos.mockReturnValue({ ...basePhotosReturn(photos), removePhotos: removePhotosMock })

    render(<PhotoUploadPage />)

    const zoomButtons = screen.getAllByRole('button', { name: 'Zoom photo' })
    fireEvent.click(zoomButtons[1]) // zoom b.jpg
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined()

    const deleteButtons = screen.getAllByRole('button', { name: 'Delete photo' })
    fireEvent.click(deleteButtons[0]) // delete a.jpg while b.jpg is zoomed

    expect(removePhotosMock).toHaveBeenCalledWith([photos[0].id])
    // Lightbox is untouched by the unrelated delete click.
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined()
  })
})

// Persist-photo-session-indexeddb: PhotoUploadPage wires usePhotoPersistence
// (isRestoring/storageWarning/clearAllPersisted) alongside
// useGooglePhotosUpload's seedPhotoStates/notifyPhotoRemoved. Persistence
// itself (IndexedDB reads/writes) is entirely mocked out here and covered by
// hooks/usePhotoPersistence.test.ts -- these tests only prove PhotoUploadPage
// surfaces isRestoring/storageWarning in the UI, disables interactions while
// restoring, and calls the right functions from "Clear all" and the delete
// path.
describe('PhotoUploadPage — restore-from-persistence UI (KTD2)', () => {
  function makeEntry(name: string, index: number) {
    const file = makeFile(name)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: new Date(`2025-0${index + 1}-01T10:00:00Z`),
      uploadIndex: index,
      source: 'local' as const,
    }
  }

  function signIn() {
    mockUseGoogleAuth.mockReturnValue({
      accessToken: 'token-123',
      expiresAt: Date.now() + 60_000,
      accountEmail: 'user@example.com',
      isSignedIn: true,
      isExpiringSoon: false,
      signIn: vi.fn(),
      signOut: vi.fn(),
    })
  }

  it('while isRestoring is true: disables the file input, disables the Google Photos import button, and shows "Restoring your photos…"', () => {
    signIn()
    mockUsePhotoPersistence.mockReturnValue({
      isRestoring: true,
      storageWarning: null,
      clearAllPersisted: vi.fn(),
    })
    mockUsePhotos.mockReturnValue({
      photos: [makeEntry('a.jpg', 0)],
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
    })

    render(<PhotoUploadPage />)

    expect(screen.getByText('Restoring your photos…')).toBeDefined()

    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.disabled).toBe(true)

    const importButton = screen.getByRole('button', { name: 'Import from Google Photos' }) as HTMLButtonElement
    expect(importButton.disabled).toBe(true)
  })

  it('once isRestoring is false: the file input and import button are enabled and the restoring text is gone', () => {
    signIn()
    mockUsePhotoPersistence.mockReturnValue({
      isRestoring: false,
      storageWarning: null,
      clearAllPersisted: vi.fn(),
    })
    mockUsePhotos.mockReturnValue({
      photos: [],
      processFiles: vi.fn(),
      reorderPhotos: vi.fn(),
    })

    render(<PhotoUploadPage />)

    expect(screen.queryByText('Restoring your photos…')).toBeNull()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.disabled).toBe(false)
    const importButton = screen.getByRole('button', { name: 'Import from Google Photos' }) as HTMLButtonElement
    expect(importButton.disabled).toBe(false)
  })
})

describe('PhotoUploadPage — storage warning banner', () => {
  it('renders the storageWarning text when it is a non-null string', () => {
    mockUsePhotoPersistence.mockReturnValue({
      isRestoring: false,
      storageWarning: "Some photos couldn't be saved — your browser's storage may be full.",
      clearAllPersisted: vi.fn(),
    })
    mockUsePhotos.mockReturnValue({ photos: [], processFiles: vi.fn(), reorderPhotos: vi.fn() })

    render(<PhotoUploadPage />)

    expect(
      screen.getByText("Some photos couldn't be saved — your browser's storage may be full.")
    ).toBeDefined()
  })

  it('renders nothing when storageWarning is null', () => {
    mockUsePhotoPersistence.mockReturnValue({
      isRestoring: false,
      storageWarning: null,
      clearAllPersisted: vi.fn(),
    })
    mockUsePhotos.mockReturnValue({ photos: [], processFiles: vi.fn(), reorderPhotos: vi.fn() })

    render(<PhotoUploadPage />)

    expect(screen.queryByText(/couldn't be saved/)).toBeNull()
  })
})

describe('PhotoUploadPage — Clear all (comprehensive reset)', () => {
  function makeEntry(name: string, index: number) {
    const file = makeFile(name)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: new Date(`2025-0${index + 1}-01T10:00:00Z`),
      uploadIndex: index,
      source: 'local' as const,
    }
  }

  function basePhotosReturn(photos: ReturnType<typeof makeEntry>[], removePhotos = vi.fn()) {
    return {
      photos,
      processFiles: vi.fn(),
      addPhotos: vi.fn(),
      reorderPhotos: vi.fn(),
      updatePhotoName: vi.fn(),
      updatePhotoTimestamp: vi.fn(),
      batchUpdateNames: vi.fn(),
      batchSetTimestamps: vi.fn(),
      removePhotos,
    }
  }

  it('confirmed: releases every object URL, calls notifyPhotoRemoved for every id, removePhotos with every id, clearAllPersisted, reset, and clears selection', async () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1), makeEntry('c.jpg', 2)]
    const removePhotosMock = vi.fn()
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos, removePhotosMock))

    const releaseObjectUrlMock = vi.fn()
    mockUseObjectUrls.mockReturnValue({
      getObjectUrl: (file: File) => `blob:${file.name}`,
      releaseObjectUrl: releaseObjectUrlMock,
    })

    const clearAllPersistedMock = vi.fn().mockResolvedValue(undefined)
    mockUsePhotoPersistence.mockReturnValue({
      isRestoring: false,
      storageWarning: null,
      clearAllPersisted: clearAllPersistedMock,
    })

    const resetMock = vi.fn()
    const notifyPhotoRemovedMock = vi.fn()
    mockUseGooglePhotosUpload.mockReturnValue({
      uploadState: 'idle',
      photoStates: new Map(),
      startUpload: vi.fn(),
      retryFailed: vi.fn(),
      reset: resetMock,
      seedPhotoStates: vi.fn(),
      notifyPhotoRemoved: notifyPhotoRemovedMock,
    })

    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PhotoUploadPage />)

    // Select a photo first, to prove Clear all also empties selectedIds.
    fireEvent.click(screen.getByAltText('a.jpg'))
    expect(screen.getByText('1 photo selected')).toBeDefined()

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))

    expect(window.confirm).toHaveBeenCalledWith('Clear all photos? This cannot be undone.')

    expect(releaseObjectUrlMock).toHaveBeenCalledWith(photos[0].file)
    expect(releaseObjectUrlMock).toHaveBeenCalledWith(photos[1].file)
    expect(releaseObjectUrlMock).toHaveBeenCalledWith(photos[2].file)
    expect(releaseObjectUrlMock).toHaveBeenCalledTimes(3)

    // Clear all funnels through the same notifyPhotoRemoved path a regular
    // delete uses (KTD9/KTD13), for every photo id.
    expect(notifyPhotoRemovedMock).toHaveBeenCalledWith(photos[0].id)
    expect(notifyPhotoRemovedMock).toHaveBeenCalledWith(photos[1].id)
    expect(notifyPhotoRemovedMock).toHaveBeenCalledWith(photos[2].id)
    expect(notifyPhotoRemovedMock).toHaveBeenCalledTimes(3)

    expect(removePhotosMock).toHaveBeenCalledOnce()
    const removedIds = removePhotosMock.mock.calls[0][0] as string[]
    expect(new Set(removedIds)).toEqual(new Set(photos.map((p) => p.id)))

    await waitFor(() => expect(clearAllPersistedMock).toHaveBeenCalledOnce())
    expect(resetMock).toHaveBeenCalledOnce()
  })

  it('not confirmed: calls none of releaseObjectUrl, notifyPhotoRemoved, removePhotos, clearAllPersisted, or reset', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    const removePhotosMock = vi.fn()
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos, removePhotosMock))

    const releaseObjectUrlMock = vi.fn()
    mockUseObjectUrls.mockReturnValue({
      getObjectUrl: (file: File) => `blob:${file.name}`,
      releaseObjectUrl: releaseObjectUrlMock,
    })

    const clearAllPersistedMock = vi.fn().mockResolvedValue(undefined)
    mockUsePhotoPersistence.mockReturnValue({
      isRestoring: false,
      storageWarning: null,
      clearAllPersisted: clearAllPersistedMock,
    })

    const resetMock = vi.fn()
    const notifyPhotoRemovedMock = vi.fn()
    mockUseGooglePhotosUpload.mockReturnValue({
      uploadState: 'idle',
      photoStates: new Map(),
      startUpload: vi.fn(),
      retryFailed: vi.fn(),
      reset: resetMock,
      seedPhotoStates: vi.fn(),
      notifyPhotoRemoved: notifyPhotoRemovedMock,
    })

    vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<PhotoUploadPage />)

    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))

    expect(window.confirm).toHaveBeenCalledWith('Clear all photos? This cannot be undone.')
    expect(releaseObjectUrlMock).not.toHaveBeenCalled()
    expect(notifyPhotoRemovedMock).not.toHaveBeenCalled()
    expect(removePhotosMock).not.toHaveBeenCalled()
    expect(clearAllPersistedMock).not.toHaveBeenCalled()
    expect(resetMock).not.toHaveBeenCalled()
  })

  it('is disabled while isRestoring is true', () => {
    mockUsePhotoPersistence.mockReturnValue({
      isRestoring: true,
      storageWarning: null,
      clearAllPersisted: vi.fn(),
    })
    const photos = [makeEntry('a.jpg', 0)]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    const clearAllButton = screen.getByRole('button', { name: 'Clear all' }) as HTMLButtonElement
    expect(clearAllButton.disabled).toBe(true)
  })
})

describe('PhotoUploadPage — notifyPhotoRemoved wiring on delete', () => {
  function makeEntry(name: string, index: number) {
    const file = makeFile(name)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: new Date(`2025-0${index + 1}-01T10:00:00Z`),
      uploadIndex: index,
      source: 'local' as const,
    }
  }

  function basePhotosReturn(photos: ReturnType<typeof makeEntry>[], removePhotos = vi.fn()) {
    return {
      photos,
      processFiles: vi.fn(),
      addPhotos: vi.fn(),
      reorderPhotos: vi.fn(),
      updatePhotoName: vi.fn(),
      updatePhotoTimestamp: vi.fn(),
      batchUpdateNames: vi.fn(),
      batchSetTimestamps: vi.fn(),
      removePhotos,
    }
  }

  it('deleting a photo releases its object URL (regression) and also calls notifyPhotoRemoved with its id', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    const releaseObjectUrlMock = vi.fn()
    mockUseObjectUrls.mockReturnValue({
      getObjectUrl: (file: File) => `blob:${file.name}`,
      releaseObjectUrl: releaseObjectUrlMock,
    })

    const notifyPhotoRemovedMock = vi.fn()
    mockUseGooglePhotosUpload.mockReturnValue({
      uploadState: 'idle',
      photoStates: new Map(),
      startUpload: vi.fn(),
      retryFailed: vi.fn(),
      reset: vi.fn(),
      seedPhotoStates: vi.fn(),
      notifyPhotoRemoved: notifyPhotoRemovedMock,
    })

    render(<PhotoUploadPage />)

    fireEvent.click(screen.getByAltText('a.jpg'))
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))

    expect(releaseObjectUrlMock).toHaveBeenCalledWith(photos[0].file)
    expect(notifyPhotoRemovedMock).toHaveBeenCalledWith(photos[0].id)
    expect(notifyPhotoRemovedMock).toHaveBeenCalledOnce()
  })
})

// KTD-lightbox-nav-delete: PhotoUploadPage now derives the zoomed photo's
// prev/next neighbors from the TRUE visual order (`visualOrder` state, kept
// in sync with `visualOrderRef` via PhotoGrid's `onVisualOrderChange`), not
// the flat, purely-chronological `photos` array -- the exact same
// visual-order-vs-flat-array risk shape as `handleDragEnd`'s existing P0 fix
// (see docs/solutions/logic-errors/cluster-drag-timestamp-visual-order-
// divergence.md). PhotoLightbox itself is real (not mocked) in this file, so
// these interact with its actual "Previous photo"/"Next photo"/"Delete
// photo" controls, which only render when the corresponding prop is defined.
describe('PhotoUploadPage — lightbox navigation and delete-and-advance', () => {
  function makeDatedEntry(name: string, index: number, capturedAt: string) {
    const file = makeFile(name)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: new Date(capturedAt),
      uploadIndex: index,
    }
  }

  function basePhotosReturn(
    photos: ReturnType<typeof makeDatedEntry>[],
    overrides: Record<string, unknown> = {}
  ) {
    return {
      photos,
      processFiles: vi.fn(),
      addPhotos: vi.fn(),
      reorderPhotos: vi.fn(),
      updatePhotoName: vi.fn(),
      updatePhotoTimestamp: vi.fn(),
      batchUpdateNames: vi.fn(),
      batchSetTimestamps: vi.fn(),
      removePhotos: vi.fn(),
      ...overrides,
    }
  }

  /** Clicks the zoom icon on the card whose <img alt> is `name` -- robust to DOM order, unlike indexing getAllByRole. */
  function zoomOn(name: string) {
    const img = screen.getByAltText(name)
    const cardImageContainer = img.parentElement as HTMLElement
    fireEvent.click(within(cardImageContainer).getByRole('button', { name: 'Zoom photo' }))
  }

  /** The lightbox's own root -- the Close button's parent -- scoped so queries don't also match the (inert) grid underneath. */
  function lightboxOverlay(): HTMLElement {
    return screen.getByRole('button', { name: 'Close' }).parentElement as HTMLElement
  }

  function lightboxImgAlt(): string | null {
    return within(lightboxOverlay()).getByRole('img').getAttribute('alt')
  }

  it('REGRESSION: resolves prev/next neighbors from the true visual order, not flat-array indexOf, when the two diverge', () => {
    // Flat `photos` array order: A, B, C. But the mocked useClusteredPhotos
    // below reports a visualOrder of B, A, C -- simulating a cluster/render
    // reordering, exactly the divergence class documented in
    // docs/solutions/logic-errors/cluster-drag-timestamp-visual-order-divergence.md.
    const a = makeDatedEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeDatedEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
    const c = makeDatedEntry('c.jpg', 2, '2025-01-03T00:00:00Z')
    const photos = [a, b, c]

    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))
    mockUseClusteredPhotos.mockImplementation((currentPhotos) =>
      clusteredResult(currentPhotos, [[b.id], [a.id], [c.id]])
    )

    render(<PhotoUploadPage />)

    // Open on a.jpg, which sits at flat-array index 0 (no prev, next = b)
    // but at visualOrder index 1 (prev = b, next = c).
    zoomOn('a.jpg')

    // Positive: the true visual prev (b) is reachable, proving prevId isn't
    // the flat-array-derived `undefined` a flat-array-indexOf computation
    // would have produced for index 0.
    fireEvent.click(within(lightboxOverlay()).getByRole('button', { name: 'Previous photo' }))
    expect(lightboxImgAlt()).toBe('b.jpg')

    // Close, reopen on a.jpg, and check Next this time.
    fireEvent.click(within(lightboxOverlay()).getByRole('button', { name: 'Close' }))
    zoomOn('a.jpg')
    fireEvent.click(within(lightboxOverlay()).getByRole('button', { name: 'Next photo' }))

    // Positive: true visual next is c.
    expect(lightboxImgAlt()).toBe('c.jpg')
    // Negative: NOT b -- the flat-array-indexOf answer (photos[0 + 1] = b)
    // that the pre-fix bug class would have produced. Asserting the negative
    // is what turns this into a real regression guard per the documented
    // solution's recommended test shape.
    expect(lightboxImgAlt()).not.toBe('b.jpg')
  })

  it('opening on the first/last photo in visualOrder (not the flat array) yields only one defined neighbor', () => {
    // Same B, A, C divergent visualOrder as the regression test above.
    const a = makeDatedEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeDatedEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
    const c = makeDatedEntry('c.jpg', 2, '2025-01-03T00:00:00Z')
    const photos = [a, b, c]

    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))
    mockUseClusteredPhotos.mockImplementation((currentPhotos) =>
      clusteredResult(currentPhotos, [[b.id], [a.id], [c.id]])
    )

    render(<PhotoUploadPage />)

    // b.jpg is first in visualOrder [B, A, C] -- even though it's NOT first
    // in the flat array (that's a) -- so Previous must be absent, Next present.
    zoomOn('b.jpg')
    expect(within(lightboxOverlay()).queryByRole('button', { name: 'Previous photo' })).toBeNull()
    expect(within(lightboxOverlay()).getByRole('button', { name: 'Next photo' })).toBeDefined()
    fireEvent.click(within(lightboxOverlay()).getByRole('button', { name: 'Close' }))

    // c.jpg is last in visualOrder (and also last in the flat array here) --
    // Next must be absent, Previous present.
    zoomOn('c.jpg')
    expect(within(lightboxOverlay()).queryByRole('button', { name: 'Next photo' })).toBeNull()
    expect(within(lightboxOverlay()).getByRole('button', { name: 'Previous photo' })).toBeDefined()
  })

  it('deleting the current photo with a next neighbor advances the lightbox to it, and still reuses handleDeletePhoto\'s existing side effects (object URL release, notifyPhotoRemoved, selectedIds pruning)', () => {
    const a = makeDatedEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeDatedEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
    const c = makeDatedEntry('c.jpg', 2, '2025-01-03T00:00:00Z')
    const photos = [a, b, c]
    const removePhotosMock = vi.fn()
    const notifyPhotoRemovedMock = vi.fn()
    const releaseObjectUrlMock = vi.fn()

    mockUsePhotos.mockReturnValue(basePhotosReturn(photos, { removePhotos: removePhotosMock }))
    mockUseObjectUrls.mockReturnValue({
      getObjectUrl: (file: File) => `blob:${file.name}`,
      releaseObjectUrl: releaseObjectUrlMock,
    })
    mockUseGooglePhotosUpload.mockReturnValue({
      uploadState: 'idle',
      photoStates: new Map(),
      startUpload: vi.fn(),
      retryFailed: vi.fn(),
      reset: vi.fn(),
      seedPhotoStates: vi.fn(),
      notifyPhotoRemoved: notifyPhotoRemovedMock,
    })

    render(<PhotoUploadPage />)

    // Select b first, to prove the delete-through-lightbox path prunes
    // selectedIds exactly like the existing per-card/batch delete paths do.
    fireEvent.click(screen.getByAltText('b.jpg'))
    expect(screen.getByText('1 photo selected')).toBeDefined()

    zoomOn('b.jpg') // middle photo in flat/visual order here -- next = c
    fireEvent.click(within(lightboxOverlay()).getByRole('button', { name: 'Delete photo' }))

    // Existing handleDeletePhoto -> handleBatchDelete side effects, reused unchanged.
    expect(removePhotosMock).toHaveBeenCalledWith([b.id])
    expect(releaseObjectUrlMock).toHaveBeenCalledWith(b.file)
    expect(notifyPhotoRemovedMock).toHaveBeenCalledWith(b.id)
    expect(screen.queryByText(/photo selected/)).toBeNull()

    // Lightbox stayed open, advanced to c (the next neighbor).
    expect(lightboxImgAlt()).toBe('c.jpg')
  })

  it('deleting the last-in-visualOrder photo (only a prev neighbor) advances the lightbox to prev', () => {
    const a = makeDatedEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeDatedEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
    const c = makeDatedEntry('c.jpg', 2, '2025-01-03T00:00:00Z')
    const photos = [a, b, c]

    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    zoomOn('c.jpg') // last in visual order -- no next, prev = b
    fireEvent.click(within(lightboxOverlay()).getByRole('button', { name: 'Delete photo' }))

    expect(lightboxImgAlt()).toBe('b.jpg')
  })

  it('deleting the only remaining photo in visualOrder closes the lightbox', () => {
    const a = makeDatedEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const photos = [a]

    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    zoomOn('a.jpg')
    expect(screen.getByRole('button', { name: 'Close' })).toBeDefined()

    fireEvent.click(within(lightboxOverlay()).getByRole('button', { name: 'Delete photo' }))

    // zoomedPhotoId became null -- zoomedPhoto resolves to null, so the
    // lightbox no longer renders at all.
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })

  it("the lightbox's onTimestampChange calls updatePhotoTimestamp with the zoomed photo's id", () => {
    const a = makeDatedEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeDatedEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
    const photos = [a, b]
    const updatePhotoTimestampMock = vi.fn()

    mockUsePhotos.mockReturnValue(
      basePhotosReturn(photos, { updatePhotoTimestamp: updatePhotoTimestampMock })
    )

    render(<PhotoUploadPage />)

    zoomOn('b.jpg')

    fireEvent.click(within(lightboxOverlay()).getByTitle('Click to edit date'))
    const input = within(lightboxOverlay()).getByDisplayValue('2025-01-02T00:00')
    fireEvent.change(input, { target: { value: '2025-06-15T12:30' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(updatePhotoTimestampMock).toHaveBeenCalledWith(b.id, expect.any(Date))
    const calledId = updatePhotoTimestampMock.mock.calls[0][0]
    expect(calledId).toBe(b.id)
  })
})

// U2: "Download all" now builds a single ZIP client-side via
// `buildPhotoZipBlob`/`triggerDownload` (lib/download.ts, U1) instead of the
// old (now-deleted) per-photo `downloadAll` loop. These scenarios cover
// KTD2/KTD9 (entry order), KTD3 (filename derivation), KTD6 (progress UI/
// disabled state), KTD7 (failure handling), and KTD10 (no other control gets
// locked during a build).
describe('PhotoUploadPage — Download all (ZIP build, U2)', () => {
  function makeEntry(
    name: string,
    index: number,
    capturedAt: string,
    overrides: Partial<PhotoEntry> = {}
  ): PhotoEntry {
    const file = makeFile(name)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: new Date(capturedAt),
      uploadIndex: index,
      source: 'local',
      ...overrides,
    }
  }

  function basePhotosReturn(photos: PhotoEntry[]) {
    return {
      photos,
      processFiles: vi.fn(),
      addPhotos: vi.fn(),
      reorderPhotos: vi.fn(),
      updatePhotoName: vi.fn(),
      updatePhotoTimestamp: vi.fn(),
      batchUpdateNames: vi.fn(),
      batchSetTimestamps: vi.fn(),
      removePhotos: vi.fn(),
    }
  }

  function signIn() {
    mockUseGoogleAuth.mockReturnValue({
      accessToken: 'token-123',
      expiresAt: Date.now() + 60_000,
      accountEmail: 'user@example.com',
      isSignedIn: true,
      isExpiringSoon: false,
      signIn: vi.fn(),
      signOut: vi.fn(),
    })
  }

  function downloadAllButton() {
    return screen.getByRole('button', { name: 'Download all' }) as HTMLButtonElement
  }

  beforeEach(() => {
    mockBuildPhotoZipBlob.mockReset()
    mockTriggerDownload.mockReset()
    mockBuildPhotoZipBlob.mockResolvedValue(new Blob(['zip']))
  })

  it('builds the ZIP from visualOrder-ordered entries, not the flat photos array order', async () => {
    // Same non-contiguous-cluster divergence fixture as the "P0" drag tests
    // above: flat `photos` is [a, b, c], but a/c cluster together so the
    // true visual order is [a, c, b].
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
    const c = makeEntry('c.jpg', 2, '2025-01-03T00:00:00Z')
    const photos = [a, b, c]

    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))
    mockUseClusteredPhotos.mockImplementation((currentPhotos) =>
      clusteredResult(currentPhotos, [[a.id, c.id], [b.id]])
    )

    render(<PhotoUploadPage />)
    // Sanity: visual order really is a, c, b (diverging from flat [a, b, c]).
    const imgs = screen.getAllByRole('img').map((img) => (img as HTMLImageElement).alt)
    expect(imgs).toEqual(['a.jpg', 'c.jpg', 'b.jpg'])

    fireEvent.click(downloadAllButton())

    await waitFor(() => expect(mockBuildPhotoZipBlob).toHaveBeenCalledOnce())
    const [entries] = mockBuildPhotoZipBlob.mock.calls[0]
    expect(entries.map((e) => e.id)).toEqual([a.id, c.id, b.id])
  })

  it('KTD9: a photo present in photosById but missing from visualOrder (pending re-cluster) is still included, appended in uploadIndex order', async () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeEntry('b.jpg', 1, '2025-01-02T00:00:00Z') // simulates a photo added after the last recluster resolved
    const c = makeEntry('c.jpg', 2, '2025-01-03T00:00:00Z')
    const photos = [a, b, c]

    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))
    // useClusteredPhotos' own visualOrder omits b entirely -- b is present in
    // `photos`/PhotoUploadPage's own photosById map regardless.
    mockUseClusteredPhotos.mockImplementation((currentPhotos) =>
      clusteredResult(currentPhotos, [[a.id], [c.id]], { visualOrder: [a.id, c.id] })
    )

    render(<PhotoUploadPage />)

    fireEvent.click(downloadAllButton())

    await waitFor(() => expect(mockBuildPhotoZipBlob).toHaveBeenCalledOnce())
    const [entries] = mockBuildPhotoZipBlob.mock.calls[0]
    // a, c from visualOrder, then b appended afterward (its only ordering
    // signal left is uploadIndex, since it isn't in visualOrder at all).
    expect(entries.map((e) => e.id)).toEqual([a.id, c.id, b.id])
  })

  it('passes each entry\'s current (edited) filename and capturedAt, not any original value', async () => {
    // Simulates a photo that's been renamed and had its timestamp edited
    // since upload -- `photos` (and therefore photosById) already reflects
    // those edits, exactly as the real usePhotos state would after
    // updatePhotoName/updatePhotoTimestamp.
    const edited = makeEntry('original-name.jpg', 0, '2025-01-01T00:00:00Z', {
      filename: 'renamed-by-user.jpg',
      capturedAt: new Date('2025-06-15T12:00:00Z'),
    })
    const photos = [edited]

    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    fireEvent.click(downloadAllButton())

    await waitFor(() => expect(mockBuildPhotoZipBlob).toHaveBeenCalledOnce())
    const [entries] = mockBuildPhotoZipBlob.mock.calls[0]
    expect(entries).toHaveLength(1)
    expect(entries[0].filename).toBe('renamed-by-user.jpg')
    expect(entries[0].capturedAt).toEqual(new Date('2025-06-15T12:00:00Z'))
  })

  it('KTD3: uses the trimmed, sanitized albumName as the ZIP filename, replacing filesystem-unsafe characters', async () => {
    signIn()
    const photos = [makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    fireEvent.change(screen.getByPlaceholderText('Album name'), {
      target: { value: '  Trip/2024: Summer  ' },
    })

    fireEvent.click(downloadAllButton())

    await waitFor(() => expect(mockTriggerDownload).toHaveBeenCalledOnce())
    const [, filename] = mockTriggerDownload.mock.calls[0]
    expect(filename).toBe('Trip-2024- Summer.zip')
  })

  it('KTD3: falls back to photo-tidy-export-<today, YYYY-MM-DD>.zip when albumName is empty or whitespace-only', async () => {
    signIn()
    const photos = [makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    // albumName defaults to '' -- leave it untouched, then confirm
    // whitespace-only is treated the same way.
    fireEvent.click(downloadAllButton())
    await waitFor(() => expect(mockTriggerDownload).toHaveBeenCalledOnce())

    const today = new Date().toISOString().slice(0, 10)
    const [, firstFilename] = mockTriggerDownload.mock.calls[0]
    expect(firstFilename).toBe(`photo-tidy-export-${today}.zip`)

    fireEvent.change(screen.getByPlaceholderText('Album name'), { target: { value: '   ' } })
    fireEvent.click(downloadAllButton())
    await waitFor(() => expect(mockTriggerDownload).toHaveBeenCalledTimes(2))
    const [, secondFilename] = mockTriggerDownload.mock.calls[1]
    expect(secondFilename).toBe(`photo-tidy-export-${today}.zip`)
  })

  it('KTD6: disables the button and shows a progress count while generating, both clearing once the download triggers', async () => {
    const photos = [
      makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z'),
      makeEntry('b.jpg', 1, '2025-01-02T00:00:00Z'),
    ]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    let resolveBuild: (blob: Blob) => void
    const pending = new Promise<Blob>((resolve) => {
      resolveBuild = resolve
    })
    mockBuildPhotoZipBlob.mockImplementation((entries, onProgress) => {
      onProgress?.(1, entries.length)
      return pending
    })

    render(<PhotoUploadPage />)

    expect(downloadAllButton().disabled).toBe(false)
    fireEvent.click(downloadAllButton())

    await waitFor(() => expect(screen.getByText('Zipping 1 of 2…')).toBeDefined())
    expect(downloadAllButton().disabled).toBe(true)

    await act(async () => {
      resolveBuild(new Blob(['zip']))
      await pending
    })

    await waitFor(() => expect(mockTriggerDownload).toHaveBeenCalledOnce())
    expect(screen.queryByText(/Zipping/)).toBeNull()
    expect(downloadAllButton().disabled).toBe(false)
  })

  it('disables the button while isRestoring is true, matching "Clear all"', () => {
    mockUsePhotoPersistence.mockReturnValue({
      isRestoring: true,
      storageWarning: null,
      clearAllPersisted: vi.fn(),
    })
    const photos = [makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    expect(downloadAllButton().disabled).toBe(true)
  })

  it('KTD7: a rejected ZIP build (including one entry\'s writeTimestamp throwing mid-batch) shows a dismissible warning and re-enables the button, instead of throwing uncaught or failing silently', async () => {
    const photos = [makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))
    mockBuildPhotoZipBlob.mockRejectedValue(new Error('writeTimestamp failed'))

    render(<PhotoUploadPage />)

    fireEvent.click(downloadAllButton())
    await waitFor(() => expect(screen.getByText("Couldn't build the ZIP — try again.")).toBeDefined())

    // No partial ZIP is ever handed off for download.
    expect(mockTriggerDownload).not.toHaveBeenCalled()
    // Button re-enabled, not stuck disabled.
    expect(downloadAllButton().disabled).toBe(false)

    // Dismissible.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText("Couldn't build the ZIP — try again.")).toBeNull()
  })

  it('KTD10: photo edits (rename, delete, reorder controls) are not locked while a ZIP build is in progress -- only "Download all" itself is disabled', async () => {
    const photos = [
      makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z'),
      makeEntry('b.jpg', 1, '2025-01-02T00:00:00Z'),
    ]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    let resolveBuild: (blob: Blob) => void
    const pending = new Promise<Blob>((resolve) => {
      resolveBuild = resolve
    })
    mockBuildPhotoZipBlob.mockImplementation(() => pending)

    render(<PhotoUploadPage />)

    fireEvent.click(downloadAllButton())
    await waitFor(() => expect(downloadAllButton().disabled).toBe(true))

    // "Clear all" and per-card delete stay enabled/clickable during the build.
    const clearAllButton = screen.getByRole('button', { name: 'Clear all' }) as HTMLButtonElement
    expect(clearAllButton.disabled).toBe(false)
    expect(screen.getAllByRole('button', { name: 'Delete photo' })).toHaveLength(2)

    await act(async () => {
      resolveBuild(new Blob(['zip']))
      await pending
    })
  })

  // P1 fix (adversarial reviewer): the button-row block (and, independently,
  // the zipWarning banner itself) must not be hidden by the zero-photos
  // render gate just because the last photo was deleted -- or "Clear all"
  // was clicked -- while a build was still in flight. Without that fix, a
  // build's rejection after photos.length has dropped to 0 would call
  // setZipWarning into a banner that no longer renders, silently
  // contradicting handleDownloadAll's own KTD7 "never a silent no-op"
  // guarantee.
  it('P1: deleting the last remaining photo (Clear all) while a ZIP build is in flight still shows the warning banner once the build rejects, even though photos.length has dropped to 0', async () => {
    const photo = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    let currentPhotos: PhotoEntry[] = [photo]
    const removePhotosMock = vi.fn((ids: string[]) => {
      const idSet = new Set(ids)
      currentPhotos = currentPhotos.filter((p) => !idSet.has(p.id))
    })
    mockUsePhotos.mockImplementation(() => ({
      ...basePhotosReturn(currentPhotos),
      removePhotos: removePhotosMock,
    }))
    mockUsePhotoPersistence.mockReturnValue({
      isRestoring: false,
      storageWarning: null,
      clearAllPersisted: vi.fn().mockResolvedValue(undefined),
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    let capturedReject: (err: Error) => void = () => {}
    const pending = new Promise<Blob>((_resolve, reject) => {
      capturedReject = reject
    })
    mockBuildPhotoZipBlob.mockImplementation(() => pending)

    render(<PhotoUploadPage />)

    fireEvent.click(downloadAllButton())
    await waitFor(() => expect(mockBuildPhotoZipBlob).toHaveBeenCalledOnce())

    // Delete the only photo via "Clear all" while the build is still
    // pending -- photos.length drops to 0 before buildPhotoZipBlob's
    // promise ever settles.
    fireEvent.click(screen.getByRole('button', { name: 'Clear all' }))
    await waitFor(() => expect(screen.queryAllByRole('img')).toHaveLength(0))
    expect(removePhotosMock).toHaveBeenCalledWith([photo.id])

    // Now let the in-flight build reject.
    await act(async () => {
      capturedReject(new Error('boom'))
      await pending.catch(() => {})
    })

    // The warning banner still renders, despite photos.length being 0.
    expect(screen.getByText("Couldn't build the ZIP — try again.")).toBeDefined()
  })
})

// U2: copy-mode state (`copySourceId`), the "Copy timestamp" entry control,
// and the always-visible-while-active status banner (highlighted source,
// copied timestamp, Esc/Done exit). `copySourceId` lives here as an
// independent sibling of `selectedIds`/`zoomedPhotoId` (KTD1) -- these tests
// prove that independence directly (selection changes don't touch it), and
// that `isCopyModeActive`'s live derivation from `photosById` (rather than a
// snapshotted Date) makes source-deletion cleanup automatic (R4) with no
// separate invalidation call.
describe('PhotoUploadPage — copy-mode (U2)', () => {
  function makeEntry(name: string, index: number, capturedAt: string | null): PhotoEntry {
    const file = makeFile(name)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: capturedAt ? new Date(capturedAt) : null,
      uploadIndex: index,
      source: 'local',
    }
  }

  function basePhotosReturn(photos: PhotoEntry[]) {
    return {
      photos,
      processFiles: vi.fn(),
      addPhotos: vi.fn(),
      reorderPhotos: vi.fn(),
      updatePhotoName: vi.fn(),
      updatePhotoTimestamp: vi.fn(),
      batchUpdateNames: vi.fn(),
      batchSetTimestamps: vi.fn(),
      setPhotosTimestamp: vi.fn(),
      removePhotos: vi.fn(),
    }
  }

  /** Mirrors the "batch delete" describe's own helper above -- a mutable
   * photo list so that removePhotos (driven through the real per-card
   * delete icon) is reflected on the next render, exactly like the real
   * hook. */
  function makeStatefulPhotosMock(initialPhotos: PhotoEntry[]) {
    let current = initialPhotos
    const removePhotosMock = vi.fn((ids: string[]) => {
      const idSet = new Set(ids)
      current = current.filter((p) => !idSet.has(p.id))
    })
    mockUsePhotos.mockImplementation(() => ({ ...basePhotosReturn(current), removePhotos: removePhotosMock }))
    return removePhotosMock
  }

  function enterCopyMode(altText: string) {
    fireEvent.click(screen.getByAltText(altText))
    fireEvent.click(screen.getByRole('button', { name: 'Copy timestamp' }))
  }

  it('R1: "Copy timestamp" appears only when exactly one photo with a non-null capturedAt is selected', () => {
    const dated = makeEntry('a.jpg', 0, '2025-01-01T10:00:00Z')
    const undated = makeEntry('b.jpg', 1, null)
    mockUsePhotos.mockReturnValue(basePhotosReturn([dated, undated]))

    render(<PhotoUploadPage />)

    // Zero selected.
    expect(screen.queryByRole('button', { name: 'Copy timestamp' })).toBeNull()

    // One selected, with a timestamp: shown.
    fireEvent.click(screen.getByAltText('a.jpg'))
    expect(screen.getByRole('button', { name: 'Copy timestamp' })).toBeDefined()

    // Two selected: hidden again.
    fireEvent.click(screen.getByAltText('b.jpg'))
    expect(screen.getByText('2 photos selected')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Copy timestamp' })).toBeNull()

    // Deselect the dated one, leaving only the undated photo selected: hidden.
    fireEvent.click(screen.getByAltText('a.jpg'))
    expect(screen.getByText('1 photo selected')).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Copy timestamp' })).toBeNull()
  })

  it('clicking "Copy timestamp" enters copy mode and shows the banner with the source photo\'s filename and timestamp', () => {
    const a = makeEntry('a.jpg', 0, '2025-06-15T08:30:00Z')
    const b = makeEntry('b.jpg', 1, '2025-01-01T00:00:00Z')
    mockUsePhotos.mockReturnValue(basePhotosReturn([a, b]))

    render(<PhotoUploadPage />)

    enterCopyMode('a.jpg')

    const doneButton = screen.getByRole('button', { name: 'Done' })
    const banner = doneButton.parentElement as HTMLElement
    expect(banner.textContent).toContain('a.jpg')
    expect(banner.textContent).toContain(formatDate(a.capturedAt as Date))
  })

  it("changing the selection while copy mode is active does not end copy mode -- copySourceId is untouched by selectedIds changes", () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
    mockUsePhotos.mockReturnValue(basePhotosReturn([a, b]))

    render(<PhotoUploadPage />)

    enterCopyMode('a.jpg')
    let banner = screen.getByRole('button', { name: 'Done' }).parentElement as HTMLElement
    expect(banner.textContent).toContain('a.jpg')

    // Select a different photo entirely (deselect a, select b) -- the
    // banner still names a.jpg as the copy source, untouched.
    fireEvent.click(screen.getByAltText('a.jpg'))
    fireEvent.click(screen.getByAltText('b.jpg'))
    expect(screen.getByText('1 photo selected')).toBeDefined()
    banner = screen.getByRole('button', { name: 'Done' }).parentElement as HTMLElement
    expect(banner.textContent).toContain('a.jpg')

    // Clear the selection entirely -- copy mode still active.
    fireEvent.click(screen.getByAltText('b.jpg'))
    expect(screen.queryByText(/photos? selected/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()
  })

  it('pressing Escape while copy mode is active exits it', () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    mockUsePhotos.mockReturnValue(basePhotosReturn([a]))

    render(<PhotoUploadPage />)

    enterCopyMode('a.jpg')
    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  })

  it('clicking "Done" exits copy mode', () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    mockUsePhotos.mockReturnValue(basePhotosReturn([a]))

    render(<PhotoUploadPage />)

    enterCopyMode('a.jpg')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))

    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  })

  it('clicking the copy-timestamp icon again on the source photo toggles copy mode off', () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    mockUsePhotos.mockReturnValue(basePhotosReturn([a]))

    render(<PhotoUploadPage />)

    enterCopyMode('a.jpg')
    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()

    // a.jpg is still the sole selection (selecting doesn't touch copy mode,
    // KTD1), so its copy-timestamp button is still rendered -- click it
    // again instead of Esc/Done.
    fireEvent.click(screen.getByRole('button', { name: 'Copy timestamp' }))

    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  })

  it('clicking the copy-timestamp icon on a different sole-selected photo retargets copy mode instead of toggling it off', () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
    mockUsePhotos.mockReturnValue(basePhotosReturn([a, b]))

    render(<PhotoUploadPage />)

    enterCopyMode('a.jpg')
    let banner = screen.getByRole('button', { name: 'Done' }).parentElement as HTMLElement
    expect(banner.textContent).toContain('a.jpg')

    // Switch the selection to b.jpg alone, then click ITS copy-timestamp
    // button -- this retargets the source rather than toggling off, since
    // b.jpg (not a.jpg) is the one being clicked.
    fireEvent.click(screen.getByAltText('a.jpg'))
    fireEvent.click(screen.getByAltText('b.jpg'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy timestamp' }))

    banner = screen.getByRole('button', { name: 'Done' }).parentElement as HTMLElement
    expect(banner.textContent).toContain('b.jpg')
  })

  it('double-Esc: first Esc exits copy mode, second Esc (now that copy mode is gone) clears the selection', () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    mockUsePhotos.mockReturnValue(basePhotosReturn([a]))

    render(<PhotoUploadPage />)

    enterCopyMode('a.jpg')
    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()
    expect(screen.getByText('1 photo selected')).toBeDefined()

    // First Esc: exits copy mode, selection untouched.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
    expect(screen.getByText('1 photo selected')).toBeDefined()

    // Second Esc: copy mode is already gone, so this one clears the
    // selection instead.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByText(/photos? selected/)).toBeNull()
  })

  it('Esc clears the selection directly when copy mode was never entered', () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
    mockUsePhotos.mockReturnValue(basePhotosReturn([a, b]))

    render(<PhotoUploadPage />)

    fireEvent.click(screen.getByAltText('a.jpg'))
    fireEvent.click(screen.getByAltText('b.jpg'))
    expect(screen.getByText('2 photos selected')).toBeDefined()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByText(/photos? selected/)).toBeNull()
  })

  it('Esc does nothing when neither copy mode nor a selection is active', () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    mockUsePhotos.mockReturnValue(basePhotosReturn([a]))

    render(<PhotoUploadPage />)

    // Should not throw, and nothing observable changes.
    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.queryByText(/photos? selected/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  })

  it('R4: deleting the source photo while copy mode is active ends copy mode automatically, with no separate cleanup call', () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
    makeStatefulPhotosMock([a, b])

    render(<PhotoUploadPage />)

    enterCopyMode('a.jpg')
    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()

    // Delete a.jpg (the copy source) via its own per-card delete icon --
    // a is chronologically first, so it's the first "Delete photo" button.
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete photo' })
    fireEvent.click(deleteButtons[0])

    expect(screen.queryByAltText('a.jpg')).toBeNull()
    // Copy mode ended purely from `photosById.get(copySourceId)` resolving
    // to `undefined` on the next render (KTD1) -- nothing here explicitly
    // clears `copySourceId`.
    expect(screen.queryByRole('button', { name: 'Done' })).toBeNull()
  })

  // Regression test for the code-review-caught bug: a naive "always exit
  // copy mode on any document-level Escape" implementation would ALSO fire
  // here if PhotoCard.tsx's `cancelName`/`cancelTimestamp` Escape path only
  // called `preventDefault`. The fix has PhotoCard.tsx's Escape handlers
  // call `stopPropagation` too, so the keydown never bubbles past the input
  // to this component's document-level copy-mode Escape listener at all.
  it('Esc regression: a different card\'s in-progress inline edit wins over copy mode\'s own Escape handling', () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
    mockUsePhotos.mockReturnValue(basePhotosReturn([a, b]))

    render(<PhotoUploadPage />)

    enterCopyMode('a.jpg')
    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()

    // Start an inline rename edit on b.jpg -- a DIFFERENT card from the
    // copy source.
    fireEvent.click(screen.getByText('b.jpg'))
    const nameInput = screen.getByDisplayValue('b.jpg') as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: 'renamed.jpg' } })

    // Escape cancels the rename (PhotoCard's own handling) but must NOT
    // also exit copy mode.
    fireEvent.keyDown(nameInput, { key: 'Escape' })

    // The rename was cancelled: draft discarded, back to the display <p>.
    expect(screen.queryByDisplayValue('renamed.jpg')).toBeNull()
    expect(screen.getByText('b.jpg')).toBeDefined()

    // Copy mode is still active -- the actual regression assertion.
    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()
  })

  it('R8: no copy-mode prop or state reaches PhotoLightbox -- opening it while copy mode is active renders it exactly as normal', () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const b = makeEntry('b.jpg', 1, '2025-01-02T00:00:00Z')
    mockUsePhotos.mockReturnValue(basePhotosReturn([a, b]))

    render(<PhotoUploadPage />)

    enterCopyMode('a.jpg')
    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()

    // Now that copy mode is fully wired (U4), every non-source card swaps
    // its zoom slot for a paste button (KTD4 in PhotoCard.tsx) -- the copy
    // source itself is the only card that keeps a working "Zoom photo"
    // button while copy mode is active, so it's the only one this test can
    // use to open the lightbox.
    fireEvent.click(screen.getByRole('button', { name: 'Zoom photo' }))

    const closeButton = screen.getByRole('button', { name: 'Close' })
    const overlay = closeButton.parentElement as HTMLElement
    const lightboxImg = overlay.querySelector('img')
    expect(lightboxImg?.getAttribute('alt')).toBe('a.jpg')
    expect(lightboxImg?.getAttribute('src')).toBe('blob:a.jpg')

    // No copy-mode affordance leaks into the lightbox's own subtree.
    expect(within(overlay).queryByText(/copy/i)).toBeNull()
    expect(within(overlay).queryByText(/paste/i)).toBeNull()
  })

  it('KTD2: BatchEditPanel still renders (count, quick-pick, working delete) unaffected by copy mode being entered', () => {
    const a = makeEntry('a.jpg', 0, '2025-01-01T00:00:00Z')
    const removePhotosMock = vi.fn()
    mockUsePhotos.mockReturnValue({ ...basePhotosReturn([a]), removePhotos: removePhotosMock })

    render(<PhotoUploadPage />)

    fireEvent.click(screen.getByAltText('a.jpg'))
    expect(screen.getByText('1 photo selected')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDefined()

    // Entering copy mode should not touch BatchEditPanel at all.
    fireEvent.click(screen.getByRole('button', { name: 'Copy timestamp' }))
    expect(screen.getByRole('button', { name: 'Done' })).toBeDefined()

    expect(screen.getByText('1 photo selected')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Delete selected' })).toBeDefined()

    // Its onBatchDelete prop still works exactly as before.
    act(() => {
      capturedOnBatchDelete?.()
    })
    expect(removePhotosMock).toHaveBeenCalledWith([a.id])
  })

  // U4: end-to-end wiring -- clicking a paste control rendered by a real
  // PhotoCard inside the real (unmocked) PhotoGrid actually reaches
  // `setPhotosTimestamp`, not just that the props exist on PhotoGrid in
  // isolation (that's covered by PhotoGrid.test.tsx).
  it('U4: clicking a card\'s paste button calls setPhotosTimestamp with that photo\'s id and the copied date', () => {
    const a = makeEntry('a.jpg', 0, '2025-06-15T08:30:00Z')
    const b = makeEntry('b.jpg', 1, '2025-01-01T00:00:00Z')
    const setPhotosTimestampMock = vi.fn()
    mockUsePhotos.mockReturnValue({
      ...basePhotosReturn([a, b]),
      setPhotosTimestamp: setPhotosTimestampMock,
    })

    render(<PhotoUploadPage />)

    enterCopyMode('a.jpg')

    const bCard = screen.getByAltText('b.jpg').closest('.flex.flex-col.gap-1') as HTMLElement
    fireEvent.click(within(bCard).getByRole('button', { name: 'Paste timestamp' }))

    expect(setPhotosTimestampMock).toHaveBeenCalledWith([b.id], a.capturedAt)
  })

  it('U4: clicking "Paste to entire cluster" calls setPhotosTimestamp with every other cluster member\'s id and the copied date (KTD6: sourced from cluster.members)', () => {
    const a = makeEntry('a.jpg', 0, '2025-06-15T08:30:00Z')
    const p1 = makeEntry('p1.jpg', 1, '2025-01-01T00:00:00Z')
    const p2 = makeEntry('p2.jpg', 2, '2025-01-02T00:00:00Z')
    const setPhotosTimestampMock = vi.fn()
    mockUsePhotos.mockReturnValue({
      ...basePhotosReturn([a, p1, p2]),
      setPhotosTimestamp: setPhotosTimestampMock,
    })
    // a (the copy source) is itself a member of this 3-member cluster.
    mockUseClusteredPhotos.mockImplementation((photos) =>
      clusteredResult(photos, [[a.id, p1.id, p2.id]])
    )

    render(<PhotoUploadPage />)

    enterCopyMode('a.jpg')

    fireEvent.click(screen.getByRole('button', { name: 'Paste to entire cluster' }))

    expect(setPhotosTimestampMock).toHaveBeenCalledWith([p1.id, p2.id], a.capturedAt)
  })
})

// U2: the "Keep best" control, confirmation flow, and result banner.
// `getPhotoDimensions` is mocked (see top of file); `pickBestPhoto` is kept
// real, so these tests exercise the actual comparator wired into the
// component end to end.
describe('PhotoUploadPage — Keep best', () => {
  function makeFileWithSize(name: string, size: number): File {
    return new File([new Uint8Array(size)], name, { type: 'image/jpeg' })
  }

  function makeEntry(
    name: string,
    index: number,
    overrides: Partial<PhotoEntry> = {}
  ): PhotoEntry {
    const file = overrides.file ?? makeFileWithSize(name, 10)
    return {
      id: `${name}-${index}`,
      file,
      filename: name,
      capturedAt: new Date(`2025-0${index + 1}-01T10:00:00Z`),
      uploadIndex: index,
      source: 'local',
      ...overrides,
    }
  }

  function basePhotosReturn(photos: PhotoEntry[], removePhotos = vi.fn()) {
    return {
      photos,
      processFiles: vi.fn(),
      addPhotos: vi.fn(),
      reorderPhotos: vi.fn(),
      updatePhotoName: vi.fn(),
      updatePhotoTimestamp: vi.fn(),
      batchUpdateNames: vi.fn(),
      batchSetTimestamps: vi.fn(),
      removePhotos,
    }
  }

  // Mirrors the stateful mock pattern from the "batch delete" describe block
  // above -- removePhotos filters a mutable local list, so the next render
  // (triggered by any state change) reflects the deletion.
  function makeStatefulPhotosMock(initialPhotos: PhotoEntry[]) {
    let current = initialPhotos
    const removePhotosMock = vi.fn((ids: string[]) => {
      const idSet = new Set(ids)
      current = current.filter((p) => !idSet.has(p.id))
    })
    mockUsePhotos.mockImplementation(() => basePhotosReturn(current, removePhotosMock))
    return removePhotosMock
  }

  function configureDims(map: Map<File, { width: number; height: number }>) {
    mockGetPhotoDimensions.mockImplementation(async (file: File) => map.get(file) ?? { width: 0, height: 0 })
  }

  function keepBestButton(): HTMLButtonElement | null {
    return screen.queryByRole('button', { name: 'Keep best' }) as HTMLButtonElement | null
  }

  function select(name: string) {
    fireEvent.click(screen.getByAltText(name))
  }

  it('hidden at 0 and 1 selected, shown at 2+', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1), makeEntry('c.jpg', 2)]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    expect(keepBestButton()).toBeNull()

    select('a.jpg')
    expect(keepBestButton()).toBeNull()

    select('b.jpg')
    expect(keepBestButton()).not.toBeNull()

    select('c.jpg')
    expect(keepBestButton()).not.toBeNull()
  })

  it('no "Keep best" affordance or state reaches PhotoLightbox -- opening it with 2+ selected renders the lightbox exactly as normal', () => {
    // 3 photos so the middle one (b.jpg) has both a prev and a next
    // neighbor, proving the lightbox's nav props are unaffected too.
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1), makeEntry('c.jpg', 2)]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    select('a.jpg')
    select('b.jpg')
    expect(keepBestButton()).not.toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: 'Zoom photo' })[1])

    const closeButton = screen.getByRole('button', { name: 'Close' })
    const overlay = closeButton.parentElement as HTMLElement

    // No keep-best affordance leaks into the lightbox's own subtree.
    expect(within(overlay).queryByText(/keep best/i)).toBeNull()
    expect(within(overlay).queryByText(/comparing/i)).toBeNull()
    // The lightbox's own standard controls/props are entirely unaffected.
    expect(within(overlay).getByRole('img')).toBeDefined()
    expect(within(overlay).getByRole('button', { name: 'Delete photo' })).toBeDefined()
    expect(within(overlay).getByRole('button', { name: 'Previous photo' })).toBeDefined()
    expect(within(overlay).getByRole('button', { name: 'Next photo' })).toBeDefined()
  })

  it('two selected, different resolutions -- confirming deletes exactly the lower-resolution photo via handleBatchDelete', async () => {
    const a = makeEntry('a.jpg', 0)
    const b = makeEntry('b.jpg', 1)
    const removePhotosMock = makeStatefulPhotosMock([a, b])
    configureDims(new Map([
      [a.file, { width: 100, height: 100 }],
      [b.file, { width: 400, height: 300 }],
    ]))
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(removePhotosMock).toHaveBeenCalledOnce()
    expect(removePhotosMock).toHaveBeenCalledWith([a.id])
  })

  it('equal resolution -- the larger-file-size photo is kept', async () => {
    const a = makeEntry('a.jpg', 0, { file: makeFileWithSize('a.jpg', 100) })
    const b = makeEntry('b.jpg', 1, { file: makeFileWithSize('b.jpg', 500) })
    const removePhotosMock = makeStatefulPhotosMock([a, b])
    configureDims(new Map([
      [a.file, { width: 200, height: 200 }],
      [b.file, { width: 200, height: 200 }],
    ]))
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    // b has the larger file (500 > 100) -- b is kept, a is removed.
    expect(removePhotosMock).toHaveBeenCalledWith([a.id])
  })

  it('equal resolution and size -- the earlier-uploadIndex (earlier-added) photo is kept', async () => {
    const a = makeEntry('a.jpg', 3, { file: makeFileWithSize('a.jpg', 300) })
    const b = makeEntry('b.jpg', 1, { file: makeFileWithSize('b.jpg', 300) })
    const removePhotosMock = makeStatefulPhotosMock([a, b])
    configureDims(new Map([
      [a.file, { width: 200, height: 200 }],
      [b.file, { width: 200, height: 200 }],
    ]))
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    // b has the earlier uploadIndex (1 < 3) -- b is kept, a is removed.
    expect(removePhotosMock).toHaveBeenCalledWith([a.id])
  })

  it('declining the confirm dialog calls neither handleBatchDelete nor sets a result message, and the selection is unchanged', async () => {
    const a = makeEntry('a.jpg', 0)
    const b = makeEntry('b.jpg', 1)
    const removePhotosMock = makeStatefulPhotosMock([a, b])
    configureDims(new Map([
      [a.file, { width: 100, height: 100 }],
      [b.file, { width: 400, height: 300 }],
    ]))
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(removePhotosMock).not.toHaveBeenCalled()
    expect(screen.queryByText(/^Kept /)).toBeNull()
    expect(screen.queryByText('Selection changed — try again.')).toBeNull()
    // Selection unchanged: both photos still selected.
    expect(screen.getByText('2 photos selected')).toBeDefined()
  })

  it('after confirming, the result banner names the kept photo\'s filename, its resolution, and the correct removed count', async () => {
    const a = makeEntry('a.jpg', 0)
    const b = makeEntry('b.jpg', 1)
    makeStatefulPhotosMock([a, b])
    configureDims(new Map([
      [a.file, { width: 100, height: 100 }],
      [b.file, { width: 400, height: 300 }],
    ]))
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() =>
      expect(screen.getByText('Kept "b.jpg" (400×300). Removed 1 photo(s).')).toBeDefined()
    )
  })

  it('a selection spanning two different clusters resolves and deletes correctly, with no cluster-aware branching', async () => {
    const a = makeEntry('a.jpg', 0)
    const b = makeEntry('b.jpg', 1)
    const c = makeEntry('c.jpg', 2)
    const d = makeEntry('d.jpg', 3)
    const removePhotosMock = makeStatefulPhotosMock([a, b, c, d])
    // a/b form one cluster, c/d form a distinct second cluster.
    mockUseClusteredPhotos.mockImplementation((photos) =>
      clusteredResult(photos, [[a.id, b.id], [c.id, d.id]])
    )
    configureDims(new Map([
      [a.file, { width: 100, height: 100 }],
      [c.file, { width: 400, height: 300 }],
    ]))
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PhotoUploadPage />)
    // Select one photo from each of the two distinct clusters.
    select('a.jpg')
    select('c.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(removePhotosMock).toHaveBeenCalledWith([a.id])
  })

  it('if one of exactly 2 selected photos is deleted via its own per-card delete while dimensions are still decoding, the action aborts with no confirm dialog and keepBestResult reads "Selection changed — try again."', async () => {
    const a = makeEntry('a.jpg', 0)
    const b = makeEntry('b.jpg', 1)
    const removePhotosMock = makeStatefulPhotosMock([a, b])

    let resolveA: (dims: { width: number; height: number }) => void = () => {}
    let resolveB: (dims: { width: number; height: number }) => void = () => {}
    const pendingA = new Promise<{ width: number; height: number }>((resolve) => {
      resolveA = resolve
    })
    const pendingB = new Promise<{ width: number; height: number }>((resolve) => {
      resolveB = resolve
    })
    mockGetPhotoDimensions.mockImplementation(async (file: File) => {
      if (file === a.file) return pendingA
      if (file === b.file) return pendingB
      return { width: 0, height: 0 }
    })
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() => expect(screen.getByText('Comparing…')).toBeDefined())

    // Delete b via its own per-card delete icon (not the batch button)
    // while the decode is still pending -- controls stay fully interactive
    // during the decode window.
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete photo' })
    fireEvent.click(deleteButtons[1])
    expect(removePhotosMock).toHaveBeenCalledWith([b.id])

    // Now let the pending decodes resolve.
    await act(async () => {
      resolveA({ width: 100, height: 100 })
      resolveB({ width: 100, height: 100 })
      await Promise.all([pendingA, pendingB])
    })

    await waitFor(() =>
      expect(screen.getByText('Selection changed — try again.')).toBeDefined()
    )
    expect(window.confirm).not.toHaveBeenCalled()
    expect(screen.queryByText('Comparing…')).toBeNull()
  })

  it('isComparingBest disables the button and shows "Comparing…" while decoding, both clearing once the flow reaches the confirm dialog', async () => {
    const a = makeEntry('a.jpg', 0)
    const b = makeEntry('b.jpg', 1)
    makeStatefulPhotosMock([a, b])

    let resolveA: (dims: { width: number; height: number }) => void = () => {}
    const pendingA = new Promise<{ width: number; height: number }>((resolve) => {
      resolveA = resolve
    })
    mockGetPhotoDimensions.mockImplementation(async (file: File) => {
      if (file === a.file) return pendingA
      return { width: 300, height: 300 }
    })
    // Decline the confirm -- nothing gets deleted, so the selection (and
    // therefore the button itself) stays visible afterward, letting this
    // test observe its cleared/re-enabled state directly instead of the
    // button unmounting because the selection shrank below 2.
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() => expect(screen.getByText('Comparing…')).toBeDefined())
    expect(keepBestButton()!.disabled).toBe(true)

    await act(async () => {
      resolveA({ width: 300, height: 300 })
      await pendingA
    })

    await waitFor(() => expect(window.confirm).toHaveBeenCalled())
    expect(screen.queryByText('Comparing…')).toBeNull()
    expect(keepBestButton()!.disabled).toBe(false)
  })

  it('renders the exact confirm and result copy: winner filename, resolution, and loser count', async () => {
    const a = makeEntry('a.jpg', 0)
    const b = makeEntry('b.jpg', 1)
    const c = makeEntry('c.jpg', 2)
    makeStatefulPhotosMock([a, b, c])
    configureDims(new Map([
      [a.file, { width: 100, height: 100 }],
      [b.file, { width: 100, height: 100 }],
      [c.file, { width: 800, height: 600 }],
    ]))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    select('c.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(confirmSpy).toHaveBeenCalledWith(
      'Keep "c.jpg" (800×600)? This will delete 2 other selected photo(s).'
    )

    await waitFor(() =>
      expect(screen.getByText('Kept "c.jpg" (800×600). Removed 2 photo(s).')).toBeDefined()
    )
  })

  it('when the winning photo\'s dimensions decode to {0, 0}, the confirm and result text omit the resolution clause -- "0 x 0"/"0×0" never appears', async () => {
    const a = makeEntry('a.jpg', 0, { file: makeFileWithSize('a.jpg', 50) })
    const b = makeEntry('b.jpg', 1, { file: makeFileWithSize('b.jpg', 900) })
    makeStatefulPhotosMock([a, b])
    // Both decode-fail to {0, 0} -- tied on resolution, so file size breaks
    // the tie: b (larger file) wins, still with {0, 0} dimensions.
    configureDims(new Map([
      [a.file, { width: 0, height: 0 }],
      [b.file, { width: 0, height: 0 }],
    ]))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled())
    expect(confirmSpy).toHaveBeenCalledWith('Keep "b.jpg"? This will delete 1 other selected photo(s).')

    await waitFor(() =>
      expect(screen.getByText('Kept "b.jpg". Removed 1 photo(s).')).toBeDefined()
    )

    expect(screen.queryByText(/0\s*[x×]\s*0/i)).toBeNull()
  })

  it('after a completed action, the winner\'s id is still present in selectedIds', async () => {
    const a = makeEntry('a.jpg', 0)
    const b = makeEntry('b.jpg', 1)
    makeStatefulPhotosMock([a, b])
    configureDims(new Map([
      [a.file, { width: 100, height: 100 }],
      [b.file, { width: 400, height: 300 }],
    ]))
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() =>
      expect(screen.getByText('Kept "b.jpg" (400×300). Removed 1 photo(s).')).toBeDefined()
    )

    // b (the winner) is still selected -- BatchEditPanel's own count still
    // reflects it as the sole remaining selected photo.
    expect(screen.getByText('1 photo selected')).toBeDefined()
  })

  it('the result banner is reachable even when the action reduces photos.length to 1, the minimum possible after keeping exactly one survivor', async () => {
    const a = makeEntry('a.jpg', 0)
    const b = makeEntry('b.jpg', 1)
    makeStatefulPhotosMock([a, b])
    configureDims(new Map([
      [a.file, { width: 100, height: 100 }],
      [b.file, { width: 400, height: 300 }],
    ]))
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() =>
      expect(screen.getByText('Kept "b.jpg" (400×300). Removed 1 photo(s).')).toBeDefined()
    )

    // Exactly 1 photo remains -- the minimum possible survivor count -- and
    // the banner is still on screen, proving it isn't nested inside a
    // `photos.length > 0`-style gate.
    expect(screen.queryAllByRole('img')).toHaveLength(1)
    expect(screen.getByText('Kept "b.jpg" (400×300). Removed 1 photo(s).')).toBeDefined()
  })

  it('deselecting one of the two selected photos during decode aborts with "Selection changed — try again.", even though neither photo was deleted', async () => {
    const a = makeEntry('a.jpg', 0)
    const b = makeEntry('b.jpg', 1)
    makeStatefulPhotosMock([a, b])

    let resolveA: (dims: { width: number; height: number }) => void = () => {}
    const pendingA = new Promise<{ width: number; height: number }>((resolve) => {
      resolveA = resolve
    })
    mockGetPhotoDimensions.mockImplementation(async (file: File) => {
      if (file === a.file) return pendingA
      return { width: 100, height: 100 }
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() => expect(screen.getByText('Comparing…')).toBeDefined())

    // Deselect b while decode is still pending -- both photos still exist
    // (an existence-only re-check would let this proceed unchanged).
    select('b.jpg')

    await act(async () => {
      resolveA({ width: 100, height: 100 })
      await pendingA
    })

    await waitFor(() =>
      expect(screen.getByText('Selection changed — try again.')).toBeDefined()
    )
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('the button and "Comparing…" indicator stay visible if the selection drops below 2 mid-decode (e.g. via Clear selection), instead of vanishing before the eventual outcome is shown', async () => {
    const a = makeEntry('a.jpg', 0)
    const b = makeEntry('b.jpg', 1)
    makeStatefulPhotosMock([a, b])

    let resolveA: (dims: { width: number; height: number }) => void = () => {}
    const pendingA = new Promise<{ width: number; height: number }>((resolve) => {
      resolveA = resolve
    })
    mockGetPhotoDimensions.mockImplementation(async (file: File) => {
      if (file === a.file) return pendingA
      return { width: 100, height: 100 }
    })
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() => expect(screen.getByText('Comparing…')).toBeDefined())

    fireEvent.click(screen.getAllByRole('button', { name: 'Clear selection' })[0])

    // selectedIds.size is now 0, but the button and indicator stay visible
    // for the rest of the already-started comparison.
    expect(keepBestButton()).not.toBeNull()
    expect(screen.getByText('Comparing…')).toBeDefined()

    await act(async () => {
      resolveA({ width: 100, height: 100 })
      await pendingA
    })

    await waitFor(() =>
      expect(screen.getByText('Selection changed — try again.')).toBeDefined()
    )
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(keepBestButton()).toBeNull()
  })

  it('an unexpected rejection during decode is caught, clears isComparingBest, and shows a failure message instead of leaving the button stuck disabled', async () => {
    const a = makeEntry('a.jpg', 0)
    const b = makeEntry('b.jpg', 1)
    makeStatefulPhotosMock([a, b])
    mockGetPhotoDimensions.mockRejectedValue(new Error('boom'))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    render(<PhotoUploadPage />)
    select('a.jpg')
    select('b.jpg')
    fireEvent.click(keepBestButton()!)

    await waitFor(() =>
      expect(screen.getByText("Couldn't compare photos — try again.")).toBeDefined()
    )
    expect(confirmSpy).not.toHaveBeenCalled()
    expect(keepBestButton()!.disabled).toBe(false)
    expect(screen.queryByText('Comparing…')).toBeNull()

    consoleErrorSpy.mockRestore()
  })
})
