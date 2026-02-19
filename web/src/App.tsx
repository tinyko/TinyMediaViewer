import { useCallback, useMemo, useRef, useState } from "react";
import "./App.css";
import "./features/effects/effects.css";
import type { MediaItem } from "./types";
import { MediaPreviewModal } from "./features/preview/MediaPreviewModal";
import { useModalNavigation } from "./features/preview/useModalNavigation";
import { ParticleField } from "./features/effects/ParticleField";
import { HeartPulseLayer } from "./features/effects/HeartPulseLayer";
import { filterMediaByKind, sortMediaByTime } from "./features/category/mediaUtils";
import { useRootFolder } from "./features/root/useRootFolder";
import { usePreviewBackfillQueue } from "./features/previews/usePreviewBackfillQueue";
import { useCategoryMedia } from "./features/category/useCategoryMedia";
import { useThemeAndPerf } from "./features/ui/useThemeAndPerf";
import { useAppInteractions } from "./features/ui/useAppInteractions";
import { Toolbar } from "./components/Toolbar";
import { MainContent } from "./components/MainContent";

const CURSOR_OFFSET = { x: 0, y: 0 };
const HEART_PULSE_OFFSET_Y = 0;

const APP_VERSION = import.meta.env.VITE_TMV_APP_VERSION ?? "0.1.0";
const APP_SHORT_COMMIT = import.meta.env.VITE_TMV_SHORT_COMMIT ?? "dev";
const APP_BUILD_TIME = import.meta.env.VITE_TMV_BUILD_TIME ?? "unknown";

function App() {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [mediaFilter, setMediaFilter] = useState<"image" | "video">("image");
  const [sortMode, setSortMode] = useState<"time" | "name">("time");
  const [mediaSort, setMediaSort] = useState<"asc" | "desc">("desc");
  const [heartHue, setHeartHue] = useState(0);
  const [visibleCards, setVisibleCards] = useState(0);

  const previewScrollRef = useRef<HTMLDivElement | null>(null);

  const { folder, setFolder, loading, error } = useRootFolder();
  const { enqueueRootPreviewPaths, resetRootPreviewQueue } = usePreviewBackfillQueue({
    folder,
    setFolder,
  });
  const {
    categoryPath,
    categoryPreview,
    categoryVisibleCount,
    categoryLoading,
    categoryLoadingMore,
    categoryHasMore,
    categoryError,
    setCategoryVisibleCount,
    handleSelectCategory,
    loadMoreCategory,
  } = useCategoryMedia({ rootFolder: folder });
  const {
    theme,
    setTheme,
    setManualTheme,
    effectsMode,
    cycleEffectsMode,
    effectsRenderer,
    resolvedRenderer,
    toggleRenderer,
    effectsEnabled,
    perfNotice,
  } = useThemeAndPerf({ visibleCards });

  const versionLabel = `v${APP_VERSION}`;
  const versionFingerprint = `${versionLabel}+${APP_SHORT_COMMIT} (${APP_BUILD_TIME})`;

  const filteredAccounts = useMemo(() => {
    if (!folder) return [];
    return folder.subfolders
      .filter((item) => {
        const matchesText = item.name.toLowerCase().includes(search.toLowerCase());
        if (!matchesText) return false;
        if (!item.countsReady || !item.previewReady) return true;
        return mediaFilter === "image"
          ? item.counts.images + item.counts.gifs > 0
          : item.counts.videos > 0;
      })
      .sort((a, b) => (sortMode === "name" ? a.name.localeCompare(b.name) : b.modified - a.modified));
  }, [folder, mediaFilter, search, sortMode]);
  const filteredCategoryMedia = useMemo(() => {
    const source = categoryPreview?.media ?? [];
    const filtered = filterMediaByKind(source, mediaFilter);
    return sortMediaByTime(filtered, mediaSort);
  }, [categoryPreview, mediaFilter, mediaSort]);
  const visibleCategoryMedia = useMemo(
    () => filteredCategoryMedia.slice(0, categoryVisibleCount),
    [categoryVisibleCount, filteredCategoryMedia]
  );

  const selectedCategorySummary = useMemo(() => {
    if (!folder || !categoryPath) return null;
    return folder.subfolders.find((item) => item.path === categoryPath) ?? null;
  }, [folder, categoryPath]);
  const selectedCounts = selectedCategorySummary?.countsReady ? selectedCategorySummary.counts : null;
  const totalMedia = selectedCounts
    ? selectedCounts.images + selectedCounts.gifs + selectedCounts.videos
    : categoryPreview?.totals.media ?? 0;
  const filteredCount = selectedCounts
    ? mediaFilter === "image"
      ? selectedCounts.images + selectedCounts.gifs
      : selectedCounts.videos
    : filteredCategoryMedia.length;
  const meterPercent = totalMedia ? Math.min(100, (filteredCount / totalMedia) * 100) : 0;

  const onVisibleCategoryPathsChange = useCallback(
    (paths: string[]) => enqueueRootPreviewPaths(paths),
    [enqueueRootPreviewPaths]
  );
  const onVisibleCardsChange = useCallback((count: number) => setVisibleCards(count), []);
  const onSelectCategory = useCallback(
    (path: string) => {
      void handleSelectCategory(path);
    },
    [handleSelectCategory]
  );
  const onReachEnd = useCallback(() => {
    if (visibleCategoryMedia.length < filteredCategoryMedia.length) {
      setCategoryVisibleCount((previous) => Math.min(previous + 32, filteredCategoryMedia.length));
      return;
    }
    if (categoryHasMore && !categoryLoadingMore) {
      void loadMoreCategory();
    }
  }, [
    categoryHasMore,
    categoryLoadingMore,
    filteredCategoryMedia.length,
    loadMoreCategory,
    setCategoryVisibleCount,
    visibleCategoryMedia.length,
  ]);

  const scrollTrackingKey = `${categoryPreview?.folder.path ?? "-"}|${mediaFilter}|${mediaSort}|${sortMode}`;
  const { showScrollTop, heartCursorVisible, heartCursorRef, hoveredCardRef, scrollToTop } =
    useAppInteractions({
      selected,
      effectsEnabled,
      heartHue,
      previewScrollRef,
      resetRootPreviewQueue,
      scrollTrackingKey,
    });
  const { onClose, onPrev, onNext, hasPrev, hasNext } = useModalNavigation({
    selected,
    media: filteredCategoryMedia,
    onSelect: setSelected,
  });

  return (
    <div className="page">
      <ParticleField enabled={effectsEnabled} cursorOffset={CURSOR_OFFSET} />
      <HeartPulseLayer
        enabled={effectsEnabled}
        hoveredCardRef={hoveredCardRef}
        onHueChange={setHeartHue}
        cursorOffset={CURSOR_OFFSET}
        pulseOffsetY={HEART_PULSE_OFFSET_Y}
      />
      {effectsEnabled && heartCursorVisible && (
        <div
          ref={heartCursorRef}
          className="cursor-heart-overlay"
          style={{ transform: "translate(-50%, -50%)" }}
        />
      )}

      <Toolbar
        versionLabel={versionLabel}
        versionFingerprint={versionFingerprint}
        theme={theme}
        onToggleTheme={() => {
          setManualTheme(true);
          setTheme(theme === "light" ? "dark" : "light");
        }}
        effectsMode={effectsMode}
        onCycleEffectsMode={cycleEffectsMode}
        rendererLabel={
          effectsRenderer === "webgpu" ? (resolvedRenderer === "webgpu" ? "WG" : "WG×") : "2D"
        }
        onToggleRenderer={toggleRenderer}
        perfNotice={perfNotice}
        loading={loading}
        error={error}
        sortMode={sortMode}
        setSortMode={setSortMode}
        search={search}
        setSearch={setSearch}
        filteredCount={filteredCount}
        totalMedia={totalMedia}
        meterPercent={meterPercent}
        mediaSort={mediaSort}
        setMediaSort={setMediaSort}
        mediaFilter={mediaFilter}
        setMediaFilter={setMediaFilter}
      />

      <MainContent
        accounts={filteredAccounts}
        categoryPath={categoryPath}
        loading={loading}
        onSelectCategory={onSelectCategory}
        onVisibleCategoryPathsChange={onVisibleCategoryPathsChange}
        previewScrollRef={previewScrollRef}
        categoryLoading={categoryLoading}
        categoryError={categoryError}
        categoryPreview={categoryPreview}
        visibleCategoryMedia={visibleCategoryMedia}
        filteredCategoryMediaCount={filteredCategoryMedia.length}
        categoryHasMore={categoryHasMore}
        categoryLoadingMore={categoryLoadingMore}
        hoveredCardRef={hoveredCardRef}
        onSelectMedia={setSelected}
        onReachEnd={onReachEnd}
        onVisibleCardsChange={onVisibleCardsChange}
      />

      <MediaPreviewModal
        media={selected}
        onClose={onClose}
        onPrev={onPrev}
        onNext={onNext}
        hasPrev={hasPrev}
        hasNext={hasNext}
      />

      {showScrollTop && (
        <button className="scroll-top" onClick={scrollToTop} aria-label="回到顶部">
          ↑
        </button>
      )}
    </div>
  );
}

export default App;
