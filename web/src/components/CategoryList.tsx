import { memo, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FolderPreview } from "../types";

const ROW_ESTIMATE = 76;

interface CategoryListProps {
  items: FolderPreview[];
  selectedPath: string | null;
  loading: boolean;
  onSelect: (path: string) => void;
  onToggleFavorite: (path: string, favorite: boolean) => void;
  onVisiblePathsChange: (paths: string[]) => void;
}

interface CategoryRowProps {
  item: FolderPreview;
  selected: boolean;
  onSelect: (path: string) => void;
  onToggleFavorite: (path: string, favorite: boolean) => void;
}

const CategoryRow = memo(function CategoryRow({
  item,
  selected,
  onSelect,
  onToggleFavorite,
}: CategoryRowProps) {
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
  items,
  selectedPath,
  loading,
  onSelect,
  onToggleFavorite,
  onVisiblePathsChange,
}: CategoryListProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastVisiblePathsRef = useRef<string[]>([]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 6,
    gap: 6,
    initialRect: { width: 260, height: 640 },
  });

  const virtualItems = virtualizer.getVirtualItems();
  const visiblePaths = useMemo(() => {
    const source =
      virtualItems.length > 0
        ? virtualItems.map((row) => items[row.index]?.path)
        : items.slice(0, 20).map((item) => item.path);
    return source.filter((value): value is string => Boolean(value));
  }, [items, virtualItems]);

  useEffect(() => {
    if (!visiblePaths.length) return;
    const previous = lastVisiblePathsRef.current;
    if (
      previous.length === visiblePaths.length &&
      previous.every((path, index) => path === visiblePaths[index])
    ) {
      return;
    }
    lastVisiblePathsRef.current = visiblePaths;
    onVisiblePathsChange(visiblePaths);
  }, [onVisiblePathsChange, visiblePaths]);

  return (
    <div className="category-list" ref={scrollRef}>
      {items.length ? (
        virtualItems.length > 0 ? (
          <div
            className="category-list__virtual"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            {virtualItems.map((row) => {
              const item = items[row.index];
              if (!item) return null;
              return (
                <div
                  key={item.path}
                  className="category-list__row"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <CategoryRow
                    item={item}
                    selected={selectedPath === item.path}
                    onSelect={onSelect}
                    onToggleFavorite={onToggleFavorite}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="category-list__fallback">
            {items.map((item) => (
              <div key={item.path} className="category-list__fallback-row">
                <CategoryRow
                  item={item}
                  selected={selectedPath === item.path}
                  onSelect={onSelect}
                  onToggleFavorite={onToggleFavorite}
                />
              </div>
            ))}
          </div>
        )
      ) : (
        !loading && <div className="empty">没有匹配的账号</div>
      )}
    </div>
  );
}
