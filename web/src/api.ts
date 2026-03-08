import type {
  FolderFavoriteInput,
  FolderFavoriteOutput,
  FolderPayload,
  PerfDiagEventsInput,
  FolderPreviewBatchInput,
  FolderPreviewBatchOutput,
  PreviewDiagEventsInput,
  SystemUsageReport,
  ViewerPreferences,
} from "./types";

interface FetchFolderOptions {
  cursor?: string;
  limit?: number;
  mode?: "light" | "full";
  kind?: "image" | "video";
  sort?: "asc" | "desc";
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
  if (options.kind) {
    params.set("kind", options.kind);
  }
  if (options.sort) {
    params.set("sort", options.sort);
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

export async function postFolderFavorite(
  input: FolderFavoriteInput
): Promise<FolderFavoriteOutput> {
  const response = await fetch("/api/folder/favorite", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message =
      typeof payload.error === "string"
        ? payload.error
        : `Failed to save favorite (${response.status})`;
    throw new Error(message);
  }

  return response.json();
}

export async function fetchSystemUsage(limit = 10): Promise<SystemUsageReport> {
  const response = await fetch(`/api/system-usage?limit=${encodeURIComponent(String(limit))}`);

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message =
      typeof payload.error === "string"
        ? payload.error
        : `Failed to load system usage (${response.status})`;
    throw new Error(message);
  }

  return response.json();
}

export async function fetchViewerPreferences(): Promise<ViewerPreferences> {
  const response = await fetch("/api/viewer-preferences");

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message =
      typeof payload.error === "string"
        ? payload.error
        : `Failed to load viewer preferences (${response.status})`;
    throw new Error(message);
  }

  return response.json();
}

export async function postViewerPreferences(
  input: ViewerPreferences
): Promise<ViewerPreferences> {
  const response = await fetch("/api/viewer-preferences", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const message =
      typeof payload.error === "string"
        ? payload.error
        : `Failed to save viewer preferences (${response.status})`;
    throw new Error(message);
  }

  return response.json();
}

export async function postPreviewDiagnostics(
  input: PreviewDiagEventsInput
): Promise<void> {
  if (!input.events.length) return;
  await fetch("/__tmv/diag/preview", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    keepalive: true,
  }).catch(() => {
    // Diagnostics transport failures should not affect viewer behavior.
  });
}

export async function postPerfDiagnostics(input: PerfDiagEventsInput): Promise<void> {
  if (!input.events.length) return;
  await fetch("/__tmv/diag/perf", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
    keepalive: true,
  }).catch(() => {
    // Diagnostics transport failures should not affect viewer behavior.
  });
}
