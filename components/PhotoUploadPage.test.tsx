import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { range, makeHashFromPositions } from '@/lib/test-helpers/hash-fixtures'
import PhotoUploadPage from './PhotoUploadPage'

afterEach(cleanup)

// Mock hooks so we can control EXIF output. Only `usePhotos` itself is
// mocked -- `compareByCapturedAt` is kept real (via importOriginal) since
// `hooks/useClusteredPhotos.ts` imports it from this module for chronological
// member ordering, exercised here through the real (unmocked)
// useClusteredPhotos pipeline underneath PhotoGrid.
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
vi.mock('@/hooks/usePhotoMetrics', () => ({
  usePhotoMetrics: vi.fn(),
}))

// Capture dnd-kit callbacks so tests can invoke them directly
let capturedOnDragStart: ((e: { active: { id: string } }) => void) | null = null
let capturedOnDragEnd: ((e: { active: { id: string }; over: { id: string } | null }) => void) | null = null

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

vi.mock('@dnd-kit/sortable', () => ({
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
}))

import { usePhotos } from '@/hooks/usePhotos'
import { useObjectUrls } from '@/hooks/useObjectUrls'
import { useGoogleAuth } from '@/hooks/useGoogleAuth'
import { useGooglePhotosPicker } from '@/hooks/useGooglePhotosPicker'
import { useGooglePhotosUpload } from '@/hooks/useGooglePhotosUpload'
import { usePhotoMetrics } from '@/hooks/usePhotoMetrics'
const mockUsePhotos = vi.mocked(usePhotos)
const mockUseObjectUrls = vi.mocked(useObjectUrls)
const mockUseGoogleAuth = vi.mocked(useGoogleAuth)
const mockUseGooglePhotosPicker = vi.mocked(useGooglePhotosPicker)
const mockUseGooglePhotosUpload = vi.mocked(useGooglePhotosUpload)
const mockUsePhotoMetrics = vi.mocked(usePhotoMetrics)

function makeFile(name: string): File {
  return new File([], name, { type: 'image/jpeg' })
}

// Hash-fixture helpers for U3's within-cluster/cross-block drag tests below
// -- same technique as components/PhotoGrid.test.tsx and
// hooks/useClusteredPhotos.test.ts: hashes built from explicit "on" bit
// positions so cosine distances between fixtures are exactly predictable.
const HASH_TOTAL_BITS = 128

const hashFromPositions = makeHashFromPositions(HASH_TOTAL_BITS)

beforeEach(() => {
  vi.clearAllMocks()
  capturedOnDragStart = null
  capturedOnDragEnd = null
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
  })
  mockUsePhotoMetrics.mockReturnValue(new Map())
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

  it('calls reorderPhotos with correct indices on dragEnd', () => {
    const reorderPhotosMock = vi.fn()
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1), makeEntry('c.jpg', 2)]
    mockUsePhotos.mockReturnValue({
      photos,
      processFiles: vi.fn(),
      reorderPhotos: reorderPhotosMock,
    })

    render(<PhotoUploadPage />)

    act(() => {
      capturedOnDragEnd?.({
        active: { id: photoId(photos[2]) },
        over: { id: photoId(photos[0]) },
      })
    })

    expect(reorderPhotosMock).toHaveBeenCalledWith(2, 0)
  })

  it('does not call reorderPhotos when dropped outside the grid (over is null)', () => {
    const reorderPhotosMock = vi.fn()
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUsePhotos.mockReturnValue({
      photos,
      processFiles: vi.fn(),
      reorderPhotos: reorderPhotosMock,
    })

    render(<PhotoUploadPage />)

    act(() => {
      capturedOnDragEnd?.({
        active: { id: photoId(photos[0]) },
        over: null,
      })
    })

    expect(reorderPhotosMock).not.toHaveBeenCalled()
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
  // once real clustering is in the picture, using the real (unmocked)
  // useClusteredPhotos pipeline via PhotoGrid -- only dnd-kit itself is
  // mocked here, same as the rest of this describe block.
  describe('across a real cluster (KTD2/KTD3)', () => {
    // solo1, then a 2-member cluster (m1, m2), then solo2 -- passed
    // pre-sorted chronologically, exactly as hooks/usePhotos.ts would
    // produce. m1/m2 share an identical hash so they cluster at the 0%
    // default threshold.
    const solo1 = makeEntry('solo1.jpg', 0)
    const m1 = makeEntry('m1.jpg', 1)
    const m2 = makeEntry('m2.jpg', 2)
    const solo2 = makeEntry('solo2.jpg', 3)
    const photos = [solo1, m1, m2, solo2]

    function renderWithCluster(reorderPhotosMock: ReturnType<typeof vi.fn>) {
      mockUsePhotos.mockReturnValue({ photos, processFiles: vi.fn(), reorderPhotos: reorderPhotosMock })
      mockUsePhotoMetrics.mockReturnValue(
        new Map([
          [m1.id, { width: 1, height: 1, size: 1, hash: hashFromPositions(range(0, 9)) }],
          [m2.id, { width: 1, height: 1, size: 1, hash: hashFromPositions(range(0, 9)) }],
        ])
      )
      render(<PhotoUploadPage />)
      // Sanity: m1/m2 really did render as a bordered cluster section.
      expect(document.querySelectorAll('section')).toHaveLength(1)
    }

    it('AE2: dragging a standalone photo to a position inside a cluster\'s visual span resolves the same from/to indices a flat reorder would', () => {
      const reorderPhotosMock = vi.fn()
      renderWithCluster(reorderPhotosMock)

      // solo1 (index 0) dropped onto m2 (index 2, inside the cluster's span).
      act(() => {
        capturedOnDragEnd?.({ active: { id: photoId(solo1) }, over: { id: photoId(m2) } })
      })

      expect(reorderPhotosMock).toHaveBeenCalledWith(0, 2)
      // reorderPhotos itself (hooks/usePhotos.ts, out of scope, confirmed
      // correct) is what actually rewrites only the moved photo's
      // timestamp using the existing offset convention -- this asserts
      // handleDragEnd hands it the right, unmodified indices.
    })

    it('dragging a cluster member to a position outside any cluster resolves correctly, leaving the remaining member\'s own index untouched', () => {
      const reorderPhotosMock = vi.fn()
      renderWithCluster(reorderPhotosMock)

      // m1 (index 1, inside the cluster) dropped onto solo2 (index 3, outside any cluster).
      act(() => {
        capturedOnDragEnd?.({ active: { id: photoId(m1) }, over: { id: photoId(solo2) } })
      })

      expect(reorderPhotosMock).toHaveBeenCalledWith(1, 3)
      expect(reorderPhotosMock).toHaveBeenCalledOnce()
    })

    it('CRITICAL (KTD3): dragging one cluster member to swap with another member of the same cluster resolves the same from/to a purely chronological array-index computation would', () => {
      const reorderPhotosMock = vi.fn()
      renderWithCluster(reorderPhotosMock)

      // m2 (index 2) dropped onto m1 (index 1) -- both inside the same
      // cluster. A purely chronological computation over `photos` (which is
      // already sorted that way) gives from=2, to=1 directly -- if cluster
      // members were instead ordered by similarity (the old
      // hierarchicalOrder, pre-KTD3), the id visually adjacent on screen
      // could diverge from this, but handleDragEnd's photos.findIndex
      // always resolves against the real array, which chronological member
      // ordering (KTD3) keeps in agreement with what's rendered.
      act(() => {
        capturedOnDragEnd?.({ active: { id: photoId(m2) }, over: { id: photoId(m1) } })
      })

      expect(reorderPhotosMock).toHaveBeenCalledWith(2, 1)
    })

    it('DragOverlay renders correctly for a card that started inside a cluster section', () => {
      const reorderPhotosMock = vi.fn()
      renderWithCluster(reorderPhotosMock)

      act(() => {
        capturedOnDragStart?.({ active: { id: photoId(m1) } })
      })

      const overlay = document.querySelector('[data-testid="drag-overlay"]')
      expect(overlay?.textContent).toContain('m1.jpg')
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
    // m1/m2 share an identical hash so they cluster at the 0% default
    // threshold -- same fixture technique as the "across a real cluster"
    // drag tests above.
    mockUsePhotoMetrics.mockReturnValue(
      new Map([
        [photos[1].id, { width: 1, height: 1, size: 1, hash: hashFromPositions(range(0, 9)) }],
        [photos[2].id, { width: 1, height: 1, size: 1, hash: hashFromPositions(range(0, 9)) }],
      ])
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
    mockUsePhotoMetrics.mockReturnValue(
      new Map([
        [photos[1].id, { width: 1, height: 1, size: 1, hash: hashFromPositions(range(0, 9)) }],
        [photos[2].id, { width: 1, height: 1, size: 1, hash: hashFromPositions(range(0, 9)) }],
      ])
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

  it('calls usePhotoMetrics unconditionally with the current photos', () => {
    const photos = [makeEntry('a.jpg', 0), makeEntry('b.jpg', 1)]
    mockUsePhotos.mockReturnValue(basePhotosReturn(photos))

    render(<PhotoUploadPage />)

    expect(mockUsePhotoMetrics).toHaveBeenCalledWith(photos)
  })
})
