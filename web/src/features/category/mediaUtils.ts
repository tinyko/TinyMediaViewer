import type { MediaItem } from "../../types";

const mediaTimestampCache = new Map<
  string,
  {
    name: string;
    modified: number;
    value: number;
  }
>();

export const getMediaTimestamp = (item: MediaItem) => {
  const cached = mediaTimestampCache.get(item.path);
  if (cached && cached.name === item.name && cached.modified === item.modified) {
    return cached.value;
  }

  const match = item.name.match(/_(\d{8})_(\d{6})/);
  if (match) {
    const [date, time] = [match[1], match[2]];
    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6)) - 1;
    const day = Number(date.slice(6, 8));
    const hour = Number(time.slice(0, 2));
    const minute = Number(time.slice(2, 4));
    const second = Number(time.slice(4, 6));
    const value = new Date(year, month, day, hour, minute, second).getTime();
    mediaTimestampCache.set(item.path, {
      name: item.name,
      modified: item.modified,
      value,
    });
    return value;
  }
  mediaTimestampCache.set(item.path, {
    name: item.name,
    modified: item.modified,
    value: item.modified,
  });
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
  if (items.length < 2) {
    return items.slice();
  }

  const decorated = items.map((item) => ({
    item,
    timestamp: getMediaTimestamp(item),
  }));
  decorated.sort((a, b) =>
    direction === "asc" ? a.timestamp - b.timestamp : b.timestamp - a.timestamp
  );
  return decorated.map(({ item }) => item);
};

const rankMediaForRandomSeed = (item: MediaItem, seed: number) => {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < item.path.length; index += 1) {
    hash ^= item.path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

export const sortMediaByRandomSeed = (
  items: MediaItem[],
  seed: number
) => {
  if (items.length < 2) {
    return items.slice();
  }

  return items
    .map((item, index) => ({
      item,
      index,
      rank: rankMediaForRandomSeed(item, seed),
    }))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.index - right.index ||
        left.item.path.localeCompare(right.item.path)
    )
    .map(({ item }) => item);
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
  return merged;
};
