/**
 * The image budget an attachment is held to before it is sent, on every
 * transport. The numbers are Claude Code's own (cli.js
 * `{maxWidth:2000,maxHeight:2000,maxBase64Size:5242880,targetRawSize:3932160}`):
 * at most 2000 px a side and 3.75 MiB raw, which is 5 MiB once base64-encoded —
 * an image over that is refused by the engine, not merely slow.
 *
 * Re-encoding keeps the quality high on purpose: the model has to read fine
 * detail (screenshot text), and most of the saving comes from PNG -> JPEG, not
 * from the quality setting.
 */
export const IMAGE_MAX_DIMENSION = 2000
export const IMAGE_MAX_RAW_BYTES = 3_932_160
/** Tried in order; the last one is used even if still over budget (never lower). */
export const IMAGE_JPEG_QUALITIES = [0.9, 0.85] as const

/** True when the image is sent as-is: within both the size and the byte budget. */
export function imageFitsBudget(width: number, height: number, bytes: number): boolean {
  return (
    width <= IMAGE_MAX_DIMENSION && height <= IMAGE_MAX_DIMENSION && bytes <= IMAGE_MAX_RAW_BYTES
  )
}

/** The size to draw at: scaled down to fit {@link IMAGE_MAX_DIMENSION}, never up. */
export function fitWithinMaxDimension(
  width: number,
  height: number
): { width: number; height: number } {
  const scale = Math.min(IMAGE_MAX_DIMENSION / width, IMAGE_MAX_DIMENSION / height, 1)
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/** Decoded byte length of a base64 payload (no data-URL prefix). */
export function base64DecodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}
