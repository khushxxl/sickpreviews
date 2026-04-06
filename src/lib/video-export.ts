import { Point, computeInverseHomography, warpImage } from "./homography";

export interface VideoExportOptions {
  video: HTMLVideoElement;
  bgImage: HTMLImageElement;
  corners: [Point, Point, Point, Point];
  opacity: number;
  roundedCorners: boolean;
  cropRegion: { sx: number; sy: number; sw: number; sh: number };
  bgColor: string | null;
  aspectRatio: number | null;
  fps?: number;
  minWidth?: number;
  onProgress: (pct: number) => void;
  signal?: AbortSignal;
}

/**
 * Export video using CPU warp (same as preview) + MediaRecorder.
 * Plays the video in real-time on a hidden canvas to get correct timing.
 */
export async function exportVideo(
  options: VideoExportOptions,
): Promise<Blob> {
  const {
    video,
    bgImage,
    corners,
    opacity,
    roundedCorners,
    cropRegion,
    bgColor,
    aspectRatio,
    onProgress,
    signal,
  } = options;

  const { sx: csx, sy: csy, sw: csw, sh: csh } = cropRegion;
  const minWidth = options.minWidth ?? 1760;
  const exportScale = csw < minWidth ? minWidth / csw : 1;
  let frameW = csw;
  let frameH = csh;
  if (aspectRatio) {
    if (csw / csh > aspectRatio) {
      frameH = csw / aspectRatio;
    } else {
      frameW = csh * aspectRatio;
    }
  }
  const iw = Math.round(frameW * exportScale) & ~1;
  const ih = Math.round(frameH * exportScale) & ~1;
  const imgW = Math.round(csw * exportScale) & ~1;
  const imgH = Math.round(csh * exportScale) & ~1;
  const imgX = (iw - imgW) / 2;
  const imgY = (ih - imgH) / 2;

  // Create output canvas
  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = iw;
  outputCanvas.height = ih;
  const ctx = outputCanvas.getContext("2d")!;

  // Pre-render the background at export resolution
  const bgCanvas = document.createElement("canvas");
  bgCanvas.width = imgW;
  bgCanvas.height = imgH;
  const bgCtx = bgCanvas.getContext("2d")!;
  bgCtx.drawImage(bgImage, csx, csy, csw, csh, 0, 0, imgW, imgH);
  const bgData = bgCtx.getImageData(0, 0, imgW, imgH);

  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  const duration = video.duration;

  // Set up MediaRecorder with real-time playback
  const stream = outputCanvas.captureStream();
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 8_000_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const exportDone = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (e) => reject(e);
  });

  // Prepare warp constants
  const hiResScale = exportScale;
  const srcCorners: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: srcW - 1, y: 0 },
    { x: srcW - 1, y: srcH - 1 },
    { x: 0, y: srcH - 1 },
  ];
  const exportCorners = corners.map((p) => ({
    x: (p.x - csx) * hiResScale,
    y: (p.y - csy) * hiResScale,
  })) as [Point, Point, Point, Point];
  const invH = computeInverseHomography(srcCorners, exportCorners);
  const radius = roundedCorners ? Math.min(srcW, srcH) * 0.12 : 0;

  // Temp canvas for extracting video frames
  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  const srcCtx = srcCanvas.getContext("2d")!;

  // Render function for each frame
  function renderCurrentFrame() {
    // Draw video frame to source canvas
    srcCtx.clearRect(0, 0, srcW, srcH);
    if (radius > 0) {
      srcCtx.save();
      srcCtx.beginPath();
      srcCtx.roundRect(0, 0, srcW, srcH, radius);
      srcCtx.clip();
    }
    srcCtx.drawImage(video, 0, 0, srcW, srcH);
    if (radius > 0) srcCtx.restore();
    const srcData = srcCtx.getImageData(0, 0, srcW, srcH);

    // Clone bg data (warpImage modifies in place)
    const frameData = new ImageData(
      new Uint8ClampedArray(bgData.data),
      imgW,
      imgH,
    );

    // CPU warp
    warpImage(frameData.data, srcData.data, invH, exportCorners, srcW, srcH, imgW, imgH, opacity);

    // Composite onto output canvas
    if (bgColor) {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, iw, ih);
    } else {
      ctx.clearRect(0, 0, iw, ih);
    }

    // Put warped frame onto a temp canvas, then draw to output
    bgCtx.putImageData(frameData, 0, 0);
    ctx.drawImage(bgCanvas, imgX, imgY, imgW, imgH);
  }

  // Play video from start and record in real-time
  video.currentTime = 0;
  video.muted = true;

  await new Promise<void>((resolve) => {
    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked);
  });

  recorder.start();
  video.play();

  // RAF loop — render each frame in real-time
  await new Promise<void>((resolve) => {
    let lastProgress = 0;

    function tick() {
      if (signal?.aborted) {
        video.pause();
        recorder.stop();
        resolve();
        return;
      }

      if (video.ended || video.currentTime >= duration - 0.05) {
        // Final frame
        renderCurrentFrame();
        video.pause();
        recorder.stop();
        onProgress(100);
        resolve();
        return;
      }

      renderCurrentFrame();

      // Update progress
      const pct = Math.round((video.currentTime / duration) * 100);
      if (pct !== lastProgress) {
        lastProgress = pct;
        onProgress(pct);
      }

      requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
  });

  // Skip download if cancelled
  if (signal?.aborted) return new Blob();

  const blob = await exportDone;

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.download = "sickpreviews-export.webm";
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);

  return blob;
}
