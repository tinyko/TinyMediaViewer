/* eslint-disable react-hooks/incompatible-library */
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

const ROW_ESTIMATE = 76;

interface CategoryListVirtualViewportProps {
  paths: string[];
  scrollRef: RefObject<HTMLDivElement | null>;
  onVisiblePathsChange: (paths: string[]) => void;
  renderRow: (path: string) => ReactNode;
}

export function CategoryListVirtualViewport({
  paths,
  scrollRef,
  onVisiblePathsChange,
  renderRow,
}: CategoryListVirtualViewportProps) {
  const lastVisiblePathsRef = useRef<string[]>([]);
  const virtualizer = useVirtualizer({
    count: paths.length,
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
        ? virtualItems.map((row) => paths[row.index])
        : paths.slice(0, 20);
    return source.filter((value): value is string => Boolean(value));
  }, [paths, virtualItems]);

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

  if (virtualItems.length > 0) {
    return (
      <div
        className="category-list__virtual"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((row) => {
          const path = paths[row.index];
          if (!path) return null;
          return (
            <div
              key={path}
              className="category-list__row"
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {renderRow(path)}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="category-list__fallback">
      {paths.map((path) => (
        <div key={path} className="category-list__fallback-row">
          {renderRow(path)}
        </div>
      ))}
    </div>
  );
}
