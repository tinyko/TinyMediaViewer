import { useCallback } from "react";
import type { MediaItem } from "../../types";

interface UseModalNavigationOptions {
  selectedPath: string | null;
  selectedIndex: number;
  media: MediaItem[];
  onSelect: (item: MediaItem | null) => void;
}

export function useModalNavigation({
  selectedPath,
  selectedIndex,
  media,
  onSelect,
}: UseModalNavigationOptions) {
  const onClose = useCallback(() => onSelect(null), [onSelect]);

  const onPrev = useCallback(() => {
    if (!selectedPath || selectedIndex <= 0) return;
    const previous = media[selectedIndex - 1];
    if (!previous) return;
    onSelect(previous);
  }, [media, onSelect, selectedIndex, selectedPath]);

  const onNext = useCallback(() => {
    if (!selectedPath || selectedIndex < 0 || selectedIndex >= media.length - 1) return;
    const next = media[selectedIndex + 1];
    if (!next) return;
    onSelect(next);
  }, [media, onSelect, selectedIndex, selectedPath]);

  return {
    onClose,
    onPrev,
    onNext,
    hasPrev: Boolean(selectedPath) && selectedIndex > 0,
    hasNext: Boolean(selectedPath) && selectedIndex > -1 && selectedIndex < media.length - 1,
  };
}
