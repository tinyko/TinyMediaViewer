/* eslint-disable react-hooks/incompatible-library */
import { useEffect, useMemo, type ReactNode, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { MediaItem } from "../types";

const ROW_ESTIMATE = 280;
const FALLBACK_RENDER_LIMIT = 80;

interface MediaGridVirtualRowsProps {
  items: MediaItem[];
  columnCount: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  onReachEnd: () => void;
  onVisibleCardsChange: (count: number) => void;
  renderCard: (item: MediaItem) => ReactNode;
}

export function MediaGridVirtualRows({
  items,
  columnCount,
  scrollRef,
  onReachEnd,
  onVisibleCardsChange,
  renderCard,
}: MediaGridVirtualRowsProps) {
  const rowCount = Math.ceil(items.length / columnCount);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 2,
    initialRect: { width: 960, height: 740 },
  });

  useEffect(() => {
    rowVirtualizer.measure();
  }, [columnCount, items.length, rowVirtualizer]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const fallbackItems = useMemo(
    () => items.slice(0, Math.min(items.length, FALLBACK_RENDER_LIMIT)),
    [items]
  );
  const hasVirtualRows = virtualRows.length > 0;

  useEffect(() => {
    const visibleCount = hasVirtualRows
      ? Math.min(items.length, virtualRows.length * columnCount)
      : fallbackItems.length;
    onVisibleCardsChange(visibleCount);
  }, [
    columnCount,
    fallbackItems.length,
    hasVirtualRows,
    items.length,
    onVisibleCardsChange,
    virtualRows.length,
  ]);

  useEffect(() => {
    if (!hasVirtualRows || !rowCount) return;
    const lastVisible = virtualRows[virtualRows.length - 1];
    if (lastVisible && lastVisible.index >= rowCount - 2) {
      onReachEnd();
    }
  }, [hasVirtualRows, onReachEnd, rowCount, virtualRows]);

  if (hasVirtualRows) {
    return (
      <div className="media-grid-virtual" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {virtualRows.map((row) => {
          const startIndex = row.index * columnCount;
          const rowItems = items.slice(startIndex, startIndex + columnCount);
          return (
            <div
              key={row.key}
              data-index={row.index}
              ref={rowVirtualizer.measureElement}
              className="media-grid-row"
              style={{
                transform: `translateY(${row.start}px)`,
                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
              }}
            >
              {rowItems.map((item) => renderCard(item))}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="media-grid">
      {fallbackItems.map((item) => renderCard(item))}
    </div>
  );
}
