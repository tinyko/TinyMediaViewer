import { useMemo, useRef, useSyncExternalStore } from "react";
import type { FolderPreview, RootSummaryPayload } from "../../types";

export type RootAccountSortMode = "time" | "name" | "favorite" | "random";
export type RootMediaFilter = "image" | "video";

type RootFolderMeta = Pick<RootSummaryPayload, "folder" | "breadcrumb" | "totals">;

export interface RootFolderStoreState {
  folderMeta: RootFolderMeta | null;
  subfoldersByPath: ReadonlyMap<string, FolderPreview>;
  orderByName: readonly string[];
  orderByModified: readonly string[];
  orderByFavorite: readonly string[];
  nameSearchIndex: ReadonlyMap<string, string>;
  version: number;
}

const EMPTY_STATE: RootFolderStoreState = {
  folderMeta: null,
  subfoldersByPath: new Map(),
  orderByName: [],
  orderByModified: [],
  orderByFavorite: [],
  nameSearchIndex: new Map(),
  version: 0,
};

const sortSubfoldersByName = (items: readonly FolderPreview[]) =>
  [...items]
    .sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path))
    .map((item) => item.path);

const sortSubfoldersByModified = (items: readonly FolderPreview[]) =>
  [...items]
    .sort((left, right) => right.modified - left.modified || left.path.localeCompare(right.path))
    .map((item) => item.path);

const sortSubfoldersByFavorite = (items: readonly FolderPreview[]) =>
  [...items]
    .sort(
      (left, right) =>
        Number(Boolean(right.favorite)) - Number(Boolean(left.favorite)) ||
        right.modified - left.modified ||
        left.name.localeCompare(right.name) ||
        left.path.localeCompare(right.path)
    )
    .map((item) => item.path);

const rankPathForRandomSeed = (path: string, seed: number) => {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

const sortPathsByRandomSeed = (paths: readonly string[], seed: number) =>
  [...paths]
    .map((path, index) => ({
      path,
      index,
      rank: rankPathForRandomSeed(path, seed),
    }))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.index - right.index ||
        left.path.localeCompare(right.path)
    )
    .map((item) => item.path);

const randomOrderCache = new WeakMap<readonly string[], Map<number, string[]>>();
const filteredAccountsCache = new WeakMap<
  RootFolderStoreState,
  Map<string, FolderPreview[]>
>();

const getRandomOrderForSeed = (paths: readonly string[], seed: number) => {
  let cache = randomOrderCache.get(paths);
  if (!cache) {
    cache = new Map();
    randomOrderCache.set(paths, cache);
  }

  const cached = cache.get(seed);
  if (cached) {
    return cached;
  }

  const generated = sortPathsByRandomSeed(paths, seed);
  cache.set(seed, generated);
  return generated;
};

const buildFilteredAccountsCacheKey = (options: {
  search: string;
  sortMode: RootAccountSortMode;
  mediaFilter: RootMediaFilter;
  randomSeed?: number;
}) =>
  [
    options.sortMode,
    options.mediaFilter,
    options.randomSeed ?? 0,
    options.search.trim().toLowerCase(),
  ].join("\u0000");

const buildStateFromPayload = (
  payload: RootSummaryPayload,
  version: number
): RootFolderStoreState => {
  const subfoldersByPath = new Map(payload.subfolders.map((item) => [item.path, item]));
  const nameSearchIndex = new Map(payload.subfolders.map((item) => [item.path, item.name.toLowerCase()]));
  return {
    folderMeta: {
      folder: payload.folder,
      breadcrumb: payload.breadcrumb,
      totals: payload.totals,
    },
    subfoldersByPath,
    orderByName: sortSubfoldersByName(payload.subfolders),
    orderByModified: sortSubfoldersByModified(payload.subfolders),
    orderByFavorite: sortSubfoldersByFavorite(payload.subfolders),
    nameSearchIndex,
    version,
  };
};

const shouldIncludeAccount = (
  item: FolderPreview,
  mediaFilter: RootMediaFilter
) => {
  if (!item.countsReady || !item.previewReady) {
    return true;
  }
  return mediaFilter === "image"
    ? item.counts.images + item.counts.gifs > 0
    : item.counts.videos > 0;
};

const samePreviewArray = (left: FolderPreview["previews"], right: FolderPreview["previews"]) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (
      leftItem.path !== rightItem.path ||
      leftItem.modified !== rightItem.modified ||
      leftItem.size !== rightItem.size ||
      leftItem.url !== rightItem.url ||
      leftItem.thumbnailUrl !== rightItem.thumbnailUrl ||
      leftItem.kind !== rightItem.kind
    ) {
      return false;
    }
  }
  return true;
};

export const areFolderPreviewArraysEqual = (
  left: readonly FolderPreview[],
  right: readonly FolderPreview[]
) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
};

export const areStringArraysEqual = (
  left: readonly string[],
  right: readonly string[]
) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
};

export const selectFilteredAccounts = (
  state: RootFolderStoreState,
  options: {
    search: string;
    sortMode: RootAccountSortMode;
    mediaFilter: RootMediaFilter;
    randomSeed?: number;
  }
) => {
  const cacheKey = buildFilteredAccountsCacheKey(options);
  let stateCache = filteredAccountsCache.get(state);
  if (!stateCache) {
    stateCache = new Map();
    filteredAccountsCache.set(state, stateCache);
  }
  const cached = stateCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const search = options.search.trim().toLowerCase();
  const order =
    options.sortMode === "name"
      ? state.orderByName
      : options.sortMode === "favorite"
        ? state.orderByFavorite
        : options.sortMode === "random"
          ? getRandomOrderForSeed(state.orderByModified, options.randomSeed ?? 0)
        : state.orderByModified;
  const accounts: FolderPreview[] = [];
  for (const path of order) {
    const indexedName = state.nameSearchIndex.get(path);
    if (search && (!indexedName || !indexedName.includes(search))) {
      continue;
    }
    const item = state.subfoldersByPath.get(path);
    if (!item || !shouldIncludeAccount(item, options.mediaFilter)) {
      continue;
    }
    if (options.sortMode === "favorite" && !item.favorite) {
      continue;
    }
    accounts.push(item);
  }
  stateCache.set(cacheKey, accounts);
  return accounts;
};

export const selectCategorySummary = (
  state: RootFolderStoreState,
  path: string | null
) => {
  if (!path) return null;
  return state.subfoldersByPath.get(path) ?? null;
};

export class RootFolderStore {
  private listeners = new Set<() => void>();

  private state: RootFolderStoreState = EMPTY_STATE;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = () => this.state;

  getVersion = () => this.state.version;

  hasCountsReady(path: string) {
    return this.state.subfoldersByPath.get(path)?.countsReady ?? false;
  }

  replaceRoot(payload: RootSummaryPayload) {
    this.state = buildStateFromPayload(payload, this.state.version + 1);
    this.emit();
  }

  applyPreviewBatch(
    items: readonly FolderPreview[],
    options: { expectedVersion?: number } = {}
  ) {
    if (
      typeof options.expectedVersion === "number" &&
      options.expectedVersion !== this.state.version
    ) {
      return false;
    }
    if (!items.length) return false;

    let nextSubfoldersByPath: Map<string, FolderPreview> | null = null;
    let nextNameSearchIndex: Map<string, string> | null = null;
    let needsNameResort = false;
    let needsModifiedResort = false;
    let needsFavoriteResort = false;

    for (const patch of items) {
      const current = (nextSubfoldersByPath ?? this.state.subfoldersByPath).get(patch.path);
      if (!current) continue;

      const changed =
        current.name !== patch.name ||
        current.modified !== patch.modified ||
        current.counts.images !== patch.counts.images ||
        current.counts.gifs !== patch.counts.gifs ||
        current.counts.videos !== patch.counts.videos ||
        current.counts.subfolders !== patch.counts.subfolders ||
        current.countsReady !== patch.countsReady ||
        current.previewReady !== patch.previewReady ||
        current.favorite !== patch.favorite ||
        current.approximate !== patch.approximate ||
        !samePreviewArray(current.previews, patch.previews);

      if (!changed) continue;

      if (!nextSubfoldersByPath) {
        nextSubfoldersByPath = new Map(this.state.subfoldersByPath);
      }
      nextSubfoldersByPath.set(patch.path, patch);

      if (current.name !== patch.name) {
        needsNameResort = true;
        nextNameSearchIndex = nextNameSearchIndex ?? new Map(this.state.nameSearchIndex);
        nextNameSearchIndex.set(patch.path, patch.name.toLowerCase());
      }
      if (current.modified !== patch.modified) {
        needsModifiedResort = true;
      }
      if (
        current.favorite !== patch.favorite ||
        current.modified !== patch.modified ||
        current.name !== patch.name
      ) {
        needsFavoriteResort = true;
      }
    }

    if (!nextSubfoldersByPath) {
      return false;
    }

    this.state = {
      ...this.state,
      subfoldersByPath: nextSubfoldersByPath,
      nameSearchIndex: nextNameSearchIndex ?? this.state.nameSearchIndex,
      orderByName: needsNameResort
        ? sortSubfoldersByName([...nextSubfoldersByPath.values()])
        : this.state.orderByName,
      orderByModified: needsModifiedResort
        ? sortSubfoldersByModified([...nextSubfoldersByPath.values()])
        : this.state.orderByModified,
      orderByFavorite: needsFavoriteResort
        ? sortSubfoldersByFavorite([...nextSubfoldersByPath.values()])
        : this.state.orderByFavorite,
    };
    this.emit();
    return true;
  }

  setFavorite(path: string, favorite: boolean) {
    const current = this.state.subfoldersByPath.get(path);
    if (!current || Boolean(current.favorite) === favorite) {
      return false;
    }

    const nextSubfoldersByPath = new Map(this.state.subfoldersByPath);
    nextSubfoldersByPath.set(path, {
      ...current,
      favorite,
    });

    this.state = {
      ...this.state,
      subfoldersByPath: nextSubfoldersByPath,
      orderByFavorite: sortSubfoldersByFavorite([...nextSubfoldersByPath.values()]),
    };
    this.emit();
    return true;
  }

  markPreviewFailed(paths: readonly string[], options: { expectedVersion?: number } = {}) {
    if (
      typeof options.expectedVersion === "number" &&
      options.expectedVersion !== this.state.version
    ) {
      return false;
    }
    if (!paths.length) return false;

    let nextSubfoldersByPath: Map<string, FolderPreview> | null = null;
    for (const path of paths) {
      const current = (nextSubfoldersByPath ?? this.state.subfoldersByPath).get(path);
      if (!current || current.countsReady) continue;

      if (!nextSubfoldersByPath) {
        nextSubfoldersByPath = new Map(this.state.subfoldersByPath);
      }
      nextSubfoldersByPath.set(path, {
        ...current,
        countsReady: true,
        previewReady: false,
        approximate: true,
      });
    }

    if (!nextSubfoldersByPath) {
      return false;
    }

    this.state = {
      ...this.state,
      subfoldersByPath: nextSubfoldersByPath,
    };
    this.emit();
    return true;
  }

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const createRootFolderStore = () => new RootFolderStore();

export function useRootStoreSelector<T>(
  store: RootFolderStore,
  selector: (state: RootFolderStoreState) => T,
  isEqual: (left: T, right: T) => boolean = Object.is
) {
  const cacheRef = useRef<{ hasValue: boolean; selection?: T }>({
    hasValue: false,
  });

  const getSnapshot = useMemo(
    () => () => {
      const nextSelection = selector(store.getState());
      const cached = cacheRef.current;
      if (cached.hasValue && isEqual(cached.selection as T, nextSelection)) {
        return cached.selection as T;
      }
      cached.hasValue = true;
      cached.selection = nextSelection;
      return nextSelection;
    },
    [isEqual, selector, store]
  );

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
