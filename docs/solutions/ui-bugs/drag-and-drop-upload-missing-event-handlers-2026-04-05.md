---
title: "Drag-and-Drop Upload Silently Fails Without onDragOver + onDrop Handlers"
date: 2026-04-05
category: ui-bugs
module: photo-upload
problem_type: ui_bug
component: tooling
symptoms:
  - "Dropping files from OS Finder onto the upload drop zone had no effect"
  - "No error, no network request, no visual feedback — the drop was silently rejected"
  - "Click-to-select on the same element worked correctly"
root_cause: missing_workflow_step
resolution_type: code_fix
severity: medium
tags:
  - drag-and-drop
  - file-upload
  - dragover
  - preventDefault
  - dataTransfer
  - react
  - next-js
  - label-element
---

# Drag-and-Drop Upload Silently Fails Without onDragOver + onDrop Handlers

## Problem

A `<label>` element used as a file-upload drop zone accepted click-to-select correctly but silently rejected all OS-level file drops. Dragging files from Finder onto the zone had no effect.

## Symptoms

- Dropping image files from macOS Finder onto the drop zone did nothing — no upload, no error, no visual feedback.
- The `onChange` handler on the hidden `<input type="file">` fired correctly when files were selected via click.
- No console errors were produced during the failed drop.

## What Didn't Work

The bug was quickly identified. The `onChange` handler and the `<label>`/`<input>` wiring were both correct — the problem was isolated to the missing drag-and-drop event layer immediately.

## Solution

Add `onDragOver` and `onDrop` handlers to the drop zone element in `components/PhotoUploadPage.tsx`:

**Before:**
```tsx
<label className="...">
  <span>Click to select photos, or drag & drop</span>
  <input
    type="file"
    multiple
    accept="image/jpeg,image/png,image/tiff"
    onChange={handleChange}
    className="sr-only"
  />
</label>
```

**After:**
```tsx
function handleDragOver(e: React.DragEvent<HTMLLabelElement>) {
  e.preventDefault()
  e.stopPropagation()
}

function handleDrop(e: React.DragEvent<HTMLLabelElement>) {
  e.preventDefault()
  e.stopPropagation()
  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
    processFiles(e.dataTransfer.files)
  }
}

<label
  className="..."
  onDragOver={handleDragOver}
  onDrop={handleDrop}
>
  <span>Click to select photos, or drag & drop</span>
  <input
    type="file"
    multiple
    accept="image/jpeg,image/png,image/tiff"
    onChange={handleChange}
    className="sr-only"
  />
</label>
```

## Why This Works

Without an `onDragOver` handler that calls `e.preventDefault()`, the browser treats the element as a non-droppable target. The browser's default `dragover` behavior is to reject the drop — the `drop` event never fires. Cancelling `dragover` with `preventDefault()` signals that the element will accept the drop, which allows `onDrop` to fire.

Once in the `onDrop` handler, `e.dataTransfer.files` contains the dropped `FileList` — the same type produced by `<input type="file">`, so it can be passed directly to the existing `processFiles` function.

`stopPropagation()` on both handlers prevents the events from bubbling to ancestor elements that might trigger conflicting browser defaults (e.g., navigating to the file).

## Prevention

1. **Always pair `onDrop` with `onDragOver`**: Any element intended as a drop target must cancel `dragover` with `e.preventDefault()`. Without it, `drop` never fires. Treat these handlers as a required pair.

2. **Test drag-and-drop separately from click-to-select**: These are distinct code paths. A test covering `onChange` does not cover `onDrop`. Add a dedicated drop test whenever building a drag-and-drop upload UI:
   ```tsx
   it('calls processFiles when files are dropped onto the drop zone', () => {
     const processFilesMock = vi.fn()
     mockUsePhotos.mockReturnValue({ photos: [], processFiles: processFilesMock })
     render(<PhotoUploadPage />)
     const label = document.querySelector('label') as HTMLLabelElement
     const file = makeFile('dropped.jpg')
     // Note: fireEvent merges dataTransfer shallowly. If the handler's
     // `e.dataTransfer.files` guard doesn't fire, use Object.defineProperty
     // to attach a real FileList instead.
     fireEvent.drop(label, { dataTransfer: { files: [file] } })
     expect(processFilesMock).toHaveBeenCalled()
   })
   ```

3. **UI copy implies a contract**: If the label says "drag & drop", there must be a drop handler. A mismatch between advertised behavior and implemented behavior is a useful code-review signal.

4. **Consider a reusable `DropZone` component**: Centralising `onDragOver` + `onDrop` logic into a single tested component prevents this omission from recurring across multiple upload surfaces.

## Related Issues

- Affects: `components/PhotoUploadPage.tsx`
- Test coverage: `components/PhotoUploadPage.test.tsx`
