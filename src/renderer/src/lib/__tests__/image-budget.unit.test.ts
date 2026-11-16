import { describe, expect, it } from 'vitest'
import {
  IMAGE_MAX_RAW_BYTES,
  base64DecodedBytes,
  fitWithinMaxDimension,
  imageFitsBudget
} from '../image-budget'

describe('image budget (cli.js limits)', () => {
  it('passes an image within 2000 px and 3.75 MiB through', () => {
    expect(imageFitsBudget(2000, 2000, IMAGE_MAX_RAW_BYTES)).toBe(true)
  })

  it('re-encodes past either bound: the old 2048 px / 4 MiB passthrough no longer fits', () => {
    expect(imageFitsBudget(2048, 1004, 1_000_000)).toBe(false)
    expect(imageFitsBudget(1600, 900, IMAGE_MAX_RAW_BYTES + 1)).toBe(false)
    expect(imageFitsBudget(1600, 900, 4 * 1024 * 1024)).toBe(false)
  })

  it('a passthrough image stays under the engine base64 cap (5 MiB)', () => {
    expect(Math.ceil(IMAGE_MAX_RAW_BYTES / 3) * 4).toBeLessThanOrEqual(5_242_880)
  })

  it('scales down to fit the long side, keeping aspect, never up', () => {
    expect(fitWithinMaxDimension(4000, 2000)).toEqual({ width: 2000, height: 1000 })
    expect(fitWithinMaxDimension(1000, 3000)).toEqual({ width: 667, height: 2000 })
    expect(fitWithinMaxDimension(800, 600)).toEqual({ width: 800, height: 600 })
  })

  it('measures decoded bytes from base64, padding included', () => {
    expect(base64DecodedBytes(btoa('abc'))).toBe(3)
    expect(base64DecodedBytes(btoa('abcd'))).toBe(4)
    expect(base64DecodedBytes(btoa('abcde'))).toBe(5)
  })
})
