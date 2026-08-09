export interface PickerSession {
  id: string
  pickerUri: string
  pollingConfig: {
    pollInterval: string // e.g. "2s"
    timeoutIn: string // e.g. "300s"
  }
  expireTime: string
  mediaItemsSet: boolean
}

export interface MediaFile {
  baseUrl: string
  mimeType: string
  filename: string
}

export interface MediaMetadata {
  creationTime: string // ISO-8601
  width: string
  height: string
}

export interface PickedMediaItem {
  id: string
  type: string
  mediaFile: MediaFile
  mediaMetadata: MediaMetadata
}

export interface MediaItemsResponse {
  mediaItems: PickedMediaItem[]
  nextPageToken?: string
}

export interface UploadToken {
  token: string
  filename: string
}

export interface NewMediaItem {
  simpleMediaItem: {
    fileName: string
    uploadToken: string
  }
}

export interface NewMediaItemResult {
  uploadToken: string
  status: { message: string; code?: number }
  mediaItem?: {
    id: string
    filename: string
  }
}

export interface BatchCreateResult {
  newMediaItemResults: NewMediaItemResult[]
}

export interface Album {
  id: string
  title: string
}

export interface GooglePhotosApiError {
  error?: {
    code?: number
    message?: string
    status?: string
  }
}
