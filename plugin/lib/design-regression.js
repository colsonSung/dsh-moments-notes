/**
 * Comparing two pictures of the same board.
 *
 * A design change is judged by eye, and the eye is generous: a box that moved
 * two pixels looks the same, and a colour that shifted slightly looks the
 * same. A picture that is meant to be identical has to be identical.
 *
 * This compares two images the way a person would want them compared: how
 * much of the picture changed, and where.
 *
 * The measure is the structural similarity index, the same one desigma's
 * desigma-diff uses: a local mean and variance of the luminance in every
 * window, compared between the two pictures. A window that holds the same
 * structure scores high even when the pixels are not identical, which is what
 * keeps an antialiasing difference from reading as a change.
 */

/** The size of the window the structure is measured in. */
export const SSIM_WINDOW = 8;

/**
 * Read an image into its pixels.
 *
 * The picture is decoded by the browser when it is available; a caller that
 * has the pixels already can pass them in.
 */
export async function readPixels(source) {
  if (source && typeof source === 'object' && source.width && source.data) return source;
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    throw new Error('Reading pixels needs a browser');
  }
  const image = source instanceof Image ? source : await loadImage(source);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, canvas.width, canvas.height);
}

/** Load a picture into an image element. */
function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The picture could not be read'));
    image.src = source;
  });
}

/** The luminance of a pixel, in the 0..255 range the index is defined on. */
function luminance(data, index) {
  // The usual weights: the eye is most sensitive to green.
  return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
}

/**
 * The structural similarity index of two pictures of the same size.
 *
 * Returns the mean score over every window: 1 means the same structure, 0
 * means nothing alike.
 */
export function ssim(first, second, options = {}) {
  const window = options.window || SSIM_WINDOW;
  const width = Math.min(first.width, second.width);
  const height = Math.min(first.height, second.height);
  if (!width || !height) return 0;

  // The luminance of every pixel, in one array each.
  const a = new Float64Array(width * height);
  const b = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * first.width + x) * 4;
      a[y * width + x] = luminance(first.data, index);
      b[y * width + x] = luminance(second.data, index);
    }
  }

  const total = window * window;
  // The constants of the index: they make a score of 1 mean "the same".
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;

  let sum = 0;
  let count = 0;
  for (let y = 0; y + window <= height; y += 1) {
    for (let x = 0; x + window <= width; x += 1) {
      let meanA = 0;
      let meanB = 0;
      for (let dy = 0; dy < window; dy += 1) {
        for (let dx = 0; dx < window; dx += 1) {
          meanA += a[(y + dy) * width + x + dx];
          meanB += b[(y + dy) * width + x + dx];
        }
      }
      meanA /= total;
      meanB /= total;
      let varA = 0;
      let varB = 0;
      let covariance = 0;
      for (let dy = 0; dy < window; dy += 1) {
        for (let dx = 0; dx < window; dx += 1) {
          const da = a[(y + dy) * width + x + dx] - meanA;
          const db = b[(y + dy) * width + x + dx] - meanB;
          varA += da * da;
          varB += db * db;
          covariance += da * db;
        }
      }
      varA /= total - 1;
      varB /= total - 1;
      covariance /= total - 1;
      const numerator = (2 * meanA * meanB + c1) * (2 * covariance + c2);
      const denominator = (meanA ** 2 + meanB ** 2 + c1) * (varA + varB + c2);
      sum += denominator ? numerator / denominator : 1;
      count += 1;
    }
  }
  return count ? sum / count : 0;
}

/**
 * Where two pictures differ.
 *
 * A picture of the differences, at the size of the two: every pixel that
 * changed is marked, so a person can see what moved rather than read a
 * number.
 */
export function differenceImage(first, second) {
  const width = Math.min(first.width, second.width);
  const height = Math.min(first.height, second.height);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * first.width + x) * 4;
      const outIndex = (y * width + x) * 4;
      const delta = Math.abs(
        luminance(first.data, index) - luminance(second.data, index),
      );
      // A change that is invisible is not worth marking.
      const marked = delta > 8;
      out[outIndex] = marked ? 220 : 255;
      out[outIndex + 1] = marked ? 30 : 255;
      out[outIndex + 2] = marked ? 30 : 255;
      out[outIndex + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/**
 * How much of the picture changed.
 *
 * The share of pixels that differ by more than the eye would notice. A board
 * that was re-imported whole has a large share; a board that only moved a
 * label has a small one.
 */
export function changedShare(first, second, threshold = 8) {
  const width = Math.min(first.width, second.width);
  const height = Math.min(first.height, second.height);
  if (!width || !height) return 1;
  let changed = 0;
  let total = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * first.width + x) * 4;
      const delta = Math.abs(
        luminance(first.data, index) - luminance(second.data, index),
      );
      if (delta > threshold) changed += 1;
      total += 1;
    }
  }
  return total ? changed / total : 0;
}

/**
 * Compare two pictures of a board.
 *
 * The answer is what a person would say: the same, close, or different, with
 * the number behind it and a picture of what changed.
 */
export function comparePictures(first, second, options = {}) {
  const score = ssim(first, second, options);
  const changed = changedShare(first, second, options.threshold);
  const threshold = options.threshold ?? 0.995;
  return {
    score,
    changed,
    same: score >= threshold && changed < (options.changedLimit ?? 0.001),
    verdict: score >= threshold && changed < (options.changedLimit ?? 0.001)
      ? 'the same'
      : score >= 0.98
        ? 'close'
        : 'different',
    difference: differenceImage(first, second),
  };
}
