import { act, renderHook, waitFor } from "@testing-library/react";
import {
  fetchFolderPreviews,
  fetchRootSummary,
  postFolderFavorite,
  postPreviewDiagnostics,
} from "../../api";
import { selectCategorySummary } from "../root/rootStore";
import { useRootSession } from "./useRootSession";

vi.mock("../../api", () => ({
  fetchFolderPreviews: vi.fn(),
  fetchRootSummary: vi.fn(),
  postFolderFavorite: vi.fn(),
  postPreviewDiagnostics: vi.fn(),
}));

const mockedFetchFolderPreviews = vi.mocked(fetchFolderPreviews);
const mockedFetchRootSummary = vi.mocked(fetchRootSummary);
const mockedPostFolderFavorite = vi.mocked(postFolderFavorite);
const mockedPostPreviewDiagnostics = vi.mocked(postPreviewDiagnostics);

const makeRootPayload = () => ({
  folder: { name: "root", path: "" },
  breadcrumb: [{ name: "root", path: "" }],
  subfolders: [
    {
      name: "alpha",
      path: "alpha",
      modified: 100,
      counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
      previews: [],
      countsReady: true,
      previewReady: true,
      favorite: false,
    },
  ],
  totals: { media: 0, subfolders: 1 },
});

describe("useRootSession", () => {
  beforeEach(() => {
    mockedFetchFolderPreviews.mockReset();
    mockedFetchRootSummary.mockReset();
    mockedPostFolderFavorite.mockReset();
    mockedPostPreviewDiagnostics.mockReset();
    mockedFetchFolderPreviews.mockResolvedValue({ items: [] });
    mockedFetchRootSummary.mockResolvedValue(makeRootPayload());
    mockedPostPreviewDiagnostics.mockResolvedValue();
  });

  it("rolls back optimistic favorite updates when persistence fails", async () => {
    mockedPostFolderFavorite.mockRejectedValue(new Error("favorite failed"));

    const { result } = renderHook(() =>
      useRootSession({
        preferencesReady: true,
        mediaFilter: "image",
      })
    );

    await waitFor(() => {
      expect(result.current.filteredAccountPaths).toEqual(["alpha"]);
    });

    await act(async () => {
      await result.current.onToggleFavorite("alpha", true);
    });

    await waitFor(() => {
      expect(result.current.favoriteError).toBe("favorite failed");
    });
    expect(
      selectCategorySummary(result.current.rootStore.getState(), "alpha")?.favorite
    ).toBe(false);
  });
});
