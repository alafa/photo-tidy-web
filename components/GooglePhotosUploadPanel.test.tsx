import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { PhotoEntry } from '@/hooks/usePhotos'
import type { UploadState, PhotoUploadState } from '@/hooks/useGooglePhotosUpload'
import GooglePhotosUploadPanel from './GooglePhotosUploadPanel'

afterEach(cleanup)

function makePhoto(overrides: Partial<PhotoEntry> = {}): PhotoEntry {
  const file = new File([], 'test.jpg', { type: 'image/jpeg' })
  return {
    id: Math.random().toString(36).slice(2),
    file,
    filename: 'test.jpg',
    capturedAt: null,
    uploadIndex: 0,
    source: 'local',
    ...overrides,
  }
}

function makePhotoStates(
  photos: PhotoEntry[],
  statusMap: Record<string, PhotoUploadState['status']>,
  errorMap: Record<string, string> = {}
): Map<string, PhotoUploadState> {
  const map = new Map<string, PhotoUploadState>()
  for (const photo of photos) {
    const status = statusMap[photo.id] ?? 'pending'
    map.set(photo.id, { status, error: errorMap[photo.id] })
  }
  return map
}

const defaultProps = {
  photos: [],
  accessToken: null,
  uploadState: 'idle' as UploadState,
  photoStates: new Map<string, PhotoUploadState>(),
  albumName: 'My Vacation',
  onAlbumNameChange: vi.fn(),
  onStartUpload: vi.fn(),
  onRetryFailed: vi.fn(),
}

describe('GooglePhotosUploadPanel', () => {
  it('renders album name input and upload button when uploadState is idle', () => {
    render(<GooglePhotosUploadPanel {...defaultProps} />)

    expect(screen.getByPlaceholderText('Album name')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Upload to Google Photos' })).toBeDefined()
  })

  it('does not render progress list when uploadState is idle', () => {
    const photo = makePhoto({ filename: 'img.jpg' })
    render(<GooglePhotosUploadPanel {...defaultProps} photos={[photo]} />)

    expect(screen.queryByText('img.jpg')).toBeNull()
  })

  it('does not render success banner when uploadState is idle', () => {
    render(<GooglePhotosUploadPanel {...defaultProps} />)

    expect(screen.queryByText(/uploaded to/)).toBeNull()
  })

  it('disables upload button when uploadState is uploading', () => {
    const photo = makePhoto()
    const photos = [photo]
    const photoStates = makePhotoStates(photos, { [photo.id]: 'uploading' })

    render(
      <GooglePhotosUploadPanel
        {...defaultProps}
        photos={photos}
        uploadState="uploading"
        photoStates={photoStates}
      />
    )

    const button = screen.getByRole('button', { name: 'Upload to Google Photos' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('shows progress summary "Uploading N of M" when uploadState is uploading', () => {
    const photos = [
      makePhoto({ filename: 'a.jpg' }),
      makePhoto({ filename: 'b.jpg' }),
      makePhoto({ filename: 'c.jpg' }),
    ]
    const photoStates = new Map<string, PhotoUploadState>([
      [photos[0].id, { status: 'done' }],
      [photos[1].id, { status: 'uploading' }],
      [photos[2].id, { status: 'pending' }],
    ])

    render(
      <GooglePhotosUploadPanel
        {...defaultProps}
        photos={photos}
        uploadState="uploading"
        photoStates={photoStates}
      />
    )

    expect(screen.getByText('Uploading 1 of 3\u2026')).toBeDefined()
  })

  it('shows success banner without album name when uploadState is done and albumName is empty', () => {
    const photos = [makePhoto(), makePhoto()]
    const photoStates = new Map<string, PhotoUploadState>([
      [photos[0].id, { status: 'done' }],
      [photos[1].id, { status: 'done' }],
    ])

    render(
      <GooglePhotosUploadPanel
        {...defaultProps}
        photos={photos}
        uploadState="done"
        photoStates={photoStates}
        albumName=""
      />
    )

    expect(screen.getByText('2 photos uploaded to Google Photos')).toBeDefined()
  })

  it('shows success banner with album name when uploadState is done and albumName is provided', () => {
    const photos = [makePhoto()]
    const photoStates = new Map<string, PhotoUploadState>([
      [photos[0].id, { status: 'done' }],
    ])

    render(
      <GooglePhotosUploadPanel
        {...defaultProps}
        photos={photos}
        uploadState="done"
        photoStates={photoStates}
        albumName="My Vacation"
      />
    )

    expect(screen.getByText("1 photos uploaded to album 'My Vacation'")).toBeDefined()
  })

  it('does not show "Retry failed" button when all photos succeeded', () => {
    const photos = [makePhoto()]
    const photoStates = new Map<string, PhotoUploadState>([
      [photos[0].id, { status: 'done' }],
    ])

    render(
      <GooglePhotosUploadPanel
        {...defaultProps}
        photos={photos}
        uploadState="done"
        photoStates={photoStates}
      />
    )

    expect(screen.queryByRole('button', { name: 'Retry failed' })).toBeNull()
  })

  it('shows "Retry failed" button when some photos failed and uploadState is done', () => {
    const photos = [makePhoto(), makePhoto()]
    const photoStates = new Map<string, PhotoUploadState>([
      [photos[0].id, { status: 'done' }],
      [photos[1].id, { status: 'failed', error: 'Network error' }],
    ])

    render(
      <GooglePhotosUploadPanel
        {...defaultProps}
        photos={photos}
        uploadState="done"
        photoStates={photoStates}
      />
    )

    expect(screen.getByRole('button', { name: 'Retry failed' })).toBeDefined()
  })

  it('calls onRetryFailed when "Retry failed" button is clicked', () => {
    const onRetryFailed = vi.fn()
    const photos = [makePhoto()]
    const photoStates = new Map<string, PhotoUploadState>([
      [photos[0].id, { status: 'failed', error: 'Timeout' }],
    ])

    render(
      <GooglePhotosUploadPanel
        {...defaultProps}
        photos={photos}
        uploadState="done"
        photoStates={photoStates}
        onRetryFailed={onRetryFailed}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Retry failed' }))
    expect(onRetryFailed).toHaveBeenCalledOnce()
  })

  it('album name input has maxLength of 487, leaving room for the " (photo tidy)" suffix within the 500-char server cap', () => {
    render(<GooglePhotosUploadPanel {...defaultProps} />)

    const input = screen.getByPlaceholderText('Album name') as HTMLInputElement
    expect(input.maxLength).toBe(487)
  })

  it('calls onStartUpload when upload button is clicked', () => {
    const onStartUpload = vi.fn()

    render(<GooglePhotosUploadPanel {...defaultProps} onStartUpload={onStartUpload} />)

    fireEvent.click(screen.getByRole('button', { name: 'Upload to Google Photos' }))
    expect(onStartUpload).toHaveBeenCalledOnce()
  })

  it('disables upload button and shows helper text when albumName is empty', () => {
    render(<GooglePhotosUploadPanel {...defaultProps} albumName="" />)

    const button = screen.getByRole('button', { name: 'Upload to Google Photos' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('Enter a name to enable upload')).toBeDefined()
  })

  it('disables upload button and shows helper text when albumName is whitespace-only', () => {
    render(<GooglePhotosUploadPanel {...defaultProps} albumName="   " />)

    const button = screen.getByRole('button', { name: 'Upload to Google Photos' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByText('Enter a name to enable upload')).toBeDefined()
  })

  it('enables upload button and hides helper text once albumName has non-whitespace content', () => {
    render(<GooglePhotosUploadPanel {...defaultProps} albumName="Vacaciones 2024" />)

    const button = screen.getByRole('button', { name: 'Upload to Google Photos' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(screen.queryByText('Enter a name to enable upload')).toBeNull()
  })

  it('toggles the upload button disabled state as albumName is entered and cleared', () => {
    const { rerender } = render(<GooglePhotosUploadPanel {...defaultProps} albumName="" />)

    let button = screen.getByRole('button', { name: 'Upload to Google Photos' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    rerender(<GooglePhotosUploadPanel {...defaultProps} albumName="Vacaciones 2024" />)
    button = screen.getByRole('button', { name: 'Upload to Google Photos' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)

    rerender(<GooglePhotosUploadPanel {...defaultProps} albumName="" />)
    button = screen.getByRole('button', { name: 'Upload to Google Photos' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it('shows per-photo progress list when uploadState is not idle', () => {
    const photos = [
      makePhoto({ filename: 'photo1.jpg' }),
      makePhoto({ filename: 'photo2.jpg' }),
    ]
    const photoStates = new Map<string, PhotoUploadState>([
      [photos[0].id, { status: 'done' }],
      [photos[1].id, { status: 'failed', error: 'Upload failed' }],
    ])

    render(
      <GooglePhotosUploadPanel
        {...defaultProps}
        photos={photos}
        uploadState="done"
        photoStates={photoStates}
      />
    )

    expect(screen.getByText('photo1.jpg')).toBeDefined()
    expect(screen.getByText('photo2.jpg')).toBeDefined()
    expect(screen.getByText('✓ Done')).toBeDefined()
    expect(screen.getByText('✗ Failed: Upload failed')).toBeDefined()
  })
})
