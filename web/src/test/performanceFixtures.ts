import type {
  CategoryPagePayload,
  FolderPreview,
  MediaItem,
  RootSummaryPayload,
} from "../types";

const pad = (value: number, width = 4) => value.toString().padStart(width, "0");

export const makePerfMediaItem = (
  path: string,
  index: number,
  kind: MediaItem["kind"] = "image"
): MediaItem => ({
  name:
    kind === "video"
      ? `VID_20260307_${pad(index, 6)}.mp4`
      : `IMG_20260307_${pad(index, 6)}.jpg`,
  path: `${path}/${kind}-${pad(index, 6)}`,
  url: `/media/${path}/${kind}-${pad(index, 6)}`,
  thumbnailUrl: `/thumb/${path}/${kind}-${pad(index, 6)}`,
  kind,
  size: 1024 + index,
  modified: 2_000_000 - index,
});

export const makePerfFolderPreview = (index: number): FolderPreview => ({
  name: `account-${pad(index)}`,
  path: `account-${pad(index)}`,
  modified: 100_000 - index,
  counts: {
    images: index % 3 === 0 ? 0 : 24,
    gifs: index % 10 === 0 ? 2 : 0,
    videos: index % 4 === 0 ? 12 : 0,
    subfolders: 0,
  },
  previews: [makePerfMediaItem(`account-${pad(index)}`, index)],
  countsReady: true,
  previewReady: true,
  favorite: false,
});

export const makePerfRootPayload = (count = 1_000): RootSummaryPayload => ({
  folder: { name: "root", path: "" },
  breadcrumb: [{ name: "root", path: "" }],
  subfolders: Array.from({ length: count }, (_, index) => makePerfFolderPreview(index + 1)),
  totals: { media: 0, subfolders: count },
});

export const makePerfCategoryPayload = (
  path: string,
  count = 5_000,
  kind: MediaItem["kind"] = "image"
): CategoryPagePayload => ({
  folder: { name: path, path },
  breadcrumb: [
    { name: "root", path: "" },
    { name: path, path },
  ],
  media: Array.from({ length: count }, (_, index) => makePerfMediaItem(path, index + 1, kind)),
  counts: {
    images: kind === "video" ? 0 : count,
    gifs: 0,
    videos: kind === "video" ? count : 0,
    subfolders: 0,
  },
  totalMedia: count,
  filteredTotal: count,
});
