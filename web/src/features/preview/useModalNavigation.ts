import { useCallback, useMemo } from "react";
import type { MediaItem } from "../../types";

interface UseModalNavigationOptions {
  selected: MediaItem | null;
  media: MediaItem[];
  onSelect: (item: MediaItem | null) => void;
}

export function useModalNavigation({ selected, media, onSelect }: UseModalNavigationOptions) {
  const selectedIndex = useMemo(
    () => (selected ? media.findIndex((item) => item.path === selected.path) : -1),
    [media, selected]
  );

  const onClose = useCallback(() => onSelect(null), [onSelect]);

  const onPrev = useCallback(() => {
    if (!selected || selectedIndex <= 0) return;
    onSelect(media[selectedIndex - 1]);
  }, [media, onSelect, selected, selectedIndex]);

  const onNext = useCallback(() => {
    if (!selected || selectedIndex < 0 || selectedIndex >= media.length - 1) return;
    onSelect(media[selectedIndex + 1]);
  }, [media, onSelect, selected, selectedIndex]);

  return {
    onClose,
    onPrev,
    onNext,
    hasPrev: selectedIndex > 0,
    hasNext: selectedIndex > -1 && selectedIndex < media.length - 1,
  };
}
