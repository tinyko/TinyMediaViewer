import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { MediaItem } from "../../types";

const CURSOR_OFFSET = { x: 0, y: 0 };

const makeHeartCursor = (hue: number) => {
  const color = `hsl(${hue},85%,70%)`;
  const stroke = `hsl(${hue},90%,92%)`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'><path d='M16 29s-9-5.7-12-12c-3-6.3 4-13 12-5.5C24-1 31 5.7 28 12 25 18.3 16 29 16 29z' fill='${color}' stroke='${stroke}' stroke-width='1.6' stroke-linejoin='round'/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, auto`;
};

interface UseAppInteractionsOptions {
  selected: MediaItem | null;
  effectsEnabled: boolean;
  previewScrollRef: RefObject<HTMLDivElement | null>;
  resetRootPreviewQueue: () => void;
  scrollTrackingKey: string;
}

export function useAppInteractions({
  selected,
  effectsEnabled,
  previewScrollRef,
  resetRootPreviewQueue,
  scrollTrackingKey,
}: UseAppInteractionsOptions) {
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [heartCursorVisible, setHeartCursorVisible] = useState(false);

  const heartCursorRef = useRef<HTMLDivElement | null>(null);
  const hoveredCardRef = useRef<HTMLButtonElement | null>(null);
  const heartCursorPos = useRef({ x: 0, y: 0 });
  const heartCursorRaf = useRef<number | null>(null);
  const heartCursorVisibleRef = useRef(false);
  const heartHueRef = useRef(0);

  const applyHeartCursorStyle = useCallback((hue: number) => {
    const color = `hsl(${hue},85%,70%)`;
    const cursor = makeHeartCursor(hue);
    document.documentElement.style.setProperty("--cursor-heart", cursor);
    document.documentElement.style.setProperty("--cursor-heart-fill", color);
  }, []);

  const onHeartHueChange = useCallback(
    (hue: number) => {
      heartHueRef.current = hue;
      if (!effectsEnabled) return;
      applyHeartCursorStyle(hue);
    },
    [applyHeartCursorStyle, effectsEnabled]
  );

  useEffect(() => {
    heartCursorVisibleRef.current = heartCursorVisible;
  }, [heartCursorVisible]);

  useEffect(() => {
    if (!selected) return;

    const body = document.body;
    const documentElement = document.documentElement;
    const scrollY = window.scrollY;
    const originalBodyOverflow = body.style.overflow;
    const originalBodyPosition = body.style.position;
    const originalBodyTop = body.style.top;
    const originalBodyLeft = body.style.left;
    const originalBodyRight = body.style.right;
    const originalBodyWidth = body.style.width;
    const originalBodyOverscrollBehavior = body.style.overscrollBehavior;
    const originalDocumentOverflow = documentElement.style.overflow;
    const originalDocumentOverscrollBehavior = documentElement.style.overscrollBehavior;

    body.style.overflow = "hidden";
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.left = "0";
    body.style.right = "0";
    body.style.width = "100%";
    body.style.overscrollBehavior = "none";
    documentElement.style.overflow = "hidden";
    documentElement.style.overscrollBehavior = "none";

    return () => {
      body.style.overflow = originalBodyOverflow;
      body.style.position = originalBodyPosition;
      body.style.top = originalBodyTop;
      body.style.left = originalBodyLeft;
      body.style.right = originalBodyRight;
      body.style.width = originalBodyWidth;
      body.style.overscrollBehavior = originalBodyOverscrollBehavior;
      documentElement.style.overflow = originalDocumentOverflow;
      documentElement.style.overscrollBehavior = originalDocumentOverscrollBehavior;
      if (scrollY !== 0) {
        window.scrollTo({ top: scrollY, behavior: "auto" });
      }
    };
  }, [selected]);

  useEffect(() => {
    const el = previewScrollRef.current;
    if (!el) return;

    const onScroll = () => setShowScrollTop(el.scrollTop > 200);
    const frame = window.requestAnimationFrame(onScroll);
    el.addEventListener("scroll", onScroll);

    return () => {
      window.cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
    };
  }, [previewScrollRef, scrollTrackingKey]);

  useEffect(() => {
    if (!effectsEnabled) return;

    const setVisibility = (visible: boolean) => {
      if (visible === heartCursorVisibleRef.current) return;
      heartCursorVisibleRef.current = visible;
      setHeartCursorVisible(visible);
    };

    const updateOverlay = () => {
      heartCursorRaf.current = null;
      const el = heartCursorRef.current;
      if (!el) return;
      el.style.left = `${heartCursorPos.current.x}px`;
      el.style.top = `${heartCursorPos.current.y}px`;
    };

    const onMove = (event: PointerEvent) => {
      const target = (event.target as HTMLElement | null)?.closest(".heart-target");
      const show = Boolean(target);
      setVisibility(show);
      if (!show) return;
      heartCursorPos.current = {
        x: event.clientX + CURSOR_OFFSET.x,
        y: event.clientY + CURSOR_OFFSET.y,
      };
      if (heartCursorRaf.current === null) {
        heartCursorRaf.current = requestAnimationFrame(updateOverlay);
      }
    };

    const onLeave = () => setVisibility(false);

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave);

    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
      if (heartCursorRaf.current !== null) {
        cancelAnimationFrame(heartCursorRaf.current);
        heartCursorRaf.current = null;
      }
    };
  }, [effectsEnabled]);

  useEffect(() => {
    if (!effectsEnabled) return;
    applyHeartCursorStyle(heartHueRef.current);
  }, [applyHeartCursorStyle, effectsEnabled]);

  useEffect(() => {
    return () => {
      resetRootPreviewQueue();
    };
  }, [resetRootPreviewQueue]);

  const scrollToTop = useCallback(() => {
    previewScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [previewScrollRef]);

  return {
    showScrollTop,
    heartCursorVisible,
    heartCursorRef,
    hoveredCardRef,
    onHeartHueChange,
    scrollToTop,
  };
}
