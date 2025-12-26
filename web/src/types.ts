export type MediaKind = "image" | "gif" | "video";

export interface MediaItem {
  name: string;
  path: string;
  url: string;
  kind: MediaKind;
  size: number;
  modified: number;
}

export interface FolderPreview {
  name: string;
  path: string;
  modified: number;
  counts: {
    images: number;
    gifs: number;
    videos: number;
    subfolders: number;
  };
  previews: MediaItem[];
}

export interface FolderPayload {
  folder: {
    name: string;
    path: string;
    absolutePath: string;
  };
  breadcrumb: { name: string; path: string }[];
  subfolders: FolderPreview[];
  media: MediaItem[];
  totals: { media: number; subfolders: number };
}
