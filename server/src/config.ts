import path from "path";

// When running from media-viewer/server, go two levels up to the media library root (/Users/tiny/X).
const defaultRoot = path.resolve(process.cwd(), "..", "..");

export const config = {
  mediaRoot: path.resolve(process.env.MEDIA_ROOT ?? defaultRoot),
  port: Number(process.env.PORT ?? 4000),
  // Use SERVER_HOST to avoid colliding with shell-level HOST (e.g. arm64-apple-darwin20.0.0).
  host: process.env.SERVER_HOST ?? "0.0.0.0",
  previewLimit: Number(process.env.PREVIEW_LIMIT ?? 6),
  maxItemsPerFolder: Number(process.env.MAX_ITEMS_PER_FOLDER ?? 20000),
};
