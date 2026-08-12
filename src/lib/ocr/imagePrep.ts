/**
 * Image preparation for OCR.
 *
 * Tesseract is trained on clean, ~300dpi black-on-white text. A phone photo of
 * a book page is none of those things: it is huge, slightly grey, unevenly lit,
 * and often carries an EXIF rotation flag. Three cheap canvas operations buy a
 * large accuracy improvement before we hand anything to the recogniser.
 */

/** Long edge we resize to. ~2000px keeps body text near 300dpi-equivalent. */
const TARGET_LONG_EDGE = 2000;
/** Photos smaller than this get upscaled — Tesseract does badly on tiny text. */
const MIN_LONG_EDGE = 1000;

export interface PreparedImage {
  canvas: HTMLCanvasElement;
  /** Small JPEG data URL for the library thumbnail. */
  thumbnail: string;
  width: number;
  height: number;
}

/**
 * Decode a File/Blob, honouring the EXIF orientation that phone cameras set.
 * Without `imageOrientation: 'from-image'` a portrait photo arrives sideways
 * and OCR returns gibberish.
 */
async function decode(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file, { imageOrientation: 'from-image' });
}

/**
 * Grayscale + contrast stretch, in place on the canvas.
 *
 * We compute a luminance histogram, find the 2nd and 98th percentiles, and map
 * that range onto 0-255. On a photo where the paper reads as #c8c8c8 and the
 * ink as #3c3c3c this restores something close to true black on white, which
 * is what the recogniser's binarisation expects. Percentiles (rather than
 * min/max) make it robust to a dark shadow in one corner or a specular
 * highlight from a lamp.
 */
function enhance(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const img = ctx.getImageData(0, 0, w, h);
  const px = img.data;

  const histogram = new Uint32Array(256);
  for (let i = 0; i < px.length; i += 4) {
    // Rec. 601 luma — good enough and integer-cheap.
    const y = (px[i] * 77 + px[i + 1] * 150 + px[i + 2] * 29) >> 8;
    px[i] = px[i + 1] = px[i + 2] = y;
    histogram[y]++;
  }

  const total = w * h;
  const lowCut = total * 0.02;
  const highCut = total * 0.98;
  let acc = 0;
  let lo = 0;
  let hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += histogram[v];
    if (acc <= lowCut) lo = v;
    if (acc <= highCut) hi = v;
  }
  // A flat image (blank page, or already binarised) would divide by ~0.
  const span = Math.max(24, hi - lo);

  // Precompute the mapping so the per-pixel loop stays a table lookup.
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.max(0, Math.min(255, ((v - lo) * 255) / span));
  }
  for (let i = 0; i < px.length; i += 4) {
    const y = lut[px[i]];
    px[i] = px[i + 1] = px[i + 2] = y;
  }

  ctx.putImageData(img, 0, 0);
}

/** Decode, right-size, and enhance an image for OCR. */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const bitmap = await decode(file);
  const longEdge = Math.max(bitmap.width, bitmap.height);
  const scale =
    longEdge > TARGET_LONG_EDGE
      ? TARGET_LONG_EDGE / longEdge
      : longEdge < MIN_LONG_EDGE
        ? MIN_LONG_EDGE / longEdge
        : 1;

  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.');

  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const thumbnail = makeThumbnail(canvas);
  enhance(ctx, width, height);

  return { canvas, thumbnail, width, height };
}

/** 240px-wide JPEG data URL, taken before the contrast stretch so it looks natural. */
export function makeThumbnail(source: HTMLCanvasElement, targetWidth = 240): string {
  const scale = targetWidth / source.width;
  const c = document.createElement('canvas');
  c.width = targetWidth;
  c.height = Math.max(1, Math.round(source.height * scale));
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.6);
}
