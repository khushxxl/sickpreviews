import { Point, computeInverseHomography, warpImage } from "./homography";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ffmpegInstance: any = null;

async function getFFmpeg() {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  const { FFmpeg } = await import("@ffmpeg/ffmpeg");
  const ffmpeg = new FFmpeg();
  await ffmpeg.load();
  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

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

  const outputCanvas = document.createElement("canvas");
  outputCanvas.width = iw;
  outputCanvas.height = ih;
  const ctx = outputCanvas.getContext("2d")!;

  const bgCanvas = document.createElement("canvas");
  bgCanvas.width = imgW;
  bgCanvas.height = imgH;
  const bgCtx = bgCanvas.getContext("2d")!;
  bgCtx.drawImage(bgImage, csx, csy, csw, csh, 0, 0, imgW, imgH);
  const bgData = bgCtx.getImageData(0, 0, imgW, imgH);

  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  const duration = video.duration;

  // MediaRecorder for real-time capture
  const stream = outputCanvas.captureStream();
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 10_000_000,
  });

  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const recordDone = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = (e) => reject(e);
  });

  // Warp constants
  const srcCorners: [Point, Point, Point, Point] = [
    { x: 0, y: 0 },
    { x: srcW - 1, y: 0 },
    { x: srcW - 1, y: srcH - 1 },
    { x: 0, y: srcH - 1 },
  ];
  const exportCorners = corners.map((p) => ({
    x: (p.x - csx) * exportScale,
    y: (p.y - csy) * exportScale,
  })) as [Point, Point, Point, Point];
  const invH = computeInverseHomography(srcCorners, exportCorners);
  const radius = roundedCorners ? Math.min(srcW, srcH) * 0.12 : 0;

  const srcCanvas = document.createElement("canvas");
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  const srcCtx = srcCanvas.getContext("2d")!;

  function renderCurrentFrame() {
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

    const frameData = new ImageData(
      new Uint8ClampedArray(bgData.data),
      imgW,
      imgH,
    );

    warpImage(frameData.data, srcData.data, invH, exportCorners, srcW, srcH, imgW, imgH, opacity);

    if (bgColor) {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, iw, ih);
    } else {
      ctx.clearRect(0, 0, iw, ih);
    }

    bgCtx.putImageData(frameData, 0, 0);
    ctx.drawImage(bgCanvas, imgX, imgY, imgW, imgH);
  }

  // Phase 1: Record real-time as WebM (50% of progress)
  onProgress(0);
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

  await new Promise<void>((resolve) => {
    function tick() {
      if (signal?.aborted) {
        video.pause();
        recorder.stop();
        resolve();
        return;
      }

      if (video.ended || video.currentTime >= duration - 0.05) {
        renderCurrentFrame();
        video.pause();
        recorder.stop();
        resolve();
        return;
      }

      renderCurrentFrame();

      const pct = Math.round((video.currentTime / duration) * 50);
      onProgress(pct);

      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  });

  if (signal?.aborted) return new Blob();

  const webmBlob = await recordDone;

  // Phase 2: Try converting WebM to MP4 with FFmpeg.wasm
  onProgress(55);

  let finalBlob: Blob = webmBlob;
  let ext = "webm";

  // Check if SharedArrayBuffer is available (required for FFmpeg.wasm)
  const hasSharedArrayBuffer = typeof SharedArrayBuffer !== "undefined";

  if (hasSharedArrayBuffer) {
    try {
      const ffmpeg = await getFFmpeg();
      onProgress(60);

      const { fetchFile } = await import("@ffmpeg/util");
      await ffmpeg.writeFile("input.webm", await fetchFile(webmBlob));
      onProgress(65);

      // Race FFmpeg against a 60s timeout
      const conversionPromise = ffmpeg.exec([
        "-i", "input.webm",
        "-c:v", "libx264",
        "-preset", "ultrafast",
        "-crf", "22",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "output.mp4",
      ]);

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("FFmpeg timeout")), 60000),
      );

      await Promise.race([conversionPromise, timeoutPromise]);
      onProgress(90);

      const data = await ffmpeg.readFile("output.mp4");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      finalBlob = new Blob([data as any], { type: "video/mp4" });
      ext = "mp4";

      await ffmpeg.deleteFile("input.webm").catch(() => {});
      await ffmpeg.deleteFile("output.mp4").catch(() => {});
    } catch (err) {
      console.warn("MP4 conversion failed, exporting as WebM:", err);
    }
  }

  onProgress(100);

  // Download
  const url = URL.createObjectURL(finalBlob);
  const link = document.createElement("a");
  link.download = `sickpreviews-export.${ext}`;
  link.href = url;
  link.click();
  URL.revokeObjectURL(url);

  return finalBlob;
}
