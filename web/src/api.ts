import type {
  FolderPayload,
  FolderPreviewBatchInput,
  FolderPreviewBatchOutput,
} from "./types";

interface FetchFolderOptions {
  cursor?: string;
  limit?: number;
  mode?: "light" | "full";
  signal?: AbortSignal;
}

export async function fetchFolder(
  path = "",
  options: FetchFolderOptions = {}
): Promise<FolderPayload> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (options.cursor) params.set("cursor", options.cursor);
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    params.set("limit", String(Math.floor(options.limit)));
  }
  if (options.mode) {
    params.set("mode", options.mode);
  }
  const query = params.toString();
  const url = query ? `/api/folder?${query}` : "/api/folder";
  const response = await fetch(url, { signal: options.signal });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message =
      typeof payload.error === "string"
        ? payload.error
        : `Failed to load folder (${response.status})`;
    throw new Error(message);
  }

  return response.json();
}

interface FetchFolderPreviewsOptions {
  signal?: AbortSignal;
}

export async function fetchFolderPreviews(
  input: FolderPreviewBatchInput,
  options: FetchFolderPreviewsOptions = {}
): Promise<FolderPreviewBatchOutput> {
  const response = await fetch("/api/folder/previews", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    signal: options.signal,
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message =
      typeof payload.error === "string"
        ? payload.error
        : `Failed to load folder previews (${response.status})`;
    throw new Error(message);
  }

  return response.json();
}
