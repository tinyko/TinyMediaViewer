import { type RefObject, useEffect, useRef, useState } from "react";
import type { EffectsRenderer } from "../../types";
import {
  createEffectsRenderer,
  type EffectsHeart,
  type EffectsParticle,
  type EffectsRendererAdapter,
} from "./renderers";

interface EffectsStageProps {
  enabled: boolean;
  requestedRenderer: EffectsRenderer;
  hoveredCardRef: RefObject<HTMLButtonElement | null>;
  onHueChange: (hue: number) => void;
  onResolvedRendererChange: (renderer: EffectsRenderer) => void;
  cursorOffset: { x: number; y: number };
  pulseOffsetY: number;
}

type Shape = "circle" | "triangle" | "square";

export function EffectsStage({
  enabled,
  requestedRenderer,
  hoveredCardRef,
  onHueChange,
  onResolvedRendererChange,
  cursorOffset,
  pulseOffsetY,
}: EffectsStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [canvasMode, setCanvasMode] = useState<EffectsRenderer>(requestedRenderer);

  useEffect(() => {
    setCanvasMode(requestedRenderer);
  }, [requestedRenderer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let adapter: EffectsRendererAdapter | null = null;
    let raf = 0;
    let lastPointerEmitAt = 0;
    let hoverTimerId: number | null = null;
    let hoverPoint: { x: number; y: number } | null = null;
    let scheduledTimeouts: number[] = [];
    let particles: Array<{
      x: number;
      y: number;
      vx: number;
      vy: number;
      life: number;
      size: number;
      hue: number;
      shape: Shape;
      angle: number;
    }> = [];
    let hearts: Array<{ x: number; y: number; progress: number; hue: number; scale: number }> = [];
    let viewportWidth = Math.max(1, Math.round(window.innerWidth));
    let viewportHeight = Math.max(1, Math.round(window.innerHeight));

    const cleanupAnimation = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      if (hoverTimerId) {
        window.clearInterval(hoverTimerId);
        hoverTimerId = null;
      }
      for (const timeoutId of scheduledTimeouts) {
        window.clearTimeout(timeoutId);
      }
      scheduledTimeouts = [];
    };

    const resetHoveredCardStyle = () => {
      const card = hoveredCardRef.current;
      if (!card) return;
      card.classList.remove("heart-beat");
    };

    const resize = () => {
      viewportWidth = Math.max(1, Math.round(window.innerWidth));
      viewportHeight = Math.max(1, Math.round(window.innerHeight));
      adapter?.resize(viewportWidth, viewportHeight);
    };

    const ensureTicking = () => {
      if (!enabled || raf !== 0) return;
      raf = window.requestAnimationFrame(tick);
    };

    const pushParticles = (x: number, y: number, count = 4, hueOverride?: number) => {
      if (!enabled || document.hidden) return;
      for (let index = 0; index < count; index += 1) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 1.6 + 0.4;
        const shape: Shape =
          Math.random() < 0.5
            ? "circle"
            : Math.random() < 0.5
              ? "triangle"
              : "square";
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: Math.random() * 0.6 + 0.5,
          size: Math.random() * 1.5 + 1,
          hue: hueOverride ?? Math.random() * 360,
          shape,
          angle: Math.random() * Math.PI * 2,
        });
      }
      if (particles.length > 320) {
        particles = particles.slice(-320);
      }
      ensureTicking();
    };

    const addHeart = (x: number, y: number, scale: number, hue: number, particleCount = 24) => {
      const heartY = y + pulseOffsetY;
      onHueChange(hue);
      hearts.push({ x, y: heartY, progress: 0, hue, scale });
      if (hearts.length > 80) {
        hearts = hearts.slice(-80);
      }
      pushParticles(x, y, particleCount, hue);

      const card = hoveredCardRef.current;
      if (card) {
        const border = `hsl(${hue},85%,70%)`;
        card.style.setProperty("--heart-border", border);
        card.style.setProperty("--heart-shadow-strong", `hsla(${hue},85%,70%,0.25)`);
        card.style.setProperty("--heart-shadow-mid", `hsla(${hue},85%,70%,0.18)`);
        card.style.setProperty("--heart-shadow-weak", `hsla(${hue},85%,70%,0.12)`);
        card.style.setProperty("--heart-beat-scale", scale.toString());
        card.classList.remove("heart-beat");
        void card.offsetWidth;
        card.classList.add("heart-beat");
      }

      ensureTicking();
    };

    const schedule = (callback: () => void, delay: number) => {
      const timeoutId = window.setTimeout(callback, delay);
      scheduledTimeouts.push(timeoutId);
    };

    const doubleBeat = (x: number, y: number) => {
      const hue = Math.random() * 360;
      addHeart(x, y, 1.2, hue, 28);
      schedule(() => addHeart(x, y, 1.06, hue, 16), 140);
    };

    const stopHoverPulse = () => {
      if (hoverTimerId) {
        window.clearInterval(hoverTimerId);
        hoverTimerId = null;
      }
      hoverPoint = null;
      for (const timeoutId of scheduledTimeouts) {
        window.clearTimeout(timeoutId);
      }
      scheduledTimeouts = [];
    };

    const startHoverPulse = (x: number, y: number) => {
      if (hoverTimerId) return;
      doubleBeat(x, y);
      hoverTimerId = window.setInterval(() => {
        const point = hoverPoint ?? { x, y };
        doubleBeat(point.x, point.y);
      }, 1800);
    };

    const tick = () => {
      raf = 0;

      const nextParticlesState: typeof particles = [];
      const nextParticlesScene: EffectsParticle[] = [];
      for (const particle of particles) {
        const life = particle.life - 0.016;
        if (life <= 0) continue;
        const x = particle.x + particle.vx;
        const y = particle.y + particle.vy;
        nextParticlesState.push({
          ...particle,
          x,
          y,
          life,
        });
        nextParticlesScene.push({
          x,
          y,
          size: particle.size,
          life,
          hue: particle.hue,
          shape: particle.shape,
          angle: particle.angle,
        });
      }
      particles = nextParticlesState;

      const nextHeartsState: typeof hearts = [];
      const nextHeartsScene: EffectsHeart[] = [];
      for (const heart of hearts) {
        const progress = heart.progress + 0.03;
        if (progress >= 1) continue;
        nextHeartsState.push({
          ...heart,
          progress,
        });
        nextHeartsScene.push({
          x: heart.x,
          y: heart.y,
          progress,
          hue: heart.hue,
          scale: heart.scale,
        });
      }
      hearts = nextHeartsState;

      if (!nextParticlesScene.length && !nextHeartsScene.length) {
        adapter?.clear(viewportWidth, viewportHeight);
        return;
      }

      adapter?.render({
        width: viewportWidth,
        height: viewportHeight,
        particles: nextParticlesScene,
        hearts: nextHeartsScene,
      });

      if (!document.hidden) {
        ensureTicking();
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      const x = event.clientX + cursorOffset.x;
      const y = event.clientY + cursorOffset.y;
      hoverPoint = { x, y };

      const now = performance.now();
      if (now - lastPointerEmitAt >= 32) {
        lastPointerEmitAt = now;
        pushParticles(x, y, 4);
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest(".heart-target")) {
        startHoverPulse(x, y);
      } else {
        stopHoverPulse();
      }
    };

    const handleTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      const now = performance.now();
      if (now - lastPointerEmitAt < 48) return;
      lastPointerEmitAt = now;
      pushParticles(touch.clientX + cursorOffset.x, touch.clientY + cursorOffset.y, 4);
    };

    const handleVisibilityChange = () => {
      if (!document.hidden && (particles.length || hearts.length)) {
        ensureTicking();
      }
    };

    const init = async () => {
      try {
        adapter = await createEffectsRenderer(canvas, canvasMode);
      } catch (error) {
        if (cancelled) return;
        if (canvasMode === "webgpu") {
          onResolvedRendererChange("canvas2d");
          setCanvasMode("canvas2d");
          return;
        }
        throw error;
      }

      if (cancelled || !adapter) {
        adapter?.dispose();
        return;
      }

      resize();
      onResolvedRendererChange(adapter.kind);
      adapter.clear(viewportWidth, viewportHeight);

      if (!enabled) {
        return;
      }

      window.addEventListener("resize", resize);
      window.addEventListener("pointermove", handlePointerMove, { passive: true });
      window.addEventListener("pointerleave", stopHoverPulse);
      window.addEventListener("touchmove", handleTouchMove, { passive: true });
      document.addEventListener("visibilitychange", handleVisibilityChange);
    };

    void init();

    return () => {
      cancelled = true;
      cleanupAnimation();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerleave", stopHoverPulse);
      window.removeEventListener("touchmove", handleTouchMove);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      resetHoveredCardStyle();
      adapter?.clear(viewportWidth, viewportHeight);
      adapter?.dispose();
    };
  }, [
    canvasMode,
    cursorOffset.x,
    cursorOffset.y,
    enabled,
    hoveredCardRef,
    onHueChange,
    onResolvedRendererChange,
    pulseOffsetY,
  ]);

  return <canvas key={canvasMode} ref={canvasRef} className="effects-stage" aria-hidden />;
}
