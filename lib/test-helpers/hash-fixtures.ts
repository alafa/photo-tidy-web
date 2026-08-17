// Shared test-fixture helpers for building perceptual-hash strings from an
// explicit set of "on" bit positions, so the cosine distance between any two
// fixtures is exactly predictable by hand -- used across
// lib/photo-clustering.test.ts, components/PhotoGrid.test.tsx,
// hooks/useClusteredPhotos.test.ts, and components/PhotoUploadPage.test.tsx.

/** Inclusive range of integers, e.g. range(10, 12) -> [10, 11, 12]. */
export function range(start: number, end: number): number[] {
  const out: number[] = []
  for (let i = start; i <= end; i++) out.push(i)
  return out
}

/**
 * Returns a `hashFromPositions(positions)` function that builds a hex hash
 * string of `totalBits` bits, with a 1 at each given position and 0
 * elsewhere. Parameterized by bit count since different test suites
 * exercise different hash widths (lib/photo-clustering.test.ts's 256-bit
 * width, matching lib/perceptual-hash.ts's real 16x16 dHash grid, vs. the
 * smaller 128-bit fixtures used elsewhere purely for distance math).
 */
export function makeHashFromPositions(totalBits: number): (positions: number[]) => string {
  return (positions: number[]) => {
    const bits = new Array(totalBits).fill(0)
    for (const position of positions) bits[position] = 1
    let hex = ''
    for (let i = 0; i < bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4).join(''), 2).toString(16)
    }
    return hex
  }
}
