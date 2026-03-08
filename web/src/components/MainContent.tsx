import { memo, type RefObject } from "react";
import type { CategoryPagePayload, MediaItem } from "../types";
import type { RootFolderStore } from "../features/root/rootStore";
import { CategoryList } from "./CategoryList";
import { MediaGrid } from "./MediaGrid";

interface MainContentProps {
  accountPaths: string[];
  rootStore: RootFolderStore;
  categoryPath: string | null;
  loading: boolean;
  onSelectCategory: (path: string) => void;
  onToggleFavorite: (path: string, favorite: boolean) => void;
  onVisibleCategoryPathsChange: (paths: string[]) => void;
  previewScrollRef: RefObject<HTMLDivElement | null>;
  categoryLoading: boolean;
  categoryError: string | null;
  categoryPreview: CategoryPagePayload | null;
  visibleCategoryMedia: MediaItem[];
  filteredCategoryMediaCount: number;
  categoryHasMore: boolean;
  categoryLoadingMore: boolean;
  hoveredCardRef: RefObject<HTMLButtonElement | null>;
  onSelectMedia: (item: MediaItem) => void;
  onReachEnd: () => void;
  onVisibleCardsChange: (count: number) => void;
}

export const MainContent = memo(function MainContent({
  accountPaths,
  rootStore,
  categoryPath,
  loading,
  onSelectCategory,
  onToggleFavorite,
  onVisibleCategoryPathsChange,
  previewScrollRef,
  categoryLoading,
  categoryError,
  categoryPreview,
  visibleCategoryMedia,
  filteredCategoryMediaCount,
  categoryHasMore,
  categoryLoadingMore,
  hoveredCardRef,
  onSelectMedia,
  onReachEnd,
  onVisibleCardsChange,
}: MainContentProps) {
  return (
    <section className="section">
      <div className="category-layout">
        <CategoryList
          paths={accountPaths}
          rootStore={rootStore}
          selectedPath={categoryPath}
          loading={loading}
          onSelect={onSelectCategory}
          onToggleFavorite={onToggleFavorite}
          onVisiblePathsChange={onVisibleCategoryPathsChange}
        />

        <div className="category-panel">
          <div className="category-preview" ref={previewScrollRef}>
            {categoryLoading && <div className="empty">加载账号媒体...</div>}
            {categoryError && <div className="empty">{categoryError}</div>}
            {!categoryLoading && !categoryError && categoryPreview && (
              <MediaGrid
                items={visibleCategoryMedia}
                totalFilteredCount={filteredCategoryMediaCount}
                hasMore={categoryHasMore}
                loadingMore={categoryLoadingMore}
                categoryPath={categoryPreview.folder.path}
                scrollRef={previewScrollRef}
                hoveredCardRef={hoveredCardRef}
                onSelect={onSelectMedia}
                onReachEnd={onReachEnd}
                onVisibleCardsChange={onVisibleCardsChange}
              />
            )}
          </div>
        </div>
      </div>
    </section>
  );
});
