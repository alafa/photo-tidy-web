import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import PhotoUploadPage from './PhotoUploadPage'

afterEach(cleanup)

// Mock hooks so we can control EXIF output
vi.mock('@/hooks/usePhotos', () => ({
  usePhotos: vi.fn(),
}))
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
const mockUsePhotos = vi.mocked(usePhotos)
const mockUseObjectUrls = vi.mocked(useObjectUrls)
const mockUseGoogleAuth = vi.mocked(useGoogleAuth)
const mockUseGooglePhotosPicker = vi.mocked(useGooglePhotosPicker)
const mockUseGooglePhotosUpload = vi.mocked(useGooglePhotosUpload)

function makeFile(name: string): File {
  return new File([], name, { type: 'image/jpeg' })
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedOnDragStart = null
  capturedOnDragEnd = null
  mockUseObjectUrls.mockReturnValue((file: File) => `blob:${file.name}`)
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
            file: makeFile('a.jpg'),
            filename: 'a.jpg',
            capturedAt: new Date('2024-01-01T10:00:00Z'),
            uploadIndex: 0,
          },
          {
            file: makeFile('b.jpg'),
            filename: 'b.jpg',
            capturedAt: new Date('2025-06-15T08:30:00Z'),
            uploadIndex: 1,
          },
          {
            file: makeFile('c.jpg'),
            filename: 'c.jpg',
            capturedAt: new Date('2023-03-20T16:45:00Z'),
            uploadIndex: 2,
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
})
