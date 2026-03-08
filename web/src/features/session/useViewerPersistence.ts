import { useEffect, useMemo, useRef } from "react";
import type { ViewerPreferences } from "../../types";

const VIEWER_PREFERENCES_SAVE_DEBOUNCE_MS = 250;

const areViewerPreferencesEqual = (
  left: ViewerPreferences | null,
  right: ViewerPreferences
) =>
  left !== null &&
  left.search === right.search &&
  left.sortMode === right.sortMode &&
  left.randomSeed === right.randomSeed &&
  left.mediaSort === right.mediaSort &&
  left.mediaRandomSeed === right.mediaRandomSeed &&
  left.mediaFilter === right.mediaFilter &&
  left.categoryPath === right.categoryPath &&
  left.theme === right.theme &&
  left.manualTheme === right.manualTheme &&
  left.effectsMode === right.effectsMode &&
  left.effectsRenderer === right.effectsRenderer;

interface UseViewerPersistenceOptions {
  persistedViewerPreferences?: ViewerPreferences;
  preferencesReady: boolean;
  themePreferencesReady: boolean;
  currentViewerPreferences: ViewerPreferences;
  restoreCategory: (path: string | null) => void;
  persistViewerPreferences: (preferences: ViewerPreferences) => void;
  setSearch: (value: string) => void;
  setMediaFilter: (value: "image" | "video") => void;
  setSortMode: (value: ViewerPreferences["sortMode"]) => void;
  setRandomSeed: (value: number) => void;
  setMediaSort: (value: ViewerPreferences["mediaSort"]) => void;
  setMediaRandomSeed: (value: number) => void;
}

export function useViewerPersistence({
  persistedViewerPreferences,
  preferencesReady,
  themePreferencesReady,
  currentViewerPreferences,
  restoreCategory,
  persistViewerPreferences,
  setSearch,
  setMediaFilter,
  setSortMode,
  setRandomSeed,
  setMediaSort,
  setMediaRandomSeed,
}: UseViewerPersistenceOptions) {
  const hydratedPreferencesRef = useRef(false);
  const lastSavedViewerPreferencesRef = useRef<ViewerPreferences | null>(null);
  const viewerPreferencesHydrated = preferencesReady;

  useEffect(() => {
    if (hydratedPreferencesRef.current || !preferencesReady) {
      return;
    }

    if (persistedViewerPreferences) {
      setSearch(persistedViewerPreferences.search);
      setMediaFilter(persistedViewerPreferences.mediaFilter);
      setSortMode(persistedViewerPreferences.sortMode);
      setRandomSeed(persistedViewerPreferences.randomSeed);
      setMediaSort(persistedViewerPreferences.mediaSort);
      setMediaRandomSeed(persistedViewerPreferences.mediaRandomSeed);
      restoreCategory(persistedViewerPreferences.categoryPath ?? null);
      lastSavedViewerPreferencesRef.current = persistedViewerPreferences;
    }
    hydratedPreferencesRef.current = true;
  }, [
    persistedViewerPreferences,
    preferencesReady,
    restoreCategory,
    setMediaFilter,
    setMediaRandomSeed,
    setMediaSort,
    setRandomSeed,
    setSearch,
    setSortMode,
  ]);

  useEffect(() => {
    if (persistedViewerPreferences) {
      lastSavedViewerPreferencesRef.current = persistedViewerPreferences;
    }
  }, [persistedViewerPreferences]);

  useEffect(() => {
    if (
      !viewerPreferencesHydrated ||
      !preferencesReady ||
      !themePreferencesReady ||
      !persistedViewerPreferences
    ) {
      return;
    }
    if (
      areViewerPreferencesEqual(
        lastSavedViewerPreferencesRef.current,
        currentViewerPreferences
      )
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      persistViewerPreferences(currentViewerPreferences);
    }, VIEWER_PREFERENCES_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    currentViewerPreferences,
    persistViewerPreferences,
    persistedViewerPreferences,
    preferencesReady,
    themePreferencesReady,
    viewerPreferencesHydrated,
  ]);

  const preferredInitialCategoryPath = useMemo(
    () => (viewerPreferencesHydrated ? (persistedViewerPreferences?.categoryPath ?? null) : null),
    [persistedViewerPreferences?.categoryPath, viewerPreferencesHydrated]
  );

  return {
    viewerPreferencesHydrated,
    preferredInitialCategoryPath,
  };
}
