---
date: 2026-04-05
topic: photo-upload-display
---

# Photo Upload & Display

## Problem Frame

Users need to upload a set of photos and immediately see them arranged chronologically by when they were taken, with the filename and capture date visible beneath each one. All processing happens in the browser — no server-side storage.

## User Flow

```
User selects files
       │
       ▼
Read EXIF DateTimeOriginal
from each file (client-side)
       │
       ▼
Sort ascending by timestamp
(no-date photos go last)
       │
       ▼
Render photo grid
  ┌──────────────┐
  │   [image]    │
  │ filename.jpg │
  │ Jan 3, 2025  │
  └──────────────┘
```

## Requirements

**Upload**
- R1. User can select one or more image files via a file input.
- R2. Accepted formats: JPEG, PNG, TIFF. HEIC/HEIF if the chosen EXIF library supports it without extra decode steps; otherwise out of scope for this feature.

**EXIF Reading**
- R3. For each uploaded file, read the `DateTimeOriginal` EXIF tag client-side.
- R4. If `DateTimeOriginal` is absent, fall back in order: `DateTimeDigitized`, then `DateTime`.

**Display & Ordering**
- R5. Photos are displayed in a grid, sorted ascending by timestamp (oldest first). When timestamps are equal, preserve upload order as a tiebreaker.
- R6. Photos with no parseable timestamp are sorted to the end of the list.
- R7. Below each photo: the original filename and the formatted capture date (e.g. "Jan 3, 2025 14:32"). EXIF timestamps have no timezone — display the value as-is (no timezone conversion).
- R8. Photos with no timestamp show "No date" in place of the date.

## Success Criteria

- Uploading a mixed set of photos (with and without EXIF) produces a correctly sorted grid with no manual reordering required.
- All date parsing and sorting happens without a network request.

## Scope Boundaries

- No server upload or persistence — files stay in memory for the session.
- No image editing or metadata writing — that is a separate feature (drag & drop timestamp reordering).
- No authentication or user accounts.

## Outstanding Questions

### Deferred to Planning
- [Affects R3][Needs research] Which client-side EXIF library to use (e.g. `exifr`, `piexifjs`, `exif-js`).
- [Affects R2][Needs research] Confirm whether chosen EXIF library handles HEIC natively; if not, HEIC is excluded from accepted formats.
- [Affects R5] Maximum practical file count / size before browser memory becomes a concern — determine during implementation.

## Next Steps
→ `/ce:plan` for structured implementation planning
