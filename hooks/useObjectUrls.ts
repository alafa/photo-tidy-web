'use client'

import { useEffect, useRef } from 'react'

/**
 * Returns a stable getter function that creates object URLs lazily
 * (one per unique File reference) and revokes all of them on unmount.
 */
export function useObjectUrls(): (file: File) => string {
  const mapRef = useRef<Map<File, string>>(new Map())

  useEffect(() => {
    const map = mapRef.current
    return () => {
      map.forEach((url) => URL.revokeObjectURL(url))
      map.clear()
    }
  }, [])

  return (file: File): string => {
    if (!mapRef.current.has(file)) {
      mapRef.current.set(file, URL.createObjectURL(file))
    }
    return mapRef.current.get(file)!
  }
}
