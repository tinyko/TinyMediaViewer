import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { postPerfDiagnostics } from "../../api";
import type { EffectsMode, EffectsRenderer, PerfDiagEvent } from "../../types";

type Theme = "light" | "dark";

const PERF_SAMPLE_INTERVAL_MS = 10_000;
const AUTO_LONG_TASK_THRESHOLD = 8;

const getInitialTheme = (): Theme => {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem("mv-theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const getInitialEffectsMode = (): EffectsMode => {
  if (typeof window === "undefined") return "auto";
  const stored = window.localStorage.getItem("mv-effects-mode");
  if (stored === "auto" || stored === "off" || stored === "full") return stored;

  // Compatibility with legacy low-performance switch.
  const legacy = window.localStorage.getItem("mv-low-performance");
  if (legacy === "false") return "full";
  return "auto";
};

const getInitialRenderer = (): EffectsRenderer => {
  if (typeof window === "undefined") return "canvas2d";
  const stored = window.localStorage.getItem("mv-effects-renderer");
  return stored === "webgpu" ? "webgpu" : "canvas2d";
};

const round = (value: number) => Math.round(value * 100) / 100;

const hasWebGpu = () =>
  typeof navigator !== "undefined" && typeof (navigator as { gpu?: unknown }).gpu !== "undefined";

export function useThemeAndPerf() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [manualTheme, setManualTheme] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("mv-theme-manual") === "true";
  });

  const [effectsMode, setEffectsMode] = useState<EffectsMode>(getInitialEffectsMode);
  const [effectsRenderer, setEffectsRenderer] = useState<EffectsRenderer>(getInitialRenderer);
  const [autoEffectsDisabled, setAutoEffectsDisabled] = useState(false);
  const [perfNotice, setPerfNotice] = useState<string | null>(null);

  const resolvedRenderer = useMemo<EffectsRenderer>(() => {
    if (effectsRenderer === "webgpu" && hasWebGpu()) return "webgpu";
    return "canvas2d";
  }, [effectsRenderer]);

  const effectsEnabled =
    effectsMode === "full" ? true : effectsMode === "off" ? false : !autoEffectsDisabled;

  const cycleEffectsMode = useCallback(() => {
    setEffectsMode((previous) => {
      const next: EffectsMode =
        previous === "auto" ? "full" : previous === "full" ? "off" : "auto";
      if (next !== "auto") {
        setAutoEffectsDisabled(false);
        setPerfNotice(null);
      }
      if (next === "auto") {
        setAutoEffectsDisabled(false);
      }
      return next;
    });
  }, []);

  const toggleRenderer = useCallback(() => {
    setEffectsRenderer((previous) => (previous === "canvas2d" ? "webgpu" : "canvas2d"));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("mv-theme", theme);
    window.localStorage.setItem("mv-theme-manual", manualTheme ? "true" : "false");
  }, [theme, manualTheme]);

  useEffect(() => {
    window.localStorage.setItem("mv-effects-mode", effectsMode);
    // Keep legacy key synchronized for backward compatibility.
    window.localStorage.setItem("mv-low-performance", effectsMode === "full" ? "false" : "true");
  }, [effectsMode]);

  useEffect(() => {
    window.localStorage.setItem("mv-effects-renderer", effectsRenderer);
  }, [effectsRenderer]);

  useEffect(() => {
    if (manualTheme) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => {
      setTheme(event.matches ? "dark" : "light");
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [manualTheme]);

  const visibleCardsRef = useRef(0);

  const reportVisibleCards = useCallback((count: number) => {
    visibleCardsRef.current = count;
  }, []);

  useEffect(() => {
    let rafId = 0;
    let frameCount = 0;
    let windowStartedAt = performance.now();
    let longTaskCount = 0;

    const sampleLoop = () => {
      frameCount += 1;
      rafId = window.requestAnimationFrame(sampleLoop);
    };

    rafId = window.requestAnimationFrame(sampleLoop);

    let observer: PerformanceObserver | null = null;
    if (typeof PerformanceObserver !== "undefined") {
      try {
        observer = new PerformanceObserver((list) => {
          longTaskCount += list.getEntries().length;
        });
        observer.observe({ entryTypes: ["longtask"] });
      } catch {
        observer = null;
      }
    }

    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsed = Math.max(1, now - windowStartedAt);
      const fpsEstimate = round((frameCount * 1000) / elapsed);
      let note: string | undefined;

      if (
        effectsMode === "auto" &&
        !autoEffectsDisabled &&
        longTaskCount >= AUTO_LONG_TASK_THRESHOLD
      ) {
        setAutoEffectsDisabled(true);
        setPerfNotice("检测到高负载，已自动关闭特效。可点击右上角性能按钮恢复。");
        note = "auto-effects-disabled";
      }

      const event: PerfDiagEvent = {
        ts: Date.now(),
        fpsEstimate,
        longTaskCount10s: longTaskCount,
        visibleCards: visibleCardsRef.current,
        effectsMode,
        renderer: resolvedRenderer,
        note,
      };
      void postPerfDiagnostics({ events: [event] });

      frameCount = 0;
      longTaskCount = 0;
      windowStartedAt = now;
    }, PERF_SAMPLE_INTERVAL_MS);

    return () => {
      window.clearInterval(timer);
      window.cancelAnimationFrame(rafId);
      observer?.disconnect();
    };
  }, [autoEffectsDisabled, effectsMode, resolvedRenderer]);

  return {
    theme,
    setTheme,
    manualTheme,
    setManualTheme,
    effectsMode,
    cycleEffectsMode,
    effectsRenderer,
    resolvedRenderer,
    toggleRenderer,
    effectsEnabled,
    autoEffectsDisabled,
    perfNotice,
    reportVisibleCards,
  };
}
