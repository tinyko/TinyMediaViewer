import { useEffect, useRef } from "react";

interface ParticleFieldProps {
  enabled: boolean;
  cursorOffset: { x: number; y: number };
}

type Shape = "circle" | "triangle" | "square";

export function ParticleField({ enabled, cursorOffset }: ParticleFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (!enabled) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

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
    let raf = 0;
    let lastPointerEmitAt = 0;

    const ensureTicking = () => {
      if (raf !== 0) return;
      raf = requestAnimationFrame(tick);
    };

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resize();

    const pushParticles = (x: number, y: number, count = 4, hueOverride?: number) => {
      if (document.hidden) return;
      for (let i = 0; i < count; i++) {
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

    const handlePointer = (event: PointerEvent) => {
      const now = performance.now();
      if (now - lastPointerEmitAt < 32) return;
      lastPointerEmitAt = now;
      pushParticles(event.clientX + cursorOffset.x, event.clientY + cursorOffset.y, 4);
    };

    const handleTouch = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      const now = performance.now();
      if (now - lastPointerEmitAt < 48) return;
      lastPointerEmitAt = now;
      pushParticles(touch.clientX + cursorOffset.x, touch.clientY + cursorOffset.y, 4);
    };

    const tick = () => {
      raf = 0;
      const { width, height } = canvas;
      if (!particles.length || document.hidden) {
        ctx.clearRect(0, 0, width, height);
        return;
      }
      ctx.clearRect(0, 0, width, height);
      const next: typeof particles = [];
      for (const particle of particles) {
        const life = particle.life - 0.016;
        if (life <= 0) continue;
        const x = particle.x + particle.vx;
        const y = particle.y + particle.vy;
        ctx.globalAlpha = life;
        ctx.fillStyle = `hsla(${particle.hue}, 85%, 70%, ${life})`;
        ctx.beginPath();
        if (particle.shape === "circle") {
          ctx.arc(x, y, particle.size, 0, Math.PI * 2);
        } else if (particle.shape === "square") {
          const size = particle.size * 1.6;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(particle.angle);
          ctx.rect(-size / 2, -size / 2, size, size);
          ctx.restore();
        } else {
          const size = particle.size * 2;
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(particle.angle);
          ctx.moveTo(0, -size / 2);
          ctx.lineTo(-size / 2, size / 2);
          ctx.lineTo(size / 2, size / 2);
          ctx.closePath();
          ctx.restore();
        }
        ctx.fill();
        next.push({ ...particle, x, y, life });
      }
      ctx.globalAlpha = 1;
      particles = next;
      if (particles.length) {
        raf = requestAnimationFrame(tick);
      }
    };

    const handleBurst = (event: Event) => {
      const detail = (
        event as CustomEvent<{ x: number; y: number; count?: number; hue?: number }>
      ).detail;
      if (detail) {
        pushParticles(detail.x, detail.y, detail.count ?? 6, detail.hue);
      }
    };

    const handleVisibilityChange = () => {
      if (!document.hidden && particles.length) {
        ensureTicking();
      }
    };

    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", handlePointer, { passive: true });
    window.addEventListener("touchmove", handleTouch, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    canvas.addEventListener("particle-burst", handleBurst as EventListener);

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", handlePointer);
      window.removeEventListener("touchmove", handleTouch);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      canvas.removeEventListener("particle-burst", handleBurst as EventListener);
    };
  }, [cursorOffset.x, cursorOffset.y, enabled]);

  if (!enabled) return null;
  return <canvas ref={canvasRef} className="particle-layer" aria-hidden />;
}
