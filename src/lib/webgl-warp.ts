import { Point, computeInverseHomography } from "./homography";

// ── Shader sources ──────────────────────────────────────────────

const BG_VERTEX = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const BG_FRAGMENT = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_bgTex;
uniform vec4 u_cropUV; // x=uMin, y=vMin, z=uRange, w=vRange
void main() {
  vec2 uv = vec2(u_cropUV.x + v_uv.x * u_cropUV.z,
                 u_cropUV.y + v_uv.y * u_cropUV.w);
  gl_FragColor = texture2D(u_bgTex, uv);
}`;

const WARP_VERTEX = `
attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

// Fragment shader: inverse homography mapping with rounded corners
const WARP_FRAGMENT = `
precision highp float;

uniform sampler2D u_srcTex;
uniform vec2 u_resolution;   // output canvas size
uniform vec2 u_srcSize;      // source image size in pixels
uniform mat3 u_invH;         // inverse homography (dst->src)
uniform float u_opacity;
uniform bool u_roundedCorners;
// Quad corners for point-in-quad test (in output pixel coords, top-left origin)
uniform vec2 u_corners[4];

float crossSign(vec2 a, vec2 b, vec2 p) {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

bool isInsideQuad(vec2 p) {
  float c0 = crossSign(u_corners[0], u_corners[1], p);
  float c1 = crossSign(u_corners[1], u_corners[2], p);
  float c2 = crossSign(u_corners[2], u_corners[3], p);
  float c3 = crossSign(u_corners[3], u_corners[0], p);
  bool allPos = (c0 > 0.0) && (c1 > 0.0) && (c2 > 0.0) && (c3 > 0.0);
  bool allNeg = (c0 < 0.0) && (c1 < 0.0) && (c2 < 0.0) && (c3 < 0.0);
  return allPos || allNeg;
}

float roundedRectSDF(vec2 p, vec2 halfSize, float r) {
  vec2 d = abs(p) - halfSize + vec2(r);
  return length(max(d, 0.0)) - r;
}

void main() {
  // Convert gl_FragCoord to top-left origin pixel coords
  vec2 px = vec2(gl_FragCoord.x, u_resolution.y - gl_FragCoord.y);

  if (!isInsideQuad(px)) {
    discard;
  }

  // Apply inverse homography: output pixel -> source pixel
  vec3 sp = u_invH * vec3(px, 1.0);
  vec2 srcPx = sp.xy / sp.z;

  // Bounds check
  if (srcPx.x < 0.0 || srcPx.x >= u_srcSize.x - 1.0 ||
      srcPx.y < 0.0 || srcPx.y >= u_srcSize.y - 1.0) {
    discard;
  }

  // Rounded corners mask
  float alpha = 1.0;
  if (u_roundedCorners) {
    float radius = min(u_srcSize.x, u_srcSize.y) * 0.12;
    vec2 center = u_srcSize * 0.5;
    vec2 halfSize = u_srcSize * 0.5;
    float d = roundedRectSDF(srcPx - center, halfSize, radius);
    alpha = 1.0 - smoothstep(-1.0, 1.0, d);
    if (alpha <= 0.0) discard;
  }

  // FLIP_Y=true flips texture storage; flip V back for correct sampling
  vec2 uv = vec2(srcPx.x / u_srcSize.x, 1.0 - srcPx.y / u_srcSize.y);
  vec4 color = texture2D(u_srcTex, uv);

  color.a *= u_opacity * alpha;
  gl_FragColor = color;
}`;

// ── Types ───────────────────────────────────────────────────────

export interface WebGLWarpContext {
  gl: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  bgProgram: WebGLProgram;
  warpProgram: WebGLProgram;
  bgTexture: WebGLTexture;
  srcTexture: WebGLTexture;
  quadBuffer: WebGLBuffer;
  bgUniforms: Record<string, WebGLUniformLocation>;
  warpUniforms: Record<string, WebGLUniformLocation>;
  destroy(): void;
}

// ── Helpers ─────────────────────────────────────────────────────

function compileShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error("Shader compile error: " + info);
  }
  return shader;
}

function createProgram(
  gl: WebGLRenderingContext,
  vs: string,
  fs: string,
): WebGLProgram {
  const program = gl.createProgram()!;
  gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error("Program link error: " + info);
  }
  return program;
}

function getUniforms(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  names: string[],
): Record<string, WebGLUniformLocation> {
  const map: Record<string, WebGLUniformLocation> = {};
  for (const name of names) {
    const loc = gl.getUniformLocation(program, name);
    if (loc !== null) map[name] = loc;
  }
  return map;
}

function createTexture(gl: WebGLRenderingContext): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

// ── Public API ──────────────────────────────────────────────────

export function createWarpContext(
  width: number,
  height: number,
): WebGLWarpContext | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    antialias: false,
  });
  if (!gl) return null;

  // Don't flip globally — handle per-texture in shaders

  const quadBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  // prettier-ignore
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  1, -1,  -1, 1,
    -1,  1,  1, -1,   1, 1,
  ]), gl.STATIC_DRAW);

  const bgProgram = createProgram(gl, BG_VERTEX, BG_FRAGMENT);
  const bgUniforms = getUniforms(gl, bgProgram, ["u_bgTex", "u_cropUV"]);

  const warpProgram = createProgram(gl, WARP_VERTEX, WARP_FRAGMENT);
  const warpUniforms = getUniforms(gl, warpProgram, [
    "u_srcTex",
    "u_resolution",
    "u_srcSize",
    "u_invH",
    "u_opacity",
    "u_roundedCorners",
    "u_corners[0]",
    "u_corners[1]",
    "u_corners[2]",
    "u_corners[3]",
  ]);

  const bgTexture = createTexture(gl);
  const srcTexture = createTexture(gl);

  const ctx: WebGLWarpContext = {
    gl,
    canvas,
    bgProgram,
    warpProgram,
    bgTexture,
    srcTexture,
    quadBuffer,
    bgUniforms,
    warpUniforms,
    destroy() {
      gl.deleteTexture(bgTexture);
      gl.deleteTexture(srcTexture);
      gl.deleteBuffer(quadBuffer);
      gl.deleteProgram(bgProgram);
      gl.deleteProgram(warpProgram);
      const ext = gl.getExtension("WEBGL_lose_context");
      if (ext) ext.loseContext();
    },
  };

  return ctx;
}

export function updateBackgroundTexture(
  ctx: WebGLWarpContext,
  image: HTMLImageElement,
): void {
  const { gl, bgTexture } = ctx;
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.bindTexture(gl.TEXTURE_2D, bgTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
}

export function updateSourceTexture(
  ctx: WebGLWarpContext,
  source: TexImageSource,
): void {
  const { gl, srcTexture } = ctx;
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.bindTexture(gl.TEXTURE_2D, srcTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

export function renderFrame(
  ctx: WebGLWarpContext,
  corners: [Point, Point, Point, Point],
  srcSize: { w: number; h: number },
  outputSize: { w: number; h: number },
  opacity: number,
  roundedCorners: boolean,
  cropRegion: { sx: number; sy: number; sw: number; sh: number },
  bgNaturalSize: { w: number; h: number },
  bgColor: string | null,
): void {
  const { gl, canvas, bgProgram, warpProgram, quadBuffer, bgUniforms, warpUniforms } = ctx;

  // Resize canvas if needed
  if (canvas.width !== outputSize.w || canvas.height !== outputSize.h) {
    canvas.width = outputSize.w;
    canvas.height = outputSize.h;
  }
  gl.viewport(0, 0, outputSize.w, outputSize.h);

  // Clear with background color
  if (bgColor) {
    const r = parseInt(bgColor.slice(1, 3), 16) / 255;
    const g = parseInt(bgColor.slice(3, 5), 16) / 255;
    const b = parseInt(bgColor.slice(5, 7), 16) / 255;
    gl.clearColor(r, g, b, 1);
  } else {
    gl.clearColor(0, 0, 0, 0);
  }
  gl.clear(gl.COLOR_BUFFER_BIT);

  // ── Pass 1: Draw background ──
  gl.useProgram(bgProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  const bgPosLoc = gl.getAttribLocation(bgProgram, "a_position");
  gl.enableVertexAttribArray(bgPosLoc);
  gl.vertexAttribPointer(bgPosLoc, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, ctx.bgTexture);
  gl.uniform1i(bgUniforms["u_bgTex"], 0);

  // Crop UV: map the visible crop region to UV coordinates
  const uMin = cropRegion.sx / bgNaturalSize.w;
  const vMin = cropRegion.sy / bgNaturalSize.h;
  const uRange = cropRegion.sw / bgNaturalSize.w;
  const vRange = cropRegion.sh / bgNaturalSize.h;
  gl.uniform4f(bgUniforms["u_cropUV"], uMin, vMin, uRange, vRange);

  gl.disable(gl.BLEND);
  gl.drawArrays(gl.TRIANGLES, 0, 6);

  // ── Pass 2: Draw warped source ──
  gl.useProgram(warpProgram);
  const warpPosLoc = gl.getAttribLocation(warpProgram, "a_position");
  gl.enableVertexAttribArray(warpPosLoc);
  gl.vertexAttribPointer(warpPosLoc, 2, gl.FLOAT, false, 0, 0);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, ctx.srcTexture);
  gl.uniform1i(warpUniforms["u_srcTex"], 0);

  gl.uniform2f(warpUniforms["u_resolution"], outputSize.w, outputSize.h);
  gl.uniform2f(warpUniforms["u_srcSize"], srcSize.w, srcSize.h);
  gl.uniform1f(warpUniforms["u_opacity"], opacity);
  gl.uniform1i(warpUniforms["u_roundedCorners"], roundedCorners ? 1 : 0);

  // Transform corners from bg image coords to output pixel coords
  const adjustedCorners = corners.map((p) => ({
    x: ((p.x - cropRegion.sx) / cropRegion.sw) * outputSize.w,
    y: ((p.y - cropRegion.sy) / cropRegion.sh) * outputSize.h,
  }));
  for (let i = 0; i < 4; i++) {
    gl.uniform2f(
      warpUniforms[`u_corners[${i}]`],
      adjustedCorners[i].x,
      adjustedCorners[i].y,
    );
  }

  // Compute inverse homography in output pixel space
  const srcCorners: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: srcSize.w - 1, y: 0 },
    { x: srcSize.w - 1, y: srcSize.h - 1 },
    { x: 0, y: srcSize.h - 1 },
  ];
  const dstCorners = adjustedCorners as [Point, Point, Point, Point];
  const invH = computeInverseHomography(srcCorners, dstCorners);

  // Upload as mat3 (column-major for GLSL)
  gl.uniformMatrix3fv(
    warpUniforms["u_invH"],
    false,
    new Float32Array([
      invH[0], invH[3], invH[6],
      invH[1], invH[4], invH[7],
      invH[2], invH[5], invH[8],
    ]),
  );

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  gl.disable(gl.BLEND);
}
