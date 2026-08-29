// Generic array-chunking utility shared by features that need to split a
// list into fixed-size batches (e.g. Google Photos batch-create's 50-item
// limit, IndexedDB write-through batching). Kept here rather than in either
// feature's own hook so the two stay decoupled from each other.
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}
