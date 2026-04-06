import { useState, useEffect, useRef, useCallback } from "react";

export interface VideoPlayerState {
  videoElement: HTMLVideoElement | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  hasAudio: boolean;
  fps: number;
  play(): void;
  pause(): void;
  seek(time: number): void;
  togglePlayPause(): void;
}

export function useVideoPlayer(
  videoUrl: string | null,
  onFrame?: () => void,
): VideoPlayerState {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoReady, setVideoReady] = useState<HTMLVideoElement | null>(null);
  const rafRef = useRef<number>(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hasAudio, setHasAudio] = useState(false);
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;

  // Create/destroy video element when URL changes
  useEffect(() => {
    if (!videoUrl) {
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.src = "";
        videoRef.current = null;
      }
      setVideoReady(null);
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setHasAudio(false);
      return;
    }

    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.playsInline = true;
    video.preload = "auto";
    video.muted = false;
    video.src = videoUrl;
    videoRef.current = video;

    video.addEventListener("loadedmetadata", () => {
      setDuration(video.duration);
      // Detect audio
      const hasAudioTrack =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (video as any).mozHasAudio ||
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Boolean((video as any).webkitAudioDecodedByteCount) ||
        Boolean(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (video as any).audioTracks && (video as any).audioTracks.length > 0,
        );
      setHasAudio(hasAudioTrack);
    });

    video.addEventListener("loadeddata", () => {
      // Signal that the video element is ready — triggers re-render
      setVideoReady(video);
      // Auto-play on load (muted for browser autoplay policy)
      video.muted = true;
      video.play().then(() => {
        setIsPlaying(true);
      }).catch(() => {
        // Autoplay blocked — just render first frame
      });
      onFrameRef.current?.();
    });

    video.addEventListener("ended", () => {
      setIsPlaying(false);
    });

    return () => {
      cancelAnimationFrame(rafRef.current);
      video.pause();
      video.src = "";
      setVideoReady(null);
      videoRef.current = null;
    };
  }, [videoUrl]);

  // RAF loop for frame updates while playing
  useEffect(() => {
    if (!isPlaying || !videoRef.current) return;

    const tick = () => {
      if (videoRef.current) {
        setCurrentTime(videoRef.current.currentTime);
        onFrameRef.current?.();
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying]);

  const play = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.play();
      setIsPlaying(true);
    }
  }, []);

  const pause = useCallback(() => {
    if (videoRef.current) {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  }, []);

  const seek = useCallback((time: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = time;
      setCurrentTime(time);
      // Trigger a frame render on seek even when paused
      onFrameRef.current?.();
    }
  }, []);

  const togglePlayPause = useCallback(() => {
    if (videoRef.current) {
      if (videoRef.current.paused) {
        videoRef.current.play();
        setIsPlaying(true);
      } else {
        videoRef.current.pause();
        setIsPlaying(false);
      }
    }
  }, []);

  return {
    videoElement: videoReady,
    isPlaying,
    currentTime,
    duration,
    hasAudio,
    fps: 30, // default; can be detected from video metadata if needed
    play,
    pause,
    seek,
    togglePlayPause,
  };
}
