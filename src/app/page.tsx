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

type DeviceType = "iPhone" | "MacBook";

interface MockupBg {
  name: string;
  src: string;
  thumb: string;
  corners: [Point, Point, Point, Point];
  device: DeviceType;
  fullScene?: boolean; // true = bg has its own scene, don't change bg color
  composite?: { frame: string; hand: string }; // runtime-generated composite
}

const BUILT_IN_BACKGROUNDS: MockupBg[] = [
  {
    name: "Hand 1",
    src: "/bg-1-transparent.png",
    thumb: "/bg-1-transparent.png",
    device: "iPhone",
    corners: [
      { x: 114, y: 80 },
      { x: 251, y: 96 },
      { x: 324, y: 426 },
      { x: 190, y: 432 },
    ],
  },
  {
    name: "Hand 2",
    src: "/bg-2-transparent.png",
    thumb: "/bg-2-transparent.png",
    device: "iPhone",
    corners: [
      { x: 134, y: 92 },
      { x: 293, y: 92 },
      { x: 290, y: 443 },
      { x: 137, y: 443 },
    ],
  },
  {
    name: "Hand 3",
    src: "/bg-3-transparent.png",
    thumb: "/bg-3-transparent.png",
    device: "iPhone",
    corners: [
      { x: 86, y: 57 },
      { x: 338, y: 57 },
      { x: 295, y: 483 },
      { x: 135, y: 483 },
    ],
  },
  {
    name: "MacBook 1",
    src: "/bg-1-macbook.png",
    thumb: "/bg-1-macbook.png",
    device: "MacBook" as DeviceType,
    corners: [
      { x: 91, y: 136 },
      { x: 366, y: 137 },
      { x: 364, y: 320 },
      { x: 90, y: 321 },
    ],
  },
  {
    name: "MacBook 2",
    src: "/bg-2-macbook.png",
    thumb: "/bg-2-macbook.png",
    device: "MacBook" as DeviceType,
    fullScene: true,
    corners: [
      { x: 195, y: 709 },
      { x: 1188, y: 355 },
      { x: 1328, y: 1074 },
      { x: 407, y: 1490 },
    ],
  },
  {
    name: "MacBook 3",
    src: "/bg-3-macbook.png",
    thumb: "/bg-3-macbook.png",
    device: "MacBook" as DeviceType,
    fullScene: true,
    corners: [
      { x: 392, y: 202 },
      { x: 1719, y: 521 },
      { x: 1589, y: 1448 },
      { x: 356, y: 1084 },
    ],
  },
];

const BG_COLORS = [
  { name: "White", value: "#e8e8e8" },
  { name: "Black", value: "#111111" },
  { name: "Transparent", value: null },
];

const BG_IMAGES = [
  { name: "Blue 1", src: "/bg-colors/blue_distortion_1.png" },
  { name: "Blue 2", src: "/bg-colors/blue_distortion_2.png" },
  { name: "Red 1", src: "/bg-colors/red_distortion_1.png" },
  { name: "Red 2", src: "/bg-colors/red_distortion_2.png" },
  { name: "Red 3", src: "/bg-colors/red_distortion_3.png" },
  { name: "Red 4", src: "/bg-colors/red_distortion_4.png" },
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
  const [selectedDevice, setSelectedDevice] = useState<DeviceType>("iPhone");
  const [deviceDropdownOpen, setDeviceDropdownOpen] = useState(false);
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
  const [bgColor, setBgColor] = useState<string | null>("#111111");
  const [bgImageSrc, setBgImageSrc] = useState<string | null>(null);
  const [bgColorImage, setBgColorImage] = useState<HTMLImageElement | null>(
    null,
  );
  const [bgOverlay, setBgOverlay] = useState(0); // 0-1 dark overlay
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

  // Load background image when bgImageSrc changes
  useEffect(() => {
    if (!bgImageSrc) {
      setBgColorImage(null);
      return;
    }
    const img = new Image();
    img.onload = () => setBgColorImage(img);
    img.src = bgImageSrc;
  }, [bgImageSrc]);

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

  const generateComposite = useCallback(
    async (comp: { frame: string; hand: string }) => {
      const W = 500,
        H = 1000;
      const PHONE_X = 33,
        PHONE_Y = 20;
      const loadImg = (s: string) =>
        new Promise<HTMLImageElement>((res) => {
          const i = new Image();
          i.onload = () => res(i);
          i.src = s;
        });
      const [frame, hand] = await Promise.all([
        loadImg(comp.frame),
        loadImg(comp.hand),
      ]);
      const c = document.createElement("canvas");
      c.width = W;
      c.height = H;
      const ctx = c.getContext("2d")!;
      // Draw hand behind phone — large enough to "hold" it
      const handScale = 3.5;
      const handW = hand.naturalWidth * handScale;
      const handH = hand.naturalHeight * handScale;
      const handX = (W - handW) / 2 + 20;
      const handY = PHONE_Y + 882 - handH * 0.7;
      ctx.drawImage(hand, handX, handY, handW, handH);
      // Draw phone frame on top
      ctx.drawImage(frame, PHONE_X, PHONE_Y, 433, 882);
      const result = new Image();
      result.onload = () => {
        setBgImage(result);
        setBgNaturalSize({ w: W, h: H });
      };
      result.src = c.toDataURL();
    },
    [],
  );

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

    // Draw background color, image, or checkerboard
    if (bgColorImage) {
      ctx.drawImage(
        bgColorImage,
        canvasOffset.x,
        canvasOffset.y,
        displayW,
        displayH,
      );
      if (bgOverlay > 0) {
        ctx.fillStyle = `rgba(0, 0, 0, ${bgOverlay})`;
        ctx.fillRect(canvasOffset.x, canvasOffset.y, displayW, displayH);
      }
    } else if (bgColor) {
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
    bgColorImage,
    bgOverlay,
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
    if (bg.composite) {
      generateComposite(bg.composite);
    } else {
      loadBgFromSrc(bg.src);
    }
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
    if (bgColorImage) {
      ctx.drawImage(bgColorImage, 0, 0, iw, ih);
      if (bgOverlay > 0) {
        ctx.fillStyle = `rgba(0, 0, 0, ${bgOverlay})`;
        ctx.fillRect(0, 0, iw, ih);
      }
    } else if (bgColor) {
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
    bgColorImage,
    bgOverlay,
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
          className="absolute top-0 bottom-0 left-0 right-0 md:left-64 md:right-56"
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

      {/* Left Panel */}
      <div className="hidden md:flex absolute top-0 left-0 bottom-0 w-64 flex-col bg-black border-r border-white/[0.06] overflow-y-auto z-10">
        {/* Brand */}
        <div className="px-5 py-5 flex items-center gap-2.5">
          {/* <div className="w-7 h-7 rounded-lg bg-white flex items-center justify-center">
            <span className="text-[11px] font-black text-black">SP</span>
          </div> */}
          <h1 className="text-[14px] font-semibold text-white/90 tracking-tight">
            sickpreviews
          </h1>
        </div>

        <div className="h-px bg-white/[0.06]" />

        {/* Media Upload */}
        <div className="px-5 pt-5 pb-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-white/30 mb-3">
            Media
          </p>
          <label className="group flex items-center justify-center gap-2 cursor-pointer py-4 rounded-xl bg-[#181818] hover:bg-[#1c1c1c] border border-dashed border-white/[0.08] hover:border-white/12 text-white/30 hover:text-white/50 transition-all text-[12px]">
            {screenImage || videoUrl ? (
              <span className="truncate px-2 text-white/50">
                {screenFileName}
              </span>
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
          <div className="px-5 pb-4 space-y-2.5">
            <div className="flex items-center gap-2">
              <button
                onClick={videoPlayer.togglePlayPause}
                className="w-7 h-7 flex items-center justify-center rounded-md bg-[#1a1a1a] hover:bg-[#222] transition-all"
              >
                {videoPlayer.isPlaying ? (
                  <svg
                    className="w-3 h-3 text-white/50"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <rect x="6" y="4" width="4" height="16" />
                    <rect x="14" y="4" width="4" height="16" />
                  </svg>
                ) : (
                  <svg
                    className="w-3 h-3 text-white/50"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <polygon points="5,3 19,12 5,21" />
                  </svg>
                )}
              </button>
              <span className="text-[10px] font-mono text-white/25">
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
              className="w-full accent-white/40 h-px"
            />
          </div>
        )}

        <div className="h-px bg-white/[0.06] mx-5" />

        {/* Layout */}
        <div className="px-5 pt-5 pb-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-white/30 mb-3">
            Layout
          </p>
          <div className="grid grid-cols-5 gap-1">
            {ASPECT_RATIOS.map((ar) => (
              <button
                key={ar.name}
                onClick={() => setAspectRatio(ar.value)}
                className={`flex flex-col items-center gap-0.5 py-1.5 rounded-md text-[9px] transition-all ${
                  aspectRatio === ar.value
                    ? "bg-white/10 text-white/70"
                    : "hover:bg-white/[0.04] text-white/25 hover:text-white/40"
                }`}
              >
                <div className="flex items-center justify-center h-6">
                  {ar.value ? (
                    <div
                      className={`rounded-[2px] border transition-all ${
                        aspectRatio === ar.value
                          ? "border-white/30"
                          : "border-white/10"
                      }`}
                      style={{
                        width: ar.value >= 1 ? 20 : Math.round(20 * ar.value),
                        height: ar.value >= 1 ? Math.round(20 / ar.value) : 20,
                      }}
                    />
                  ) : (
                    <div
                      className={`w-4 h-5 rounded-[2px] border border-dashed transition-all ${
                        aspectRatio === ar.value
                          ? "border-white/30"
                          : "border-white/10"
                      }`}
                    />
                  )}
                </div>
                {ar.name}
              </button>
            ))}
          </div>
        </div>

        <div className="h-px bg-white/[0.06] mx-5" />

        {/* Adjustments */}
        <div className="px-5 pt-5 pb-4 space-y-2.5">
          <p className="text-[11px] font-medium uppercase tracking-wider text-white/30 mb-2">
            Adjustments
          </p>

          {/* Opacity */}
          <div className="flex items-center gap-2.5 h-9 rounded-lg bg-[#141414] px-3 min-w-0">
            <span className="text-[10px] text-white/30 flex-shrink-0 w-12">
              Opacity
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={opacity}
              onChange={(e) => setOpacity(parseFloat(e.target.value))}
              className="min-w-0 w-full accent-white/40 h-px"
            />
            <span className="text-[10px] font-mono text-white/20 w-6 text-right flex-shrink-0">
              {Math.round(opacity * 100)}
            </span>
          </div>

          {/* Zoom */}
          {contentType !== "video" && (
            <div className="flex items-center gap-2.5 h-9 rounded-lg bg-[#141414] px-3 min-w-0">
              <span className="text-[10px] text-white/30 flex-shrink-0 w-12">
                Zoom
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={deviceZoom}
                onChange={(e) => setDeviceZoom(parseFloat(e.target.value))}
                className="min-w-0 w-full accent-white/40 h-px"
              />
              <span className="text-[10px] font-mono text-white/20 w-6 text-right flex-shrink-0">
                {Math.round(deviceZoom * 100)}
              </span>
            </div>
          )}

          {/* Rounded corners toggle */}
          <button
            onClick={() => setScreenRadius(!screenRadius)}
            className="flex items-center justify-between w-full py-1.5 px-0.5 group"
          >
            <span className="text-[10px] text-white/25 group-hover:text-white/40 transition-colors">
              Rounded corners
            </span>
            <div
              className={`w-8 h-[18px] rounded-full transition-colors relative flex-shrink-0 ${screenRadius ? "bg-white/20" : "bg-white/[0.06]"}`}
            >
              <div
                className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white/80 shadow-sm transition-all ${screenRadius ? "left-[16px]" : "left-[2px]"}`}
              />
            </div>
          </button>
        </div>

        <div className="h-px bg-white/[0.06] mx-5" />

        {/* Background — hidden for fullScene mockups */}
        {!(
          activeBgIdx >= 0 && BUILT_IN_BACKGROUNDS[activeBgIdx]?.fullScene
        ) && (
          <div className="px-5 pt-5 pb-4">
            <p className="text-[11px] font-medium uppercase tracking-wider text-white/30 mb-3">
              Background
            </p>
            <div className="flex gap-2">
              {BG_COLORS.map((c) => (
                <button
                  key={c.name}
                  onClick={() => {
                    setBgColor(c.value);
                    setBgImageSrc(null);
                  }}
                  className={`w-9 h-9 rounded-lg border-2 transition-all ${
                    bgColor === c.value && !bgImageSrc
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
            <div className="flex gap-2 mt-2.5 flex-wrap">
              {BG_IMAGES.map((bg) => (
                <button
                  key={bg.name}
                  onClick={() => {
                    setBgImageSrc(bg.src);
                    setBgColor(null);
                  }}
                  className={`w-9 h-9 rounded-lg border-2 overflow-hidden transition-all ${
                    bgImageSrc === bg.src
                      ? "border-white/40 scale-110"
                      : "border-white/[0.08] hover:border-white/20"
                  }`}
                  title={bg.name}
                >
                  <img
                    src={bg.src}
                    alt={bg.name}
                    className="w-full h-full object-cover"
                  />
                </button>
              ))}
            </div>
            {bgImageSrc && (
              <div className="flex items-center gap-2.5 h-9 rounded-lg bg-[#141414] px-3 min-w-0 mt-3">
                <span className="text-[10px] text-white/30 flex-shrink-0">
                  Darken
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={bgOverlay}
                  onChange={(e) => setBgOverlay(parseFloat(e.target.value))}
                  className="min-w-0 w-full accent-white/50 h-px"
                />
                <span className="text-[11px] font-mono text-white/30 w-6 text-right flex-shrink-0">
                  {Math.round(bgOverlay * 100)}
                </span>
              </div>
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Points — collapsed */}
        <div className="px-5 pb-4">
          <details className="group">
            <summary className="text-[10px] text-white/20 cursor-pointer hover:text-white/30 transition-colors list-none flex items-center gap-1">
              <svg
                className="w-3 h-3 transition-transform group-open:rotate-90"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5l7 7-7 7"
                />
              </svg>
              Corner points
            </summary>
            <div className="mt-2 space-y-0.5 px-1">
              {corners.map((p, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span className="w-1 h-1 rounded-full bg-white/15" />
                  <span className="text-[10px] font-mono text-white/20">
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
              className="mt-1.5 w-full text-[10px] py-1 rounded-md bg-[#141414] hover:bg-[#1a1a1a] text-white/20 hover:text-white/35 transition-all"
            >
              Reset
            </button>
          </details>
        </div>

        {/* Export */}
        <div className="px-4 pb-4">
          <button
            onClick={contentType === "video" ? handleVideoExport : handleExport}
            disabled={!bgImage || isExporting}
            className="w-full py-2.5 rounded-lg bg-white hover:bg-white/90 disabled:opacity-20 text-black text-[12px] font-semibold transition-all"
          >
            {contentType === "video" ? "Export Video" : "Export PNG"}
          </button>
        </div>
      </div>

      {/* Right Panel */}
      <div className="hidden md:flex absolute top-0 right-0 bottom-0 w-56 flex-col bg-[#0f0f0f] border-l border-white/[0.06] overflow-y-auto z-10">
        {/* Device dropdown */}
        <div className="relative px-5 pt-5 pb-4">
          <button
            onClick={() => setDeviceDropdownOpen(!deviceDropdownOpen)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[#141414] hover:bg-[#1a1a1a] transition-all"
          >
            <div className="flex items-center gap-2">
              {selectedDevice === "iPhone" ? (
                <svg
                  className="w-3.5 h-5 text-white/50"
                  viewBox="0 0 14 20"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <rect x="1" y="0" width="12" height="20" rx="3" />
                  <circle cx="7" cy="17" r="1" fill="currentColor" />
                </svg>
              ) : (
                <svg
                  className="w-5 h-4 text-white/50"
                  viewBox="0 0 20 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <rect x="2" y="0" width="16" height="11" rx="1.5" />
                  <path
                    d="M0 13.5h20v1a1.5 1.5 0 01-1.5 1.5h-17A1.5 1.5 0 010 14.5v-1z"
                    fill="currentColor"
                    opacity="0.4"
                  />
                </svg>
              )}
              <span className="text-sm font-medium text-white/70">
                {selectedDevice}
              </span>
            </div>
            <svg
              className={`w-4 h-4 text-white/30 transition-transform ${deviceDropdownOpen ? "rotate-180" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>

          {deviceDropdownOpen && (
            <div className="absolute top-full left-0 right-0 mt-1 z-20 rounded-xl bg-[#1e1e1e] border border-white/[0.06] overflow-hidden shadow-xl shadow-black/40">
              {(["iPhone", "MacBook"] as DeviceType[]).map((device) => (
                <button
                  key={device}
                  onClick={() => {
                    setSelectedDevice(device);
                    setDeviceDropdownOpen(false);
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm transition-all ${
                    selectedDevice === device
                      ? "bg-[#2a2a2a] text-white/80"
                      : "text-white/40 hover:bg-[#252525] hover:text-white/60"
                  }`}
                >
                  {device === "iPhone" ? (
                    <svg
                      className="w-3.5 h-5"
                      viewBox="0 0 14 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <rect x="1" y="0" width="12" height="20" rx="3" />
                      <circle cx="7" cy="17" r="1" fill="currentColor" />
                    </svg>
                  ) : (
                    <svg
                      className="w-5 h-4"
                      viewBox="0 0 20 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <rect x="2" y="0" width="16" height="11" rx="1.5" />
                      <path
                        d="M0 13.5h20v1a1.5 1.5 0 01-1.5 1.5h-17A1.5 1.5 0 010 14.5v-1z"
                        fill="currentColor"
                        opacity="0.4"
                      />
                    </svg>
                  )}
                  {device}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Mockup grid */}
        <div className="px-5 pb-4 grid grid-cols-1 gap-2.5">
          {BUILT_IN_BACKGROUNDS.filter(
            (bg) => bg.device === selectedDevice,
          ).map((bg) => {
            const idx = BUILT_IN_BACKGROUNDS.indexOf(bg);
            return (
              <button
                key={idx}
                onClick={() => selectBuiltInBg(idx)}
                className={`aspect-[3/4] rounded-lg bg-black overflow-hidden border transition-all hover:scale-[1.02] ${
                  activeBgIdx === idx
                    ? "border-white/20 ring-1 ring-white/10"
                    : "border-white/[0.04] hover:border-white/10"
                }`}
              >
                <img
                  src={bg.thumb}
                  alt={bg.name}
                  className="w-full h-full object-cover bg-black"
                />
              </button>
            );
          })}
          {BUILT_IN_BACKGROUNDS.filter((bg) => bg.device === selectedDevice)
            .length === 0 && (
            <div className="py-6 text-center text-[11px] text-white/15">
              Coming soon
            </div>
          )}

          {/* Custom upload */}
          <label className="flex items-center justify-center gap-1.5 cursor-pointer py-2.5 rounded-lg bg-[#141414] hover:bg-[#1a1a1a] border border-dashed border-white/[0.04] hover:border-white/10 text-white/20 hover:text-white/40 transition-all text-[11px]">
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
            Custom
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={handleBgUpload}
              className="hidden"
            />
          </label>
        </div>

        <div className="flex-1" />
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
                className="w-full h-full object-cover bg-black"
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

      {/* Bottom center links */}
      <div className="hidden md:flex fixed bottom-4 left-64 right-56 z-20 items-center justify-center gap-4">
        {/* <a
          href="https://buymeacoffee.com/khushbuildsnow"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold transition-all hover:scale-105 shadow-lg"
          style={{ backgroundColor: "#FFDD00", color: "#000" }}
        >
          <img src="/bmc-logo.svg" alt="" className="h-4 w-4" />
          Buy me a coffee
        </a> */}
        <a
          href="https://buildnowstudios.com"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-white text-black text-sm font-bold transition-all hover:scale-105 shadow-lg"
        >
          <img src="/logo.png" alt="" className="h-5 w-5 rounded-sm" />
          We build sick mobile apps
        </a>
      </div>

      {/* Quality toast */}
      {showToast && (
        <div className="fixed top-4 right-4 md:right-10 z-30 animate-slide-up">
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
