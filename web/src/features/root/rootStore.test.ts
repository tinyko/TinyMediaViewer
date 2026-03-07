import {
  createRootFolderStore,
  selectCategorySummary,
  selectFilteredAccounts,
} from "./rootStore";
import { makePerfMediaItem, makePerfRootPayload } from "../../test/performanceFixtures";

describe("rootStore", () => {
  it("patches preview batches without replacing untouched folder references", () => {
    const store = createRootFolderStore();
    const payload = makePerfRootPayload();
    store.replaceRoot(payload);

    const initialState = store.getState();
    const target = initialState.subfoldersByPath.get("account-0001");
    const untouched = initialState.subfoldersByPath.get("account-0002");
    expect(target).toBeDefined();
    expect(untouched).toBeDefined();

    store.applyPreviewBatch(
      [
        {
          ...target!,
          modified: 999_999,
          counts: { images: 128, gifs: 2, videos: 0, subfolders: 0 },
          previews: [makePerfMediaItem("account-0001", 1)],
          countsReady: true,
          previewReady: true,
          approximate: false,
        },
      ],
      { expectedVersion: initialState.version }
    );

    const nextState = store.getState();
    expect(nextState.version).toBe(initialState.version);
    expect(nextState.subfoldersByPath.get("account-0001")).not.toBe(target);
    expect(nextState.subfoldersByPath.get("account-0002")).toBe(untouched);
  });

  it("filters accounts by search text and media type using stable store selectors", () => {
    const store = createRootFolderStore();
    store.replaceRoot(makePerfRootPayload());

    const imageResults = selectFilteredAccounts(store.getState(), {
      search: "account-0001",
      sortMode: "name",
      mediaFilter: "image",
    });
    const videoResults = selectFilteredAccounts(store.getState(), {
      search: "account-0004",
      sortMode: "time",
      mediaFilter: "video",
    });

    expect(imageResults.map((item) => item.path)).toEqual(["account-0001"]);
    expect(videoResults.map((item) => item.path)).toEqual(["account-0004"]);
    expect(selectCategorySummary(store.getState(), "account-0004")?.path).toBe("account-0004");
  });

  it("returns only favorited accounts in favorite mode and updates immediately when toggled", () => {
    const store = createRootFolderStore();
    store.replaceRoot(makePerfRootPayload(4));

    store.setFavorite("account-0002", true);

    const favoritedResults = selectFilteredAccounts(store.getState(), {
      search: "",
      sortMode: "favorite",
      mediaFilter: "image",
    });
    expect(favoritedResults.map((item) => item.path)).toEqual(["account-0002"]);
    expect(favoritedResults[0]?.favorite).toBe(true);

    store.setFavorite("account-0001", true);

    const nextResults = selectFilteredAccounts(store.getState(), {
      search: "",
      sortMode: "favorite",
      mediaFilter: "image",
    });
    expect(nextResults.slice(0, 2).map((item) => item.path)).toEqual([
      "account-0001",
      "account-0002",
    ]);
  });

  it("marks failed previews without touching ready entries", () => {
    const store = createRootFolderStore();
    const payload = makePerfRootPayload(4);
    payload.subfolders[2] = {
      ...payload.subfolders[2],
      countsReady: false,
      previewReady: false,
      approximate: true,
      counts: { images: 0, gifs: 0, videos: 0, subfolders: 0 },
      previews: [],
    };
    store.replaceRoot(payload);

    const before = store.getState().subfoldersByPath.get("account-0003");
    const readyBefore = store.getState().subfoldersByPath.get("account-0001");

    store.markPreviewFailed(["account-0003"], {
      expectedVersion: store.getVersion(),
    });

    const after = store.getState().subfoldersByPath.get("account-0003");
    const readyAfter = store.getState().subfoldersByPath.get("account-0001");

    expect(before).not.toBe(after);
    expect(after?.countsReady).toBe(true);
    expect(after?.previewReady).toBe(false);
    expect(readyAfter).toBe(readyBefore);
  });
});
