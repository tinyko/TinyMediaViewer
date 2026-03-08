import { memo, useRef } from "react";
import {
  selectFolderPreview,
  type RootFolderStore,
  useRootStoreSelector,
} from "../features/root/rootStore";
import { CategoryListVirtualViewport } from "./CategoryListVirtualViewport";

interface CategoryListProps {
  paths: string[];
  rootStore: RootFolderStore;
  selectedPath: string | null;
  loading: boolean;
  onSelect: (path: string) => void;
  onToggleFavorite: (path: string, favorite: boolean) => void;
  onVisiblePathsChange: (paths: string[]) => void;
  onRowRender?: (path: string) => void;
}

interface CategoryRowProps {
  path: string;
  rootStore: RootFolderStore;
  selected: boolean;
  onSelect: (path: string) => void;
  onToggleFavorite: (path: string, favorite: boolean) => void;
  onRowRender?: (path: string) => void;
}

const CategoryRow = memo(function CategoryRow({
  path,
  rootStore,
  selected,
  onSelect,
  onToggleFavorite,
  onRowRender,
}: CategoryRowProps) {
  const item = useRootStoreSelector(rootStore, (state) => selectFolderPreview(state, path));
  if (!item) return null;
  onRowRender?.(path);

  return (
    <div data-path={item.path} className={`category-item ${selected ? "active" : ""}`}>
      <button
        type="button"
        className="category-item__body"
        onClick={() => onSelect(item.path)}
      >
        <div className="category-item__title">{item.name}</div>
        <div className="category-item__meta">
          {!item.countsReady ? (
            <span>统计中...</span>
          ) : !item.previewReady ? (
            <span>统计失败</span>
          ) : (
            <>
              <span className="category-item__metric">🖼️ {item.counts.images + item.counts.gifs}</span>
              <span className="category-item__metric">🎞️ {item.counts.videos}</span>
            </>
          )}
        </div>
      </button>
      <button
        type="button"
        className={`category-item__favorite ${item.favorite ? "active" : ""}`}
        aria-label={item.favorite ? `取消收藏 ${item.name}` : `收藏 ${item.name}`}
        aria-pressed={item.favorite}
        onClick={() => onToggleFavorite(item.path, !item.favorite)}
      >
        {item.favorite ? "♥" : "♡"}
      </button>
    </div>
  );
});

export function CategoryList({
  paths,
  rootStore,
  selectedPath,
  loading,
  onSelect,
  onToggleFavorite,
  onVisiblePathsChange,
  onRowRender,
}: CategoryListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="category-list" ref={scrollRef}>
      {paths.length ? (
        <CategoryListVirtualViewport
          paths={paths}
          scrollRef={scrollRef}
          onVisiblePathsChange={onVisiblePathsChange}
          renderRow={(path) => (
            <CategoryRow
              path={path}
              rootStore={rootStore}
              selected={selectedPath === path}
              onSelect={onSelect}
              onToggleFavorite={onToggleFavorite}
              onRowRender={onRowRender}
            />
          )}
        />
      ) : (
        !loading && <div className="empty">没有匹配的账号</div>
      )}
    </div>
  );
}
