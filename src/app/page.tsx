"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { Point, computeInverseHomography, warpImage } from "@/lib/homography";
import {
  createWarpContext,
  updateBackgroundTexture,
  WebGLWarpContext,
} from "@/lib/webgl-warp";
import { useVideoPlayer } from "@/lib/use-video-player";
import { exportVideo } from "@/lib/video-export";

const BUILT_IN_BACKGROUNDS = [
  {
    name: "Hand 1",
    src: "/bg-1-transparent.png",
    thumb: "/default-background.png",
    corners: [
      { x: 114, y: 80 },
      { x: 251, y: 96 },
      { x: 324, y: 426 },
      { x: 190, y: 432 },
    ] as [Point, Point, Point, Point],
  },
  {
    name: "Hand 2",
    src: "/bg-2-transparent.png",
    thumb: "/bg-2.png",
    corners: [
      { x: 134, y: 92 },
      { x: 293, y: 92 },
      { x: 290, y: 443 },
      { x: 137, y: 443 },
    ] as [Point, Point, Point, Point],
  },
  {
    name: "Hand 3",
    src: "/bg-3-transparent.png",
    thumb: "/bg-3-transparent.png",
    corners: [
      { x: 86, y: 57 },
      { x: 338, y: 57 },
      { x: 295, y: 483 },
      { x: 135, y: 483 },
    ] as [Point, Point, Point, Point],
  },
];

const BG_COLORS = [
  { name: "White", value: "#e8e8e8" },
  { name: "Black", value: "#111111" },
  { name: "Transparent", value: null },
];

const ASPECT_RATIOS = [
  { name: "Auto", value: null },
  { name: "1:1", value: 1 },
  { name: "4:5", value: 4 / 5 },
  { name: "9:16", value: 9 / 16 },
  { name: "16:9", value: 16 / 9 },
];

const HANDLE_RADIUS = 10;

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Draw a Dynamic Island pill at the top-center of the warped screen quad */
function drawNotch(
  ctx: CanvasRenderingContext2D,
  corners: [Point, Point, Point, Point],
) {
  const [tl, tr] = corners;
  const bl = corners[3];
  const topMidX = (tl.x + tr.x) / 2;
  const topMidY = (tl.y + tr.y) / 2;
  const screenW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const screenH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightX = (tr.x - tl.x) / screenW;
  const rightY = (tr.y - tl.y) / screenW;
  const downX = (bl.x - tl.x) / screenH;
  const downY = (bl.y - tl.y) / screenH;
  // Real Dynamic Island proportions: ~126x37pt on 393pt wide screen
  const pillW = screenW * 0.32;
  const pillH = screenH * 0.032;
  const offsetDown = screenH * 0.02;
  const cx = topMidX + downX * (offsetDown + pillH / 2);
  const cy = topMidY + downY * (offsetDown + pillH / 2);
  const hw = pillW / 2;
  const hh = pillH / 2;
  const r = hh;
  const angle = Math.atan2(rightY, rightX);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  // Subtle shadow for depth
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = hh * 0.8;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = hh * 0.15;

  // Main pill — deep black
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.roundRect(-hw, -hh, pillW, pillH, r);
  ctx.fill();

  // Reset shadow before highlight
  ctx.shadowColor = "transparent";

  // Subtle glossy highlight on top edge
  const grad = ctx.createLinearGradient(0, -hh, 0, hh * 0.2);
  grad.addColorStop(0, "rgba(255, 255, 255, 0.08)");
  grad.addColorStop(1, "rgba(255, 255, 255, 0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.roundRect(-hw, -hh, pillW, pillH, r);
  ctx.fill();

  ctx.restore();
}

export default function SickPreviews() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [screenImage, setScreenImage] = useState<HTMLImageElement | null>(null);
  const [corners, setCorners] = useState<[Point, Point, Point, Point]>(
    BUILT_IN_BACKGROUNDS[0].corners,
  );
  const [opacity, setOpacity] = useState(1);
  const [draggingIdx, setDraggingIdx] = useState<number | null>(null);
  const [canvasScale, setCanvasScale] = useState(1);
  const [canvasOffset, setCanvasOffset] = useState({ x: 0, y: 0 });
  const [bgNaturalSize, setBgNaturalSize] = useState({ w: 0, h: 0 });
  const [screenFileName, setScreenFileName] = useState("");
  const [activeBgIdx, setActiveBgIdx] = useState(0);
  const [screenRadius, setScreenRadius] = useState(true);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [showNotch, setShowNotch] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [bgColor, setBgColor] = useState<string | null>("#e8e8e8");
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [deviceZoom, setDeviceZoom] = useState(0);
  const [showIntro, setShowIntro] = useState(true);
  const [introText, setIntroText] = useState("");
  const [introFading, setIntroFading] = useState(false);
  const [alertMessage, setAlertMessage] = useState<string | null>(null);
  const [showVideoModal, setShowVideoModal] = useState(() => {
    if (typeof window !== "undefined") {
      return !localStorage.getItem("sickpreviews-video-modal-seen");
    }
    return false;
  });
  const [contentType, setContentType] = useState<"image" | "video">("image");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const exportAbortRef = useRef<AbortController | null>(null);
  const warpCtxRef = useRef<WebGLWarpContext | null>(null);
  const renderRef = useRef<() => void>(() => {});

  // Video player hook — use ref to avoid stale closure
  const onVideoFrame = useCallback(() => {
    renderRef.current();
  }, []);
  const videoPlayer = useVideoPlayer(videoUrl, onVideoFrame);

  // Initialize WebGL context for video rendering
  useEffect(() => {
    if (contentType === "video" && bgImage && !warpCtxRef.current) {
      const ctx = createWarpContext(
        bgImage.naturalWidth,
        bgImage.naturalHeight,
      );
      if (ctx) {
        updateBackgroundTexture(ctx, bgImage);
        warpCtxRef.current = ctx;
      }
    }
    return () => {
      // Cleanup on unmount
    };
  }, [contentType, bgImage]);

  // Update bg texture when bgImage changes
  useEffect(() => {
    if (warpCtxRef.current && bgImage) {
      updateBackgroundTexture(warpCtxRef.current, bgImage);
    }
  }, [bgImage]);

  // Typewriter intro effect
  useEffect(() => {
    const text = "sickpreviews.com";
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setIntroText(text.slice(0, i));
      if (i >= text.length) {
        clearInterval(interval);
        setTimeout(() => {
          setIntroFading(true);
          setTimeout(() => setShowIntro(false), 400);
        }, 500);
      }
    }, 50);
    return () => clearInterval(interval);
  }, []);

  const loadBgFromSrc = useCallback((src: string) => {
    const img = new Image();
    img.onload = () => {
      setBgImage(img);
      setBgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.src = src;
  }, []);

  useEffect(() => {
    loadBgFromSrc(BUILT_IN_BACKGROUNDS[0].src);
  }, [loadBgFromSrc]);

  // Compute crop region that interpolates from full image to device area
  const [cropRegion, setCropRegion] = useState({ sx: 0, sy: 0, sw: 1, sh: 1 });

  const updateCanvasSize = useCallback(() => {
    if (!containerRef.current || !bgImage) return;
    const container = containerRef.current;
    const pad = 80;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const iw = bgImage.naturalWidth;
    const ih = bgImage.naturalHeight;

    // Device bounding box in image coords with small margin
    const dxs = corners.map((p) => p.x);
    const dys = corners.map((p) => p.y);
    const margin = Math.min(iw, ih) * 0.05;
    const devX1 = Math.min(...dxs) - margin;
    const devY1 = Math.min(...dys) - margin;
    const devX2 = Math.max(...dxs) + margin;
    const devY2 = Math.max(...dys) + margin;
    const devCx = (devX1 + devX2) / 2;
    const devCy = (devY1 + devY2) / 2;
    const devW = devX2 - devX1;
    const devH = devY2 - devY1;

    // Interpolate crop region: full image → device area
    const cropW = iw + (devW - iw) * deviceZoom;
    const cropH = ih + (devH - ih) * deviceZoom;
    // Center interpolates from image center to device center
    const imgCx = iw / 2,
      imgCy = ih / 2;
    const cx = imgCx + (devCx - imgCx) * deviceZoom;
    const cy = imgCy + (devCy - imgCy) * deviceZoom;
    // Crop origin
    let sx = cx - cropW / 2;
    let sy = cy - cropH / 2;
    // Clamp
    sx = Math.max(0, Math.min(iw - cropW, sx));
    sy = Math.max(0, Math.min(ih - cropH, sy));

    setCropRegion({ sx, sy, sw: cropW, sh: cropH });

    // Scale: fit the cropped region into the canvas
    let frameW = cropW,
      frameH = cropH;
    if (aspectRatio) {
      // Expand frame to match aspect ratio
      if (cropW / cropH > aspectRatio) {
        frameH = cropW / aspectRatio;
      } else {
        frameW = cropH * aspectRatio;
      }
    }
    const scale = Math.min((cw - pad * 2) / frameW, (ch - pad * 2) / frameH);
    const displayW = frameW * scale;
    const displayH = frameH * scale;
    const ox = (cw - displayW) / 2;
    const oy = (ch - displayH) / 2;

    setCanvasScale(scale);
    setCanvasOffset({ x: ox, y: oy });
    const canvas = canvasRef.current;
    if (canvas) {
      canvas.width = cw;
      canvas.height = ch;
    }
  }, [bgImage, deviceZoom, corners, aspectRatio]);

  useEffect(() => {
    updateCanvasSize();
    window.addEventListener("resize", updateCanvasSize);
    return () => window.removeEventListener("resize", updateCanvasSize);
  }, [updateCanvasSize]);

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bgImage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const cw = canvas.width;
    const ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);

    const { sx: cropSx, sy: cropSy, sw: cropSw, sh: cropSh } = cropRegion;
    // Frame size (may be larger than crop if aspect ratio is set)
    let frameW = cropSw,
      frameH = cropSh;
    if (aspectRatio) {
      if (cropSw / cropSh > aspectRatio) {
        frameH = cropSw / aspectRatio;
      } else {
        frameW = cropSh * aspectRatio;
      }
    }
    const displayW = Math.round(frameW * canvasScale);
    const displayH = Math.round(frameH * canvasScale);
    // The bg image is centered within the frame
    const imgDisplayW = Math.round(cropSw * canvasScale);
    const imgDisplayH = Math.round(cropSh * canvasScale);
    const imgOffX = canvasOffset.x + (displayW - imgDisplayW) / 2;
    const imgOffY = canvasOffset.y + (displayH - imgDisplayH) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(canvasOffset.x, canvasOffset.y, displayW, displayH, 20);
    ctx.clip();

    // Draw background color or checkerboard
    if (bgColor) {
      ctx.fillStyle = bgColor;
      ctx.fillRect(canvasOffset.x, canvasOffset.y, displayW, displayH);
    } else {
      const sz = 8;
      const ox = canvasOffset.x,
        oy = canvasOffset.y;
      for (let y = 0; y < displayH; y += sz) {
        for (let x = 0; x < displayW; x += sz) {
          ctx.fillStyle =
            (Math.floor(x / sz) + Math.floor(y / sz)) % 2 === 0
              ? "#2a2a2a"
              : "#1e1e1e";
          ctx.fillRect(ox + x, oy + y, sz, sz);
        }
      }
    }

    // Helper: convert image coords to screen coords accounting for crop + frame offset
    const toScreen = (p: Point) => ({
      x: (p.x - cropSx) * canvasScale + imgOffX,
      y: (p.y - cropSy) * canvasScale + imgOffY,
    });

    // Video mode: use CPU warp (same path as images for consistent coordinates)
    if (
      contentType === "video" &&
      videoPlayer.videoElement &&
      videoPlayer.videoElement.readyState >= 2 &&
      displayW > 0 &&
      displayH > 0
    ) {
      const vid = videoPlayer.videoElement;
      const srcW = vid.videoWidth;
      const srcH = vid.videoHeight;
      // Same scale as image path but capped to avoid oversized canvas on extreme zoom
      const minHiW = 1760;
      const hiResScale = Math.min(
        Math.max(minHiW / cropSw, window.devicePixelRatio || 1),
        8,
      );
      const hiW = Math.round(cropSw * hiResScale);
      const hiH = Math.round(cropSh * hiResScale);
      const offscreen = document.createElement("canvas");
      offscreen.width = hiW;
      offscreen.height = hiH;
      const offCtx = offscreen.getContext("2d");
      if (offCtx) {
        offCtx.imageSmoothingEnabled = true;
        offCtx.imageSmoothingQuality = "high";
        offCtx.drawImage(
          bgImage,
          cropSx,
          cropSy,
          cropSw,
          cropSh,
          0,
          0,
          hiW,
          hiH,
        );
        const bgData = offCtx.getImageData(0, 0, hiW, hiH);
        // Draw video frame to temp canvas
        const srcCanvas = document.createElement("canvas");
        srcCanvas.width = srcW;
        srcCanvas.height = srcH;
        const srcCtx = srcCanvas.getContext("2d");
        if (srcCtx) {
          if (screenRadius) {
            const r = Math.min(srcW, srcH) * 0.12;
            srcCtx.beginPath();
            srcCtx.roundRect(0, 0, srcW, srcH, r);
            srcCtx.clip();
          }
          srcCtx.drawImage(vid, 0, 0, srcW, srcH);
          const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
          const srcCorners: [Point, Point, Point, Point] = [
            { x: 0, y: 0 },
            { x: srcW - 1, y: 0 },
            { x: srcW - 1, y: srcH - 1 },
            { x: 0, y: srcH - 1 },
          ];
          const croppedCorners = corners.map((p) => ({
            x: (p.x - cropSx) * hiResScale,
            y: (p.y - cropSy) * hiResScale,
          })) as [Point, Point, Point, Point];
          const invH = computeInverseHomography(srcCorners, croppedCorners);
          warpImage(
            bgData.data,
            srcData.data,
            invH,
            croppedCorners,
            srcW,
            srcH,
            hiW,
            hiH,
            opacity,
          );
          offCtx.putImageData(bgData, 0, 0);
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(offscreen, imgOffX, imgOffY, imgDisplayW, imgDisplayH);
      }
    } else if (screenImage && displayW > 0 && displayH > 0) {
      // Image mode: CPU warp (existing path)
      const minHiW = 1760;
      const hiResScale = Math.max(
        minHiW / cropSw,
        window.devicePixelRatio || 1,
      );
      const hiW = Math.round(cropSw * hiResScale);
      const hiH = Math.round(cropSh * hiResScale);
      const offscreen = document.createElement("canvas");
      offscreen.width = hiW;
      offscreen.height = hiH;
      const offCtx = offscreen.getContext("2d");
      if (offCtx) {
        offCtx.imageSmoothingEnabled = true;
        offCtx.imageSmoothingQuality = "high";
        offCtx.drawImage(
          bgImage,
          cropSx,
          cropSy,
          cropSw,
          cropSh,
          0,
          0,
          hiW,
          hiH,
        );
        const bgData = offCtx.getImageData(0, 0, hiW, hiH);
        const srcW = screenImage.naturalWidth;
        const srcH = screenImage.naturalHeight;
        const srcCanvas = document.createElement("canvas");
        srcCanvas.width = srcW;
        srcCanvas.height = srcH;
        const srcCtx = srcCanvas.getContext("2d");
        if (srcCtx) {
          if (screenRadius) {
            const r = Math.min(srcW, srcH) * 0.12;
            srcCtx.beginPath();
            srcCtx.roundRect(0, 0, srcW, srcH, r);
            srcCtx.clip();
          }
          srcCtx.drawImage(screenImage, 0, 0, srcW, srcH);
          const srcData = srcCtx.getImageData(0, 0, srcW, srcH);
          const srcCorners: [Point, Point, Point, Point] = [
            { x: 0, y: 0 },
            { x: srcW - 1, y: 0 },
            { x: srcW - 1, y: srcH - 1 },
            { x: 0, y: srcH - 1 },
          ];
          const croppedCorners = corners.map((p) => ({
            x: (p.x - cropSx) * hiResScale,
            y: (p.y - cropSy) * hiResScale,
          })) as [Point, Point, Point, Point];
          const invH = computeInverseHomography(srcCorners, croppedCorners);
          warpImage(
            bgData.data,
            srcData.data,
            invH,
            croppedCorners,
            srcW,
            srcH,
            hiW,
            hiH,
            opacity,
          );
          offCtx.putImageData(bgData, 0, 0);
        }
        // Scale hi-res result down to display size
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(offscreen, imgOffX, imgOffY, imgDisplayW, imgDisplayH);
      }
    } else {
      ctx.drawImage(
        bgImage,
        cropSx,
        cropSy,
        cropSw,
        cropSh,
        imgOffX,
        imgOffY,
        imgDisplayW,
        imgDisplayH,
      );
    }

    ctx.restore();

    // Draw Dynamic Island notch
    if (showNotch && screenImage) {
      const displayCorners = corners.map((p) => ({
        x: imgOffX + (p.x - cropSx) * canvasScale,
        y: imgOffY + (p.y - cropSy) * canvasScale,
      })) as [Point, Point, Point, Point];
      drawNotch(ctx, displayCorners);
    }

    // Quad outline
    ctx.beginPath();
    corners.forEach((p, i) => {
      const s = toScreen(p);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Handles
    corners.forEach((p) => {
      const s = toScreen(p);
      const active = draggingIdx !== null && corners[draggingIdx] === p;
      const r = active ? 7 : 5;
      ctx.beginPath();
      ctx.arc(s.x, s.y, r + 2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fill();
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fillStyle = active ? "#fff" : "rgba(255,255,255,0.85)";
      ctx.fill();
    });
  }, [
    bgImage,
    screenImage,
    corners,
    opacity,
    canvasScale,
    canvasOffset,
    draggingIdx,
    cropRegion,
    screenRadius,
    showNotch,
    bgColor,
    aspectRatio,
    contentType,
    videoPlayer.videoElement,
    bgNaturalSize,
  ]);

  useEffect(() => {
    renderRef.current = render;
    requestAnimationFrame(render);
  }, [render]);

  const getImageCoords = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      // Compute image offset within frame (same logic as render)
      let frameW = cropRegion.sw,
        frameH = cropRegion.sh;
      if (aspectRatio) {
        if (cropRegion.sw / cropRegion.sh > aspectRatio)
          frameH = cropRegion.sw / aspectRatio;
        else frameW = cropRegion.sh * aspectRatio;
      }
      const displayW = frameW * canvasScale;
      const displayH = frameH * canvasScale;
      const imgDisplayW = cropRegion.sw * canvasScale;
      const imgDisplayH = cropRegion.sh * canvasScale;
      const imgOffX = canvasOffset.x + (displayW - imgDisplayW) / 2;
      const imgOffY = canvasOffset.y + (displayH - imgDisplayH) / 2;
      return {
        x: (e.clientX - rect.left - imgOffX) / canvasScale + cropRegion.sx,
        y: (e.clientY - rect.top - imgOffY) / canvasScale + cropRegion.sy,
      };
    },
    [canvasScale, canvasOffset, cropRegion, aspectRatio],
  );

  const isInsideQuad = useCallback(
    (px: number, py: number) => {
      let sign = 0;
      for (let i = 0; i < 4; i++) {
        const a = corners[i],
          b = corners[(i + 1) % 4];
        const cross = (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x);
        if (cross !== 0) {
          if (sign === 0) sign = cross > 0 ? 1 : -1;
          else if ((cross > 0 ? 1 : -1) !== sign) return false;
        }
      }
      return true;
    },
    [corners],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const pos = getImageCoords(e);
      const threshold = HANDLE_RADIUS / canvasScale + 5;
      for (let i = 0; i < 4; i++) {
        const dx = pos.x - corners[i].x,
          dy = pos.y - corners[i].y;
        if (Math.sqrt(dx * dx + dy * dy) < threshold) {
          setDraggingIdx(i);
          return;
        }
      }
      // Click inside phone screen area → upload screenshot
      if (isInsideQuad(pos.x, pos.y)) {
        fileInputRef.current?.click();
      }
    },
    [corners, canvasScale, getImageCoords, isInsideQuad],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (draggingIdx === null) return;
      const pos = getImageCoords(e);
      setCorners((prev) => {
        const next = [...prev] as [Point, Point, Point, Point];
        next[draggingIdx] = {
          x: Math.max(0, Math.min(bgNaturalSize.w, pos.x)),
          y: Math.max(0, Math.min(bgNaturalSize.h, pos.y)),
        };
        return next;
      });
    },
    [draggingIdx, getImageCoords, bgNaturalSize],
  );

  const handleMouseUp = useCallback(() => setDraggingIdx(null), []);

  const loadImage = (file: File): Promise<HTMLImageElement> =>
    new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });

  const handleScreenUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setScreenFileName(file.name);

    if (file.type.startsWith("video/")) {
      // Check video duration before accepting
      const url = URL.createObjectURL(file);
      const tempVid = document.createElement("video");
      tempVid.preload = "metadata";
      tempVid.src = url;
      await new Promise<void>((resolve) => {
        tempVid.onloadedmetadata = () => resolve();
      });
      if (tempVid.duration > 30) {
        URL.revokeObjectURL(url);
        setAlertMessage("Video must be 30 seconds or less");
        e.target.value = "";
        return;
      }
      // Video mode
      setContentType("video");
      setScreenImage(null);
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      setVideoUrl(url);
      setShowToast(true);
    } else {
      // Image mode
      setContentType("image");
      if (videoUrl) {
        URL.revokeObjectURL(videoUrl);
        setVideoUrl(null);
      }
      setScreenImage(await loadImage(file));
      setShowToast(true);
    }
  };

  const handleBgUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = await loadImage(file);
    setBgImage(img);
    setBgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
    setActiveBgIdx(-1);
  };

  const selectBuiltInBg = (idx: number) => {
    setActiveBgIdx(idx);
    const bg = BUILT_IN_BACKGROUNDS[idx];
    loadBgFromSrc(bg.src);
    setCorners(bg.corners);
  };

  const handleExport = useCallback(() => {
    if (!bgImage) return;
    const { sx: csx, sy: csy, sw: csw, sh: csh } = cropRegion;
    // Scale up so the cropped region exports at least 1760px wide
    const minExportW = 1760;
    const exportScale = csw < minExportW ? minExportW / csw : 1;
    // Apply aspect ratio to export frame
    let frameW = csw,
      frameH = csh;
    if (aspectRatio) {
      if (csw / csh > aspectRatio) {
        frameH = csw / aspectRatio;
      } else {
        frameW = csh * aspectRatio;
      }
    }
    const iw = Math.round(frameW * exportScale);
    const ih = Math.round(frameH * exportScale);
    const imgW = Math.round(csw * exportScale);
    const imgH = Math.round(csh * exportScale);
    const imgX = (iw - imgW) / 2;
    const imgY = (ih - imgH) / 2;
    const offscreen = document.createElement("canvas");
    offscreen.width = iw;
    offscreen.height = ih;
    const ctx = offscreen.getContext("2d");
    if (!ctx) return;
    if (bgColor) {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, iw, ih);
    }
    // Draw cropped region of background centered in frame
    ctx.drawImage(bgImage, csx, csy, csw, csh, imgX, imgY, imgW, imgH);
    if (screenImage) {
      const bgData = ctx.getImageData(0, 0, iw, ih);
      const srcCanvas = document.createElement("canvas");
      srcCanvas.width = screenImage.naturalWidth;
      srcCanvas.height = screenImage.naturalHeight;
      const srcCtx = srcCanvas.getContext("2d");
      if (srcCtx) {
        if (screenRadius) {
          srcCtx.beginPath();
          const r =
            Math.min(screenImage.naturalWidth, screenImage.naturalHeight) *
            0.12;
          srcCtx.roundRect(
            0,
            0,
            screenImage.naturalWidth,
            screenImage.naturalHeight,
            r,
          );
          srcCtx.clip();
        }
        srcCtx.drawImage(screenImage, 0, 0);
        const srcData = srcCtx.getImageData(
          0,
          0,
          screenImage.naturalWidth,
          screenImage.naturalHeight,
        );
        const srcCorners: [Point, Point, Point, Point] = [
          { x: 0, y: 0 },
          { x: screenImage.naturalWidth - 1, y: 0 },
          { x: screenImage.naturalWidth - 1, y: screenImage.naturalHeight - 1 },
          { x: 0, y: screenImage.naturalHeight - 1 },
        ];
        // Offset corners by crop origin, scale, and add frame offset
        const exportCorners = corners.map((p) => ({
          x: (p.x - csx) * exportScale + imgX,
          y: (p.y - csy) * exportScale + imgY,
        })) as [Point, Point, Point, Point];
        const invH = computeInverseHomography(srcCorners, exportCorners);
        warpImage(
          bgData.data,
          srcData.data,
          invH,
          exportCorners,
          screenImage.naturalWidth,
          screenImage.naturalHeight,
          iw,
          ih,
          opacity,
        );
        ctx.putImageData(bgData, 0, 0);
      }
    }
    // Draw Dynamic Island notch on export
    if (showNotch && screenImage) {
      const exportCorners = corners.map((p) => ({
        x: (p.x - csx) * exportScale + imgX,
        y: (p.y - csy) * exportScale + imgY,
      })) as [Point, Point, Point, Point];
      drawNotch(ctx, exportCorners);
    }
    const link = document.createElement("a");
    link.download = "sickpreviews-export.png";
    link.href = offscreen.toDataURL("image/png");
    link.click();
  }, [
    bgImage,
    screenImage,
    corners,
    opacity,
    screenRadius,
    showNotch,
    bgColor,
    cropRegion,
    aspectRatio,
  ]);

  const handleVideoExport = useCallback(async () => {
    if (!bgImage || !videoPlayer.videoElement) return;
    const abort = new AbortController();
    exportAbortRef.current = abort;
    setIsExporting(true);
    setExportProgress(0);
    try {
      videoPlayer.pause();
      await exportVideo({
        video: videoPlayer.videoElement,
        bgImage,
        corners,
        opacity,
        roundedCorners: screenRadius,
        cropRegion,
        bgColor,
        aspectRatio,
        fps: videoPlayer.fps,
        onProgress: setExportProgress,
        signal: abort.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Cancelled
      } else {
        console.error("Video export failed:", err);
      }
    } finally {
      setIsExporting(false);
      setExportProgress(0);
      exportAbortRef.current = null;
    }
  }, [
    bgImage,
    videoPlayer,
    corners,
    opacity,
    screenRadius,
    cropRegion,
    bgNaturalSize,
    bgColor,
    aspectRatio,
  ]);

  const cancelExport = useCallback(() => {
    exportAbortRef.current?.abort();
  }, []);

  return (
    <div className="h-screen flex flex-col md:flex-row bg-[#0a0a0a] text-gray-300 overflow-hidden relative">
      {/* Typewriter Intro */}
      {showIntro && (
        <div
          className={`fixed inset-0 z-50 bg-[#0a0a0a] flex items-center justify-center ${introFading ? "animate-fade-out" : ""}`}
        >
          <span className="text-2xl md:text-4xl font-semibold tracking-tight text-white">
            {introText}
            <span className="animate-cursor text-white/60">|</span>
          </span>
        </div>
      )}

      {/* Canvas */}
      <div className="absolute inset-0 gradient-mesh">
        <div
          ref={containerRef}
          className="absolute top-0 bottom-0 left-0 right-0 md:left-[17rem] md:right-[14.5rem]"
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-0 cursor-crosshair"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm"
            onChange={handleScreenUpload}
            className="hidden"
          />
          {draggingIdx !== null && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-[#1a1a1a] px-3 py-1.5 rounded-full text-[11px] font-mono text-white/70 pointer-events-none border border-white/10">
              {Math.round(corners[draggingIdx].x)},{" "}
              {Math.round(corners[draggingIdx].y)}
            </div>
          )}

          {/* Utility navbar */}
          <div className="hidden md:flex absolute top-4 left-1/2 -translate-x-1/2 z-20 items-center gap-1 px-2 py-1.5 rounded-full bg-[#161616] border border-white/[0.06]">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="px-4 py-2 rounded-lg text-xs font-medium text-white/50 hover:text-white/80 hover:bg-[#252525] transition-all"
            >
              Upload
            </button>
            <div className="w-px h-5 bg-white/[0.06]" />
            <button
              onClick={() =>
                setCorners(
                  BUILT_IN_BACKGROUNDS[activeBgIdx >= 0 ? activeBgIdx : 0]
                    .corners,
                )
              }
              className="px-4 py-2 rounded-lg text-xs font-medium text-white/50 hover:text-white/80 hover:bg-[#252525] transition-all"
            >
              Reset
            </button>
            <div className="w-px h-5 bg-white/[0.06]" />
            <button
              onClick={
                contentType === "video" ? handleVideoExport : handleExport
              }
              disabled={!bgImage}
              className="px-4 py-2 rounded-lg text-xs font-medium bg-white text-black hover:bg-white/90 transition-all disabled:opacity-30"
            >
              {contentType === "video" ? "Export Video" : "Export PNG"}
            </button>
          </div>
        </div>
      </div>

      {/* Left Panel — glassmorphism */}
      <div className="hidden md:flex absolute top-4 left-4 bottom-4 w-60 flex-col gap-4 p-4 rounded-2xl bg-[#161616] border border-white/[0.08] shadow-2xl shadow-black/50 overflow-y-auto z-10">
        <h1 className="text-sm cursor-pointer font-semibold text-white/90 tracking-tight">
          sickpreviews.com
        </h1>

        <div className="h-px bg-[#1e1e1e]" />

        {/* Aspect Ratio */}
        <div>
          <p className="text-[10px] uppercase tracking-widest text-white/25 mb-2">
            Aspect Ratio
          </p>
          <div className="grid grid-cols-4 gap-1.5">
            {ASPECT_RATIOS.map((ar) => (
              <button
                key={ar.name}
                onClick={() => setAspectRatio(ar.value)}
                className={`flex flex-col items-center gap-1 py-1.5 rounded-lg transition-all ${
                  aspectRatio === ar.value
                    ? "bg-[#2a2a2a]"
                    : "bg-[#1e1e1e] hover:bg-[#252525]"
                }`}
              >
                <div className="flex items-center justify-center w-full h-8">
                  {ar.value ? (
                    <div
                      className={`rounded-[3px] border transition-all ${
                        aspectRatio === ar.value
                          ? "border-white/40 bg-[#2a2a2a]"
                          : "border-white/15 bg-[#1e1e1e]"
                      }`}
                      style={{
                        width: ar.value >= 1 ? 28 : Math.round(28 * ar.value),
                        height: ar.value >= 1 ? Math.round(28 / ar.value) : 28,
                      }}
                    />
                  ) : (
                    <div
                      className={`w-5 h-6 rounded-[3px] border border-dashed transition-all ${
                        aspectRatio === ar.value
                          ? "border-white/40"
                          : "border-white/15"
                      }`}
                    />
                  )}
                </div>
                <span
                  className={`text-[9px] transition-all ${
                    aspectRatio === ar.value ? "text-white/60" : "text-white/25"
                  }`}
                >
                  {ar.name}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Screen Upload */}
        <div>
          <p className="text-[10px] uppercase tracking-widest text-white/25 mb-2">
            Screen
          </p>
          <label className="group flex items-center justify-center gap-2 cursor-pointer py-4 rounded-xl bg-[#1e1e1e] hover:bg-[#252525] border border-white/[0.06] hover:border-white/[0.12] text-white/35 hover:text-white/60 transition-all text-xs">
            {screenImage || videoUrl ? (
              <span className="truncate px-2">{screenFileName}</span>
            ) : (
              <>
                <svg
                  className="w-4 h-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 4v16m8-8H4"
                  />
                </svg>
                <span>Upload screenshot or video</span>
              </>
            )}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm"
              onChange={handleScreenUpload}
              className="hidden"
            />
          </label>
        </div>

        {/* Video playback controls */}
        {contentType === "video" && videoPlayer.videoElement && (
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-widest text-white/25">
              Video
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={videoPlayer.togglePlayPause}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-[#222222] hover:bg-[#2a2a2a] transition-all"
              >
                {videoPlayer.isPlaying ? (
                  <svg
                    className="w-3.5 h-3.5 text-white/60"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <rect x="6" y="4" width="4" height="16" />
                    <rect x="14" y="4" width="4" height="16" />
                  </svg>
                ) : (
                  <svg
                    className="w-3.5 h-3.5 text-white/60"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <polygon points="5,3 19,12 5,21" />
                  </svg>
                )}
              </button>
              <span className="text-[10px] font-mono text-white/30 min-w-[60px]">
                {formatTime(videoPlayer.currentTime)} /{" "}
                {formatTime(videoPlayer.duration)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={videoPlayer.duration || 1}
              step={0.01}
              value={videoPlayer.currentTime}
              onChange={(e) => videoPlayer.seek(parseFloat(e.target.value))}
              className="w-full accent-white/50 h-px"
            />
          </div>
        )}

        {/* Points */}
        <div>
          <p className="text-[10px] uppercase tracking-widest text-white/25 mb-2">
            Points
          </p>
          <div className="space-y-1 px-1">
            {corners.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-white/20" />
                <span className="text-[11px] font-mono text-white/30">
                  {Math.round(p.x)}, {Math.round(p.y)}
                </span>
              </div>
            ))}
          </div>
          <button
            onClick={() =>
              setCorners(
                BUILT_IN_BACKGROUNDS[activeBgIdx >= 0 ? activeBgIdx : 0]
                  .corners,
              )
            }
            className="mt-2 w-full text-[10px] py-1.5 rounded-lg bg-[#1e1e1e] hover:bg-[#252525] text-white/25 hover:text-white/50 transition-all"
          >
            Reset
          </button>
        </div>

        <div className="h-px bg-[#1e1e1e]" />

        {/* Opacity — pill slider */}
        <div className="flex items-center gap-2 h-10 rounded-full bg-[#222222] border border-white/[0.06] px-3 min-w-0">
          <span className="text-[11px] text-white/40 flex-shrink-0">
            Opacity
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={opacity}
            onChange={(e) => setOpacity(parseFloat(e.target.value))}
            className="min-w-0 w-full accent-white/50 h-px"
          />
          <span className="text-[11px] font-mono text-white/30 w-6 text-right flex-shrink-0">
            {Math.round(opacity * 100)}
          </span>
        </div>

        {/* Zoom — pill slider (hidden for video) */}
        {contentType !== "video" && (
          <div className="flex items-center gap-2 h-10 rounded-full bg-[#222222] border border-white/[0.06] px-3 min-w-0 overflow-hidden">
            <span className="text-[11px] text-white/40 flex-shrink-0">
              Zoom
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={deviceZoom}
              onChange={(e) => setDeviceZoom(parseFloat(e.target.value))}
              className="min-w-0 w-full accent-white/50 h-px"
            />
            <span className="text-[11px] font-mono text-white/30 w-6 text-right flex-shrink-0">
              {Math.round(deviceZoom * 100)}
            </span>
          </div>
        )}

        {/* Toggles */}
        <div className="space-y-2">
          <button
            onClick={() => setScreenRadius(!screenRadius)}
            className="flex items-center gap-3 cursor-pointer select-none w-full py-2 px-2.5 rounded-lg hover:bg-[#1e1e1e] transition-all"
          >
            <div
              className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${screenRadius ? "bg-[#3a3a3a]" : "bg-[#222222]"}`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white/90 shadow-sm transition-all ${screenRadius ? "left-[18px]" : "left-0.5"}`}
              />
            </div>
            <span className="text-[11px] text-white/40">Rounded corners</span>
          </button>
          {/* <button
            onClick={() => setShowNotch(!showNotch)}
            className="flex items-center gap-3 cursor-pointer select-none w-full py-2 px-2.5 rounded-lg hover:bg-[#1e1e1e] transition-all"
          >
            <div
              className={`w-9 h-5 rounded-full transition-colors relative flex-shrink-0 ${showNotch ? "bg-[#3a3a3a]" : "bg-[#222222]"}`}
            >
              <div
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white/90 shadow-sm transition-all ${showNotch ? "left-[18px]" : "left-0.5"}`}
              />
            </div>
            <span className="text-[11px] text-white/40">Dynamic Island</span>
          </button> */}
        </div>

        {/* Background Color */}
        <div>
          <p className="text-[10px] uppercase tracking-widest text-white/25 mb-2">
            Background
          </p>
          <div className="flex gap-1.5">
            {BG_COLORS.map((c) => (
              <button
                key={c.name}
                onClick={() => setBgColor(c.value)}
                className={`w-8 h-8 rounded-lg border-2 transition-all ${
                  bgColor === c.value
                    ? "border-white/40 scale-110"
                    : "border-white/[0.08] hover:border-white/20"
                }`}
                title={c.name}
              >
                {c.value ? (
                  <div
                    className="w-full h-full rounded-[5px]"
                    style={{ backgroundColor: c.value }}
                  />
                ) : (
                  <div
                    className="w-full h-full rounded-[5px] overflow-hidden"
                    style={{
                      backgroundImage:
                        "repeating-conic-gradient(#444 0% 25%, #666 0% 50%)",
                      backgroundSize: "8px 8px",
                    }}
                  />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Export */}
        <button
          onClick={contentType === "video" ? handleVideoExport : handleExport}
          disabled={!bgImage || isExporting}
          className="mt-auto py-2.5 rounded-xl bg-[#252525] hover:bg-[#2e2e2e] disabled:opacity-20 text-white/70 hover:text-white/90 text-xs font-medium transition-all border border-white/[0.06] hover:border-white/[0.12]"
        >
          {contentType === "video" ? "Export Video" : "Export PNG"}
        </button>
      </div>

      {/* Right Panel — glassmorphism */}
      <div className="hidden md:flex absolute top-4 right-4 bottom-4 w-52 flex-col gap-4 p-4 rounded-2xl bg-[#161616] border border-white/[0.08] shadow-2xl shadow-black/50 overflow-y-auto z-10">
        <a
          href="https://buymeacoffee.com/khushbuildsnow"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-2 py-2 rounded-xl text-xs font-medium transition-all hover:scale-[1.02]"
          style={{ backgroundColor: "#FFDD00", color: "#000" }}
        >
          <img
            src="https://cdn.buymeacoffee.com/buttons/bmc-new-btn-logo.svg"
            alt=""
            className="h-4 w-4"
          />
          Buy me a coffee
        </a>

        <a
          href="https://buildnowstudios.com"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1 py-2 rounded-xl bg-white text-black text-[11px] font-bold transition-all hover:scale-[1.02]"
        >
          <img src="/logo.png" alt="" className="h-5 w-5 rounded-md" />
          We build sick mobile apps
        </a>

        <div className="h-px bg-[#1e1e1e]" />

        <p className="text-[10px] uppercase tracking-widest text-white/25">
          Mockups
        </p>
        <div className="grid grid-cols-1 gap-2">
          {BUILT_IN_BACKGROUNDS.map((bg, idx) => (
            <button
              key={idx}
              onClick={() => selectBuiltInBg(idx)}
              className={`aspect-[3/4] rounded-xl overflow-hidden border-2 transition-all hover:scale-[1.03] ${
                activeBgIdx === idx
                  ? "border-white/30 shadow-lg shadow-white/5"
                  : "border-white/[0.06] hover:border-white/15"
              }`}
            >
              <img
                src={bg.thumb}
                alt={bg.name}
                className="w-full h-full object-cover bg-white"
              />
            </button>
          ))}
        </div>
        <label className="flex items-center justify-center gap-1.5 cursor-pointer py-2.5 rounded-xl bg-[#1e1e1e] hover:bg-[#252525] border border-dashed border-white/[0.08] hover:border-white/[0.15] text-white/25 hover:text-white/50 transition-all text-xs">
          <svg
            className="w-3.5 h-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 4v16m8-8H4"
            />
          </svg>
          <span>Custom</span>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm"
            onChange={handleBgUpload}
            className="hidden"
          />
        </label>
      </div>

      {/* Mobile bottom bar */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-20 bg-[#161616] border-t border-white/[0.06] p-3 flex flex-col gap-3 safe-bottom">
        <div className="flex gap-2">
          <label className="flex-1 flex items-center justify-center gap-2 cursor-pointer py-3 rounded-xl bg-[#222222] border border-white/[0.08] text-white/50 text-xs">
            {screenImage || videoUrl ? (
              <span className="truncate px-2">{screenFileName}</span>
            ) : (
              <span>Upload screenshot or video</span>
            )}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm"
              onChange={handleScreenUpload}
              className="hidden"
            />
          </label>
          <button
            onClick={contentType === "video" ? handleVideoExport : handleExport}
            disabled={!bgImage || isExporting}
            className="px-5 py-3 rounded-xl bg-[#252525] text-white/70 text-xs font-medium disabled:opacity-30"
          >
            Export
          </button>
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {BUILT_IN_BACKGROUNDS.map((bg, idx) => (
            <button
              key={idx}
              onClick={() => selectBuiltInBg(idx)}
              className={`w-10 h-14 flex-shrink-0 rounded-lg overflow-hidden border-2 ${
                activeBgIdx === idx ? "border-white/30" : "border-white/[0.06]"
              }`}
            >
              <img
                src={bg.thumb}
                alt={bg.name}
                className="w-full h-full object-cover bg-white"
              />
            </button>
          ))}
          {BG_COLORS.map((c) => (
            <button
              key={c.name}
              onClick={() => setBgColor(c.value)}
              className={`w-10 h-14 flex-shrink-0 rounded-lg border-2 ${
                bgColor === c.value ? "border-white/30" : "border-white/[0.06]"
              }`}
            >
              {c.value ? (
                <div
                  className="w-full h-full rounded-[5px]"
                  style={{ backgroundColor: c.value }}
                />
              ) : (
                <div
                  className="w-full h-full rounded-[5px]"
                  style={{
                    backgroundImage:
                      "repeating-conic-gradient(#444 0% 25%, #666 0% 50%)",
                    backgroundSize: "6px 6px",
                  }}
                />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Quality toast */}
      {showToast && (
        <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-30 animate-slide-up">
          <div className="flex items-center gap-3 px-4 py-2.5 rounded-full bg-white shadow-xl shadow-black/20">
            <span className="text-xs font-semibold text-black/70">
              Preview is low quality export for full resolution
            </span>
            <button
              onClick={() => setShowToast(false)}
              className="text-black hover:text-white/60 transition-colors flex-shrink-0"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>
        </div>
      )}
      {/* Export modal */}
      {isExporting && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-80 p-6 rounded-2xl bg-[#161616] border border-white/[0.08] shadow-2xl shadow-black/50 flex flex-col items-center gap-4">
            <div className="w-10 h-10 rounded-full border-2 border-white/10 border-t-white/60 animate-spin" />
            <p className="text-sm font-medium text-white/80">Exporting...</p>
            <div className="w-full h-2 rounded-full bg-[#222222] overflow-hidden">
              <div
                className="h-full bg-white transition-all duration-200"
                style={{ width: `${exportProgress}%` }}
              />
            </div>
            <span className="text-xs font-mono text-white/40">
              {exportProgress}%
            </span>
            <button
              onClick={cancelExport}
              className="mt-1 text-xs text-white/30 hover:text-white/60 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {/* Custom alert */}
      {alertMessage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-80 max-w-[90vw] p-6 rounded-2xl bg-black border border-white/[0.08] shadow-2xl shadow-black/50 flex flex-col items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center">
              <svg
                className="w-5 h-5 text-white/60"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01M12 3l9.66 16.59A1 1 0 0120.66 21H3.34a1 1 0 01-.86-1.41L12 3z"
                />
              </svg>
            </div>
            <p className="text-sm text-white/70 text-center">{alertMessage}</p>
            <button
              onClick={() => setAlertMessage(null)}
              className="w-full py-2.5 rounded-full bg-white text-black text-sm font-semibold hover:bg-white/90 transition-all"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Video feature modal */}
      {showVideoModal && !showIntro && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="w-[700px] max-w-[92vw] max-h-[90vh] rounded-2xl bg-black border border-white/[0.08] shadow-2xl shadow-black/50 overflow-hidden flex flex-col md:flex-row">
            {/* Left — Video preview */}
            <div className="md:w-[280px] h-48 md:h-auto flex-shrink-0 bg-[#0a0a0a]">
              <video
                src="/video-preview.webm"
                autoPlay
                loop
                muted
                playsInline
                className="w-full h-full object-cover"
              />
            </div>

            {/* Right — Text */}
            <div className="flex-1 flex flex-col p-6">
              <div className="inline-block self-start px-2.5 py-1 rounded-full bg-white/10 text-[10px] uppercase tracking-widest text-white/50 font-medium mb-3">
                New
              </div>
              <h2 className="text-xl font-semibold text-white tracking-tight">
                Video support is here
              </h2>
              <p className="text-sm text-white/40 mt-1 mb-5">
                sickpreviews now supports screen recordings
              </p>

              <div className="space-y-3 flex-1">
                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-semibold text-white/60">
                      1
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white/70">
                      Upload a video
                    </p>
                    <p className="text-xs text-white/30 mt-0.5">
                      MP4, MOV, or WebM up to 30 seconds
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-semibold text-white/60">
                      2
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white/70">
                      Preview in real-time
                    </p>
                    <p className="text-xs text-white/30 mt-0.5">
                      Play, pause, and scrub through your mockup
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-semibold text-white/60">
                      3
                    </span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white/70">
                      Export as video
                    </p>
                    <p className="text-xs text-white/30 mt-0.5">
                      Downloads as WebM with perspective warp baked in
                    </p>
                  </div>
                </div>
              </div>

              <button
                onClick={() => {
                  setShowVideoModal(false);
                  localStorage.setItem("sickpreviews-video-modal-seen", "1");
                }}
                className="w-full py-3 mt-5 rounded-full bg-white text-black text-sm font-semibold hover:bg-white/90 transition-all"
              >
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
