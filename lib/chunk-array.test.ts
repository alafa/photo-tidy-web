import { describe, it, expect } from 'vitest'
import { chunkArray } from './chunk-array'

describe('chunkArray', () => {
  it('splits an array evenly when size divides the length', () => {
    expect(chunkArray([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]])
  })

  it('puts the remainder in a final, smaller chunk', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns an empty array for an empty input', () => {
    expect(chunkArray([], 3)).toEqual([])
  })
})
