import type { FolderPayload } from "./types";

export async function fetchFolder(path = ""): Promise<FolderPayload> {
  const url = path ? `/api/folder?path=${encodeURIComponent(path)}` : "/api/folder";
  const response = await fetch(url);

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
