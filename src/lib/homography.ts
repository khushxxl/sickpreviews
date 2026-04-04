// Perspective transform using homography matrix
// Maps 4 source points to 4 destination points via a 3x3 projective matrix

export type Point = { x: number; y: number };

/**
 * Compute the 3x3 homography matrix that maps src points to dst points.
 * Uses Direct Linear Transform (DLT) solving an 8x8 system.
 *
 * src: 4 corner points from the screenshot (unit square or image corners)
 * dst: 4 corner points on the canvas (the user-defined quad)
 */
export function computeHomography(
  src: [Point, Point, Point, Point],
  dst: [Point, Point, Point, Point]
): number[] {
  // Build the 8x9 matrix A for Ah=0, then solve the 8x8 system
  // h = [h0..h8], H = [[h0,h1,h2],[h3,h4,h5],[h6,h7,h8]], h8=1

  // We set h8 = 1 and solve the 8x8 linear system
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const sx = src[i].x,
      sy = src[i].y;
    const dx = dst[i].x,
      dy = dst[i].y;

    A.push([sx, sy, 1, 0, 0, 0, -dx * sx, -dx * sy]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy * sx, -dy * sy]);
    b.push(dy);
  }

  const h = solveLinearSystem(A, b);
  // H matrix: [h0,h1,h2, h3,h4,h5, h6,h7, 1]
  return [...h, 1];
}

/**
 * Compute the inverse homography (dst -> src mapping).
 * For each pixel in the destination, find corresponding source pixel.
 */
export function computeInverseHomography(
  src: [Point, Point, Point, Point],
  dst: [Point, Point, Point, Point]
): number[] {
  return computeHomography(dst, src);
}

/**
 * Apply homography to a single point.
 * H is a flat 9-element array [h0..h8].
 */
export function applyHomography(H: number[], p: Point): Point {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  };
}

/**
 * Warp the source image onto the destination canvas using inverse mapping
 * with bilinear interpolation.
 *
 * bgData: background image data (will be modified in-place)
 * srcData: source screenshot image data
 * invH: inverse homography matrix (dst -> src)
 * dstBounds: bounding box of the destination quad to limit iteration
 * srcW, srcH: dimensions of the source image
 * bgW, bgH: dimensions of the background/canvas
 * opacity: 0-1 opacity of the warped image
 */
export function warpImage(
  bgData: Uint8ClampedArray,
  srcData: Uint8ClampedArray,
  invH: number[],
  dstCorners: [Point, Point, Point, Point],
  srcW: number,
  srcH: number,
  bgW: number,
  bgH: number,
  opacity: number
): void {
  // Compute bounding box of destination quad
  const xs = dstCorners.map((p) => p.x);
  const ys = dstCorners.map((p) => p.y);
  const minX = Math.max(0, Math.floor(Math.min(...xs)));
  const maxX = Math.min(bgW - 1, Math.ceil(Math.max(...xs)));
  const minY = Math.max(0, Math.floor(Math.min(...ys)));
  const maxY = Math.min(bgH - 1, Math.ceil(Math.max(...ys)));

  for (let dy = minY; dy <= maxY; dy++) {
    for (let dx = minX; dx <= maxX; dx++) {
      // Check if point is inside the quad using cross product winding
      if (!isInsideQuad(dx, dy, dstCorners)) continue;

      // Map destination pixel to source coordinates
      const sp = applyHomography(invH, { x: dx, y: dy });

      // Check bounds
      if (sp.x < 0 || sp.x >= srcW - 1 || sp.y < 0 || sp.y >= srcH - 1)
        continue;

      // Bilinear interpolation
      const fx = Math.floor(sp.x);
      const fy = Math.floor(sp.y);
      const ax = sp.x - fx;
      const ay = sp.y - fy;

      const i00 = (fy * srcW + fx) * 4;
      const i10 = (fy * srcW + fx + 1) * 4;
      const i01 = ((fy + 1) * srcW + fx) * 4;
      const i11 = ((fy + 1) * srcW + fx + 1) * 4;

      const dstIdx = (dy * bgW + dx) * 4;

      for (let c = 0; c < 4; c++) {
        const val =
          srcData[i00 + c] * (1 - ax) * (1 - ay) +
          srcData[i10 + c] * ax * (1 - ay) +
          srcData[i01 + c] * (1 - ax) * ay +
          srcData[i11 + c] * ax * ay;

        if (c < 3) {
          // RGB: alpha-blend with background
          const srcAlpha = (opacity * val) / 255;
          bgData[dstIdx + c] =
            val * srcAlpha + bgData[dstIdx + c] * (1 - srcAlpha);
        } else {
          // Alpha channel
          bgData[dstIdx + c] = Math.min(
            255,
            val * opacity + bgData[dstIdx + c] * (1 - opacity)
          );
        }
      }
    }
  }
}

/** Check if point (px,py) is inside a convex quad defined by 4 corners (CW or CCW) */
function isInsideQuad(
  px: number,
  py: number,
  corners: [Point, Point, Point, Point]
): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
    if (cross !== 0) {
      if (sign === 0) sign = cross > 0 ? 1 : -1;
      else if ((cross > 0 ? 1 : -1) !== sign) return false;
    }
  }
  return true;
}

/** Solve 8x8 linear system Ax = b using Gaussian elimination with partial pivoting */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = A.length;
  // Augmented matrix
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    // Find pivot
    let maxVal = Math.abs(M[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > maxVal) {
        maxVal = Math.abs(M[row][col]);
        maxRow = row;
      }
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];

    // Eliminate below
    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / M[col][col];
      for (let j = col; j <= n; j++) {
        M[row][j] -= factor * M[col][j];
      }
    }
  }

  // Back substitution
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    x[i] = M[i][n];
    for (let j = i + 1; j < n; j++) {
      x[i] -= M[i][j] * x[j];
    }
    x[i] /= M[i][i];
  }
  return x;
}
