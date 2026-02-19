import type { MediaItem } from "../../types";

export const getMediaTimestamp = (item: MediaItem) => {
  const match = item.name.match(/_(\d{8})_(\d{6})/);
  if (match) {
    const [date, time] = [match[1], match[2]];
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6)) - 1;
    const day = Number(date.slice(6, 8));
    const hour = Number(time.slice(0, 2));
    const minute = Number(time.slice(2, 4));
    const second = Number(time.slice(4, 6));
    return new Date(year, month, day, hour, minute, second).getTime();
  }
  return item.modified;
};

export const filterMediaByKind = (
  items: MediaItem[],
  mediaFilter: "image" | "video"
) => {
  return items.filter((item) =>
    mediaFilter === "image"
      ? item.kind === "image" || item.kind === "gif"
      : item.kind === "video"
  );
};

export const sortMediaByTime = (
  items: MediaItem[],
  direction: "asc" | "desc"
) => {
  return [...items].sort((a, b) =>
    direction === "asc"
      ? getMediaTimestamp(a) - getMediaTimestamp(b)
      : getMediaTimestamp(b) - getMediaTimestamp(a)
  );
};

export const mergeMediaByPath = (existing: MediaItem[], incoming: MediaItem[]) => {
  const seen = new Set(existing.map((item) => item.path));
  const merged = [...existing];
  for (const item of incoming) {
    if (!seen.has(item.path)) {
      merged.push(item);
      seen.add(item.path);
    }
  }
  return merged.sort((a, b) => b.modified - a.modified);
};
