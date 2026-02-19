import { type RefObject, useEffect, useRef } from "react";

interface HeartPulseLayerProps {
  enabled: boolean;
  hoveredCardRef: RefObject<HTMLButtonElement | null>;
  onHueChange: (hue: number) => void;
  cursorOffset: { x: number; y: number };
  pulseOffsetY: number;
}

export function HeartPulseLayer({
  enabled,
  hoveredCardRef,
  onHueChange,
  cursorOffset,
  pulseOffsetY,
}: HeartPulseLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hoverTimerRef = useRef<number | null>(null);
  const hoverPointRef = useRef<{ x: number; y: number } | null>(null);
  const timeoutsRef = useRef<number[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (!enabled) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    let hearts: Array<{ x: number; y: number; progress: number; hue: number; scale: number }> =
      [];
    let raf = 0;

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();

    const schedule = (callback: () => void, delay: number) => {
      const id = window.setTimeout(callback, delay);
      timeoutsRef.current.push(id);
    };

    const addHeart = (x: number, y: number, scale: number, hue: number, particleCount = 60) => {
      const heartY = y + pulseOffsetY;
      onHueChange(hue);
      hearts.push({ x, y: heartY, progress: 0, hue, scale });
      if (hearts.length > 120) hearts = hearts.slice(-120);

      const particleCanvas = document.querySelector(".particle-layer") as HTMLCanvasElement | null;
      if (particleCanvas) {
        const event = new CustomEvent("particle-burst", {
          detail: { x, y, count: particleCount, hue },
        });
        particleCanvas.dispatchEvent(event);
      }

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
    };

    const doubleBeat = (x: number, y: number) => {
      const hue = Math.random() * 360;
      addHeart(x, y, 1.25, hue, 70);
      schedule(() => addHeart(x, y, 1.08, hue, 36), 140);
    };

    const stopHoverPulse = () => {
      if (hoverTimerRef.current) {
        window.clearInterval(hoverTimerRef.current);
      }
      hoverTimerRef.current = null;
      for (const timeoutId of timeoutsRef.current) {
        window.clearTimeout(timeoutId);
      }
      timeoutsRef.current = [];
    };

    const startHoverPulse = (x: number, y: number) => {
      if (hoverTimerRef.current) return;
      doubleBeat(x, y);
      hoverTimerRef.current = window.setInterval(() => {
        const point = hoverPointRef.current ?? { x, y };
        doubleBeat(point.x, point.y);
      }, 1400);
    };

    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const isHeartTarget = target.closest(".heart-target");
      const x = event.clientX + cursorOffset.x;
      const y = event.clientY + cursorOffset.y;
      hoverPointRef.current = { x, y };
      if (isHeartTarget) {
        startHoverPulse(x, y);
      } else {
        hoverPointRef.current = null;
        stopHoverPulse();
      }
    };

    const drawHeart = (x: number, y: number, size: number) => {
      const s = size;
      ctx.save();
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.moveTo(0, -0.6 * s);
      ctx.bezierCurveTo(-s, -0.8 * s, -1.2 * s, -0.1 * s, -0.1 * s, 0.9 * s);
      ctx.bezierCurveTo(1.2 * s, -0.1 * s, s, -0.8 * s, 0, -0.6 * s);
      ctx.closePath();
      ctx.restore();
    };

    const tick = () => {
      const { width, height } = canvas;
      ctx.clearRect(0, 0, width, height);
      const next: typeof hearts = [];
      for (const heart of hearts) {
        const progress = heart.progress + 0.02;
        if (progress >= 1) continue;
        const scale = (16 + 36 * progress) * heart.scale;
        ctx.beginPath();
        drawHeart(heart.x, heart.y, scale);
        ctx.strokeStyle = `hsla(${heart.hue}, 85%, 70%, ${1 - progress})`;
        ctx.lineWidth = 2 * (1 - progress * 0.6);
        ctx.stroke();
        next.push({ ...heart, progress });
      }
      hearts = next;
      raf = requestAnimationFrame(tick);
    };

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointer, { passive: true });
    window.addEventListener("pointerenter", onPointer, { passive: true });
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointer);
      window.removeEventListener("pointerenter", onPointer);
      stopHoverPulse();
    };
  }, [
    cursorOffset.x,
    cursorOffset.y,
    enabled,
    hoveredCardRef,
    onHueChange,
    pulseOffsetY,
  ]);

  if (!enabled) return null;
  return <canvas ref={canvasRef} className="heart-layer" aria-hidden />;
}
