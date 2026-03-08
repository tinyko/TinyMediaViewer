import { act, renderHook } from "@testing-library/react";
import { createRootFolderStore } from "../root/rootStore";
import { useRefreshCoordinator } from "./useRefreshCoordinator";

const makeRootPayload = (paths: string[]) => ({
  folder: { name: "root", path: "" },
  breadcrumb: [{ name: "root", path: "" }],
  subfolders: paths.map((path, index) => ({
    name: path,
    path,
    modified: 100 - index,
    counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
    previews: [],
    countsReady: true,
    previewReady: true,
    favorite: false,
  })),
  totals: { media: 0, subfolders: paths.length },
});

describe("useRefreshCoordinator", () => {
  it("refreshes the root list and restores category selection from current candidates", async () => {
    const rootStore = createRootFolderStore();
    rootStore.replaceRoot(makeRootPayload(["alpha", "beta"]));

    const clearFavoriteError = vi.fn();
    const resetRootPreviewQueue = vi.fn();
    const enqueueRootPreviewPaths = vi.fn();
    const refreshCategory = vi.fn().mockResolvedValue(undefined);
    const loadRoot = vi.fn(async () => {
      rootStore.replaceRoot(makeRootPayload(["beta", "gamma"]));
      return true;
    });

    const { result } = renderHook(() =>
      useRefreshCoordinator({
        categoryPath: "alpha",
        rootStore,
        deferredSearch: "",
        sortMode: "time",
        mediaFilter: "image",
        randomSeed: 0,
        loadRoot,
        clearFavoriteError,
        resetRootPreviewQueue,
        enqueueRootPreviewPaths,
        refreshCategory,
      })
    );

    await act(async () => {
      await result.current.onRefresh();
    });

    expect(clearFavoriteError).toHaveBeenCalledTimes(1);
    expect(resetRootPreviewQueue).toHaveBeenCalledTimes(1);
    expect(loadRoot).toHaveBeenCalledTimes(1);
    expect(enqueueRootPreviewPaths).toHaveBeenCalledWith(["beta", "gamma"]);
    expect(refreshCategory).toHaveBeenCalledWith(["beta", "gamma"], "alpha");
    expect(result.current.refreshing).toBe(false);
  });
});
