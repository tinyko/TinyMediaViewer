import type {
  CategoryPagePayload,
  FolderFavoriteInput,
  FolderFavoriteOutput,
  PerfDiagEventsInput,
  FolderPreviewBatchInput,
  FolderPreviewBatchOutput,
  PreviewDiagEventsInput,
  RootSummaryPayload,
  SystemUsageReport,
  ViewerPreferences,
} from "./types";

interface FetchCategoryPageOptions {
  cursor?: string;
  limit?: number;
  kind?: "image" | "video";
  sort?: "asc" | "desc";
  signal?: AbortSignal;
}

const readJsonError = async (response: Response, fallback: string) => {
  const payload = await response.json().catch(() => ({}));
  return typeof payload.error === "string" ? payload.error : fallback;
};

export async function fetchRootSummary(options: {
  signal?: AbortSignal;
} = {}): Promise<RootSummaryPayload> {
  const response = await fetch("/api/root", {
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(await readJsonError(response, `Failed to load root summary (${response.status})`));
  }

  return response.json();
}

export async function fetchCategoryPage(
  path: string,
  options: FetchCategoryPageOptions = {}
): Promise<CategoryPagePayload> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (options.cursor) params.set("cursor", options.cursor);
  if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
    params.set("limit", String(Math.floor(options.limit)));
  }
  if (options.kind) {
    params.set("kind", options.kind);
  }
  if (options.sort) {
    params.set("sort", options.sort);
  }
  const query = params.toString();
  const url = query ? `/api/category?${query}` : "/api/category";
  const response = await fetch(url, { signal: options.signal });

  if (!response.ok) {
    throw new Error(await readJsonError(response, `Failed to load category (${response.status})`));
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
    throw new Error(
      await readJsonError(response, `Failed to load folder previews (${response.status})`)
    );
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
    throw new Error(await readJsonError(response, `Failed to save favorite (${response.status})`));
  }

  return response.json();
}

export async function fetchSystemUsage(
  limit = 10,
  options: { refresh?: boolean } = {}
): Promise<SystemUsageReport> {
  const params = new URLSearchParams({
    limit: String(limit),
  });
  if (options.refresh) {
    params.set("refresh", "1");
  }
  const response = await fetch(`/api/system-usage?${params.toString()}`);

  if (!response.ok) {
    throw new Error(await readJsonError(response, `Failed to load system usage (${response.status})`));
  }

  return response.json();
}

export async function fetchViewerPreferences(): Promise<ViewerPreferences> {
  const response = await fetch("/api/viewer-preferences");

  if (!response.ok) {
    throw new Error(
      await readJsonError(response, `Failed to load viewer preferences (${response.status})`)
    );
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
    throw new Error(
      await readJsonError(response, `Failed to save viewer preferences (${response.status})`)
    );
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
