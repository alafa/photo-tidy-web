'use client'

import { useCallback, useEffect, useRef } from 'react'

/**
 * Returns a stable getter that creates object URLs lazily (one per unique
 * File reference), plus a release function to revoke one early — e.g. when
 * a photo is removed mid-session rather than only on unmount.
 */
export function useObjectUrls(): {
  getObjectUrl: (file: File) => string
  releaseObjectUrl: (file: File) => void
} {
  const mapRef = useRef<Map<File, string>>(new Map())

  useEffect(() => {
    const map = mapRef.current
    return () => {
      map.forEach((url) => URL.revokeObjectURL(url))
      map.clear()
    }
  }, [])

  const getObjectUrl = useCallback((file: File): string => {
    if (!mapRef.current.has(file)) {
      mapRef.current.set(file, URL.createObjectURL(file))
    }
    return mapRef.current.get(file)!
  }, [])

  const releaseObjectUrl = useCallback((file: File): void => {
    const url = mapRef.current.get(file)
    if (url !== undefined) {
      URL.revokeObjectURL(url)
      mapRef.current.delete(file)
    }
  }, [])

  return { getObjectUrl, releaseObjectUrl }
}
