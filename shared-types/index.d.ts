export type MediaKind = "image" | "gif" | "video";

export interface MediaItem {
  name: string;
  path: string;
  url: string;
  thumbnailUrl?: string;
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
  countsReady: boolean;
  previewReady: boolean;
  approximate?: boolean;
}

export interface FolderPayload {
  folder: {
    name: string;
    path: string;
  };
  breadcrumb: { name: string; path: string }[];
  subfolders: FolderPreview[];
  media: MediaItem[];
  totals: { media: number; subfolders: number };
  nextCursor?: string;
}

export interface FolderPreviewBatchInput {
  paths: string[];
  limitPerFolder?: number;
}

export interface FolderPreviewBatchError {
  path: string;
  error: string;
}

export interface FolderPreviewBatchOutput {
  items: Array<FolderPreview & { countsReady: true; previewReady: true }>;
  errors?: FolderPreviewBatchError[];
}
