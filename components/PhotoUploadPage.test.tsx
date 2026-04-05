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
const mockUsePhotos = vi.mocked(usePhotos)
const mockUseObjectUrls = vi.mocked(useObjectUrls)

function makeFile(name: string): File {
  return new File([], name, { type: 'image/jpeg' })
}

beforeEach(() => {
  vi.clearAllMocks()
  capturedOnDragStart = null
  capturedOnDragEnd = null
  mockUseObjectUrls.mockReturnValue((file: File) => `blob:${file.name}`)
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
      file,
      filename: name,
      capturedAt: new Date(`2025-0${index + 1}-01T10:00:00Z`),
      uploadIndex: index,
    }
  }

  function photoId(entry: ReturnType<typeof makeEntry>) {
    return `${entry.filename}-${entry.file.lastModified}-${entry.uploadIndex}`
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
