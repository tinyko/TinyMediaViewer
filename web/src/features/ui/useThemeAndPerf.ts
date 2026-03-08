import { useCallback, useEffect, useRef, useState } from "react";
import { postPerfDiagnostics } from "../../api";
import type {
  EffectsMode,
  EffectsRenderer,
  PerfDiagEvent,
  ViewerPreferences,
  ViewerTheme,
} from "../../types";

type Theme = ViewerTheme;
type ThemePreferences = Pick<
  ViewerPreferences,
  "theme" | "manualTheme" | "effectsMode" | "effectsRenderer"
>;

const PERF_SAMPLE_INTERVAL_MS = 10_000;
const AUTO_LONG_TASK_THRESHOLD = 8;

const getSystemTheme = (): Theme => {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const round = (value: number) => Math.round(value * 100) / 100;

interface UseThemeAndPerfOptions {
  initialPreferences?: ThemePreferences | null;
  preferencesReady?: boolean;
}

export function useThemeAndPerf({
  initialPreferences = null,
  preferencesReady = true,
}: UseThemeAndPerfOptions = {}) {
  const [theme, setTheme] = useState<Theme>(getSystemTheme);
  const [manualTheme, setManualTheme] = useState(false);
  const [effectsMode, setEffectsMode] = useState<EffectsMode>("auto");
  const [effectsRenderer, setEffectsRenderer] = useState<EffectsRenderer>("webgpu");
  const [resolvedRenderer, setResolvedRenderer] = useState<EffectsRenderer>("webgpu");
  const [autoEffectsDisabled, setAutoEffectsDisabled] = useState(false);
  const [perfNotice, setPerfNotice] = useState<string | null>(null);
  const [preferencesHydrated, setPreferencesHydrated] = useState(false);
  const hydratedPreferencesRef = useRef(false);

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

  const reportResolvedRenderer = useCallback((renderer: EffectsRenderer) => {
    setResolvedRenderer((previous) => (previous === renderer ? previous : renderer));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  useEffect(() => {
    setResolvedRenderer(effectsRenderer);
  }, [effectsRenderer]);

  useEffect(() => {
    if (hydratedPreferencesRef.current || !preferencesReady) return;
    if (initialPreferences) {
      setTheme(initialPreferences.theme);
      setManualTheme(initialPreferences.manualTheme);
      setEffectsMode(initialPreferences.effectsMode);
      setEffectsRenderer(initialPreferences.effectsRenderer);
      setResolvedRenderer(initialPreferences.effectsRenderer);
    }
    hydratedPreferencesRef.current = true;
    setPreferencesHydrated(true);
  }, [initialPreferences, preferencesReady]);

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
    reportResolvedRenderer,
    effectsEnabled,
    autoEffectsDisabled,
    perfNotice,
    reportVisibleCards,
    preferencesHydrated,
  };
}
