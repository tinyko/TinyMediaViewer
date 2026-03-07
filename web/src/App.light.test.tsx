import assert from "node:assert/strict";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import {
  fetchFolder,
  fetchFolderPreviews,
  postFolderFavorite,
  postPerfDiagnostics,
  postPreviewDiagnostics,
} from "./api";
import type {
  FolderPayload,
  FolderPreviewBatchOutput,
  MediaItem,
} from "./types";
import { renderWithQueryClient } from "./test/queryClient";

vi.mock("./api", () => ({
  fetchFolder: vi.fn(),
  fetchFolderPreviews: vi.fn(),
  postFolderFavorite: vi.fn(),
  postPreviewDiagnostics: vi.fn(),
  postPerfDiagnostics: vi.fn(),
}));

const mockedFetchFolder = vi.mocked(fetchFolder);
const mockedFetchFolderPreviews = vi.mocked(fetchFolderPreviews);
const mockedPostFolderFavorite = vi.mocked(postFolderFavorite);
const mockedPostPreviewDiagnostics = vi.mocked(postPreviewDiagnostics);
const mockedPostPerfDiagnostics = vi.mocked(postPerfDiagnostics);

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const makeMedia = (name: string, kind: MediaItem["kind"]): MediaItem => ({
  name,
  path: `alpha/${name}`,
  url: `/media/alpha/${name}`,
  kind,
  size: 1024,
  modified: Date.now(),
});

const makeLightRootPayload = (): FolderPayload => ({
  folder: { name: "root", path: "" },
  breadcrumb: [{ name: "root", path: "" }],
  subfolders: [
    {
      name: "alpha",
      path: "alpha",
      modified: 100,
      counts: { images: 0, gifs: 0, videos: 0, subfolders: 0 },
      previews: [],
      countsReady: false,
      previewReady: false,
      favorite: false,
      approximate: true,
    },
    {
      name: "beta",
      path: "beta",
      modified: 90,
      counts: { images: 0, gifs: 0, videos: 0, subfolders: 0 },
      previews: [],
      countsReady: false,
      previewReady: false,
      favorite: false,
      approximate: true,
    },
  ],
  media: [],
  totals: { media: 0, subfolders: 2 },
});

const makeRootPayloadWithSubfolders = (
  subfolders: FolderPayload["subfolders"]
): FolderPayload => ({
  folder: { name: "root", path: "" },
  breadcrumb: [{ name: "root", path: "" }],
  subfolders,
  media: [],
  totals: { media: 0, subfolders: subfolders.length },
});

const makeCategoryPayloadWithMedia = (
  path: string,
  media: MediaItem[]
): FolderPayload => ({
  folder: { name: path, path },
  breadcrumb: [
    { name: "root", path: "" },
    { name: path, path },
  ],
  subfolders: [],
  media,
  totals: { media: media.length, subfolders: 0 },
});

const makeCategoryPayload = (path: string): FolderPayload =>
  makeCategoryPayloadWithMedia(path, [makeMedia("IMG_20260219_120000.jpg", "image")]);

describe("App root light mode + preview backfill", () => {
  beforeEach(() => {
    mockedFetchFolder.mockReset();
    mockedFetchFolderPreviews.mockReset();
    mockedPostFolderFavorite.mockReset();
    mockedPostPreviewDiagnostics.mockReset();
    mockedPostPerfDiagnostics.mockReset();
    mockedPostFolderFavorite.mockResolvedValue({ path: "alpha", favorite: true });
    mockedPostPreviewDiagnostics.mockResolvedValue();
    mockedPostPerfDiagnostics.mockResolvedValue();
  });

  it("loads root with mode=light and backfills counts via preview batch API", async () => {
    const previewOutput: FolderPreviewBatchOutput = {
      items: [
        {
          name: "alpha",
          path: "alpha",
          modified: 100,
          counts: { images: 2, gifs: 0, videos: 0, subfolders: 0 },
          previews: [makeMedia("A.jpg", "image")],
          countsReady: true,
          previewReady: true,
          favorite: false,
        },
        {
          name: "beta",
          path: "beta",
          modified: 90,
          counts: { images: 0, gifs: 1, videos: 1, subfolders: 0 },
          previews: [makeMedia("B.gif", "gif"), makeMedia("B.mp4", "video")],
          countsReady: true,
          previewReady: true,
          favorite: false,
        },
      ],
    };

    mockedFetchFolder.mockImplementation((targetPath = "", options) => {
      if (targetPath === "") {
        expect(options?.mode).toBe("light");
        return Promise.resolve(makeLightRootPayload());
      }
      return Promise.resolve(makeCategoryPayload(targetPath));
    });
    mockedFetchFolderPreviews.mockResolvedValue(previewOutput);

    renderWithQueryClient(<App />);

    expect(await screen.findByRole("button", { name: /^alpha/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^beta/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(mockedFetchFolderPreviews).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByText("🖼️ 2")).toBeInTheDocument();
      expect(screen.getByText("🎞️ 1")).toBeInTheDocument();
    });
  });

  it("keeps items when countsReady=false and filters precisely after backfill", async () => {
    const previewDeferred = deferred<FolderPreviewBatchOutput>();

    mockedFetchFolder.mockImplementation((targetPath = "", options) => {
      if (targetPath === "") {
        expect(options?.mode).toBe("light");
        return Promise.resolve({
          ...makeLightRootPayload(),
          subfolders: [makeLightRootPayload().subfolders[0]],
          totals: { media: 0, subfolders: 1 },
        });
      }
      return Promise.resolve(makeCategoryPayload(targetPath));
    });
    mockedFetchFolderPreviews.mockReturnValue(previewDeferred.promise);

    renderWithQueryClient(<App />);

    const alphaButton = await screen.findByRole("button", { name: /^alpha/i });
    expect(alphaButton).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "视频" }));
    expect(screen.getByRole("button", { name: /^alpha/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(mockedFetchFolderPreviews).toHaveBeenCalled();
    });

    previewDeferred.resolve({
      items: [
        {
          name: "alpha",
          path: "alpha",
          modified: 100,
          counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
          previews: [makeMedia("A.jpg", "image")],
          countsReady: true,
          previewReady: true,
          favorite: false,
        },
      ],
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /alpha/i })).not.toBeInTheDocument();
    });
  });

  it("updates meter pill by filtered total count", async () => {
    const manyMedia = Array.from({ length: 60 }, (_, index) =>
      makeMedia(`IMG_${index.toString().padStart(4, "0")}.jpg`, "image")
    );

    mockedFetchFolder.mockImplementation((targetPath = "") => {
      if (targetPath === "") {
        return Promise.resolve({
          ...makeLightRootPayload(),
          subfolders: [makeLightRootPayload().subfolders[0]],
          totals: { media: 0, subfolders: 1 },
        });
      }
      return Promise.resolve({
        folder: { name: targetPath, path: targetPath },
        breadcrumb: [
          { name: "root", path: "" },
          { name: targetPath, path: targetPath },
        ],
        subfolders: [],
        media: manyMedia,
        totals: { media: manyMedia.length, subfolders: 0 },
      });
    });
    mockedFetchFolderPreviews.mockResolvedValue({
      items: [
        {
          name: "alpha",
          path: "alpha",
          modified: 100,
          counts: { images: manyMedia.length, gifs: 0, videos: 0, subfolders: 0 },
          previews: manyMedia.slice(0, 2),
          countsReady: true,
          previewReady: true,
          favorite: false,
        },
      ],
    });

    renderWithQueryClient(<App />);

    expect(await screen.findByText("60 / 60 媒体")).toBeInTheDocument();
  });

  it("uses selected folder typed counts as meter total", async () => {
    mockedFetchFolder.mockImplementation((targetPath = "") => {
      if (targetPath === "") {
        return Promise.resolve({
          ...makeLightRootPayload(),
          subfolders: [
            {
              ...makeLightRootPayload().subfolders[0],
              countsReady: true,
              previewReady: true,
              counts: { images: 4112, gifs: 0, videos: 2, subfolders: 0 },
            },
          ],
          totals: { media: 0, subfolders: 1 },
        });
      }
      return Promise.resolve({
        folder: { name: targetPath, path: targetPath },
        breadcrumb: [
          { name: "root", path: "" },
          { name: targetPath, path: targetPath },
        ],
        subfolders: [],
        media: [makeMedia("A.jpg", "image"), makeMedia("B.mp4", "video")],
        totals: { media: 4114, subfolders: 0 },
      });
    });
    mockedFetchFolderPreviews.mockResolvedValue({ items: [] });

    renderWithQueryClient(<App />);

    expect(await screen.findByText("4112 / 4114 媒体")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "视频" }));

    await waitFor(() => {
      expect(screen.getByText("2 / 4114 媒体")).toBeInTheDocument();
    });
  });

  it("filters account list by non-zero typed counts and reloads the visible account for the active media kind", async () => {
    mockedFetchFolder.mockImplementation((targetPath = "", options) => {
      if (targetPath === "") {
        return Promise.resolve({
          ...makeLightRootPayload(),
          subfolders: [
            {
              ...makeLightRootPayload().subfolders[0],
              name: "alpha",
              path: "alpha",
              countsReady: true,
              previewReady: true,
              counts: { images: 2, gifs: 0, videos: 0, subfolders: 0 },
            },
            {
              ...makeLightRootPayload().subfolders[1],
              name: "beta",
              path: "beta",
              countsReady: true,
              previewReady: true,
              counts: { images: 0, gifs: 0, videos: 3, subfolders: 0 },
            },
          ],
          totals: { media: 0, subfolders: 2 },
        });
      }

      if (targetPath === "beta" && options?.kind === "video") {
        return Promise.resolve(
          makeCategoryPayloadWithMedia(targetPath, [makeMedia("clip.mp4", "video")])
        );
      }

      return Promise.resolve(
        makeCategoryPayloadWithMedia(targetPath, [makeMedia("cover.jpg", "image")])
      );
    });
    mockedFetchFolderPreviews.mockResolvedValue({ items: [] });

    renderWithQueryClient(<App />);

    expect(await screen.findByRole("button", { name: /^alpha/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /beta/i })).not.toBeInTheDocument();
    expect(await screen.findByText("cover.jpg")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "视频" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /alpha/i })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^beta/i })).toBeInTheDocument();
    });
    expect(await screen.findByText("clip.mp4")).toBeInTheDocument();
    expect(
      mockedFetchFolder.mock.calls.some(
        ([targetPath, options]) => targetPath === "beta" && options?.kind === "video"
      )
    ).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "图片" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^alpha/i })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /beta/i })).not.toBeInTheDocument();
    });
    expect(await screen.findByText("cover.jpg")).toBeInTheDocument();
    assert.equal(
      mockedFetchFolder.mock.calls.filter(
        ([targetPath, options]) => targetPath === "alpha" && options?.kind === "image"
      ).length,
      1
    );
  });

  it("requests filtered server pages when switching media kind", async () => {
    mockedFetchFolder.mockImplementation((targetPath = "", options) => {
      if (targetPath === "") {
        return Promise.resolve({
          ...makeLightRootPayload(),
          subfolders: [
            {
              ...makeLightRootPayload().subfolders[0],
              countsReady: true,
              previewReady: true,
              counts: { images: 2, gifs: 0, videos: 1, subfolders: 0 },
            },
          ],
          totals: { media: 0, subfolders: 1 },
        });
      }

      if (options?.kind === "video") {
        return Promise.resolve({
          folder: { name: targetPath, path: targetPath },
          breadcrumb: [
            { name: "root", path: "" },
            { name: targetPath, path: targetPath },
          ],
          subfolders: [],
          media: [makeMedia("video_only.mp4", "video")],
          totals: { media: 3, subfolders: 0 },
        });
      }

      return Promise.resolve({
        folder: { name: targetPath, path: targetPath },
        breadcrumb: [
          { name: "root", path: "" },
          { name: targetPath, path: targetPath },
        ],
        subfolders: [],
        media: [makeMedia("cover.jpg", "image"), makeMedia("detail.jpg", "image")],
        totals: { media: 3, subfolders: 0 },
      });
    });
    mockedFetchFolderPreviews.mockResolvedValue({ items: [] });

    renderWithQueryClient(<App />);

    await screen.findByText("cover.jpg");
    await userEvent.click(screen.getByRole("button", { name: "视频" }));

    expect(await screen.findByText("video_only.mp4")).toBeInTheDocument();
    expect(
      mockedFetchFolder.mock.calls.some(
        ([targetPath, options]) => targetPath === "alpha" && options?.kind === "video"
      )
    ).toBe(true);
    expect(
      mockedFetchFolder.mock.calls.some(
        ([targetPath, options]) => targetPath === "alpha" && options?.cursor === "page-2"
      )
    ).toBe(false);
    expect(screen.queryByText("该账号暂无符合过滤条件的媒体")).not.toBeInTheDocument();
  });

  it("shows only favorited accounts in favorite mode and switches the active category", async () => {
    mockedPostFolderFavorite.mockImplementation(async ({ path, favorite }) => ({
      path,
      favorite,
    }));
    mockedFetchFolder.mockImplementation((targetPath = "") => {
      if (targetPath === "") {
        return Promise.resolve(
          makeRootPayloadWithSubfolders([
            {
              ...makeLightRootPayload().subfolders[0],
              countsReady: true,
              previewReady: true,
              counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
            },
            {
              ...makeLightRootPayload().subfolders[1],
              countsReady: true,
              previewReady: true,
              counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
            },
          ])
        );
      }

      if (targetPath === "alpha") {
        return Promise.resolve(
          makeCategoryPayloadWithMedia(targetPath, [makeMedia("A.jpg", "image")])
        );
      }

      return Promise.resolve(
        makeCategoryPayloadWithMedia(targetPath, [makeMedia("B.jpg", "image")])
      );
    });
    mockedFetchFolderPreviews.mockResolvedValue({ items: [] });

    renderWithQueryClient(<App />);

    expect(await screen.findByText("A.jpg")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "收藏 beta" }));

    await waitFor(() => {
      expect(mockedPostFolderFavorite).toHaveBeenCalledWith({
        path: "beta",
        favorite: true,
      });
    });

    await userEvent.click(screen.getByRole("button", { name: "按收藏" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^alpha/i })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^beta/i })).toBeInTheDocument();
    });
    expect(await screen.findByText("B.jpg")).toBeInTheDocument();
    expect(screen.queryByText("A.jpg")).not.toBeInTheDocument();
  });

  it("search switches to the matching account and clears the preview when no accounts match", async () => {
    mockedFetchFolder.mockImplementation((targetPath = "") => {
      if (targetPath === "") {
        return Promise.resolve(
          makeRootPayloadWithSubfolders([
            {
              ...makeLightRootPayload().subfolders[0],
              countsReady: true,
              previewReady: true,
              counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
            },
            {
              ...makeLightRootPayload().subfolders[1],
              countsReady: true,
              previewReady: true,
              counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
            },
          ])
        );
      }

      if (targetPath === "alpha") {
        return Promise.resolve(
          makeCategoryPayloadWithMedia(targetPath, [makeMedia("A.jpg", "image")])
        );
      }

      return Promise.resolve(
        makeCategoryPayloadWithMedia(targetPath, [makeMedia("B.jpg", "image")])
      );
    });
    mockedFetchFolderPreviews.mockResolvedValue({ items: [] });

    renderWithQueryClient(<App />);

    expect(await screen.findByText("A.jpg")).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText("筛选账号名称...");

    await userEvent.type(searchInput, "beta");

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /^alpha/i })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^beta/i })).toBeInTheDocument();
    });
    expect(await screen.findByText("B.jpg")).toBeInTheDocument();
    expect(screen.queryByText("A.jpg")).not.toBeInTheDocument();

    await userEvent.clear(searchInput);
    await userEvent.type(searchInput, "missing");

    await waitFor(() => {
      expect(screen.getByText("没有匹配的账号")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^beta/i })).not.toBeInTheDocument();
      expect(screen.queryByText("B.jpg")).not.toBeInTheDocument();
    });
    expect(screen.queryByText("该账号暂无符合过滤条件的媒体")).not.toBeInTheDocument();
  });

  it("refreshes root and reloads the current category without mixing stale page data", async () => {
    const initialRoot = makeRootPayloadWithSubfolders([
      {
        ...makeLightRootPayload().subfolders[0],
        countsReady: true,
        previewReady: true,
        counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
      },
    ]);
    const refreshedRoot = makeRootPayloadWithSubfolders([
      {
        ...initialRoot.subfolders[0],
        modified: 200,
      },
    ]);

    let rootCalls = 0;
    let alphaCalls = 0;
    mockedFetchFolder.mockImplementation((targetPath = "", options) => {
      if (targetPath === "") {
        expect(options?.mode).toBe("light");
        rootCalls += 1;
        return Promise.resolve(rootCalls === 1 ? initialRoot : refreshedRoot);
      }

      alphaCalls += 1;
      return Promise.resolve(
        alphaCalls === 1
          ? makeCategoryPayloadWithMedia(targetPath, [makeMedia("A_old.jpg", "image")])
          : makeCategoryPayloadWithMedia(targetPath, [makeMedia("A_new.jpg", "image")])
      );
    });
    mockedFetchFolderPreviews.mockResolvedValue({ items: [] });

    renderWithQueryClient(<App />);

    expect(await screen.findByText("A_old.jpg")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    expect(await screen.findByText("A_new.jpg")).toBeInTheDocument();
    expect(screen.queryByText("A_old.jpg")).not.toBeInTheDocument();
    expect(rootCalls).toBe(2);
    expect(alphaCalls).toBe(2);
  });

  it("refresh falls back to the first available category when the previous selection disappears", async () => {
    const initialRoot = makeRootPayloadWithSubfolders([
      {
        ...makeLightRootPayload().subfolders[0],
        countsReady: true,
        previewReady: true,
        counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
      },
      {
        ...makeLightRootPayload().subfolders[1],
        countsReady: true,
        previewReady: true,
        counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
      },
    ]);
    const refreshedRoot = makeRootPayloadWithSubfolders([
      {
        name: "gamma",
        path: "gamma",
        modified: 300,
        counts: { images: 0, gifs: 0, videos: 0, subfolders: 0 },
        previews: [],
        countsReady: false,
        previewReady: false,
        favorite: false,
        approximate: true,
      },
    ]);

    let rootCalls = 0;
    mockedFetchFolder.mockImplementation((targetPath = "", options) => {
      if (targetPath === "") {
        expect(options?.mode).toBe("light");
        rootCalls += 1;
        return Promise.resolve(rootCalls === 1 ? initialRoot : refreshedRoot);
      }

      if (targetPath === "alpha") {
        return Promise.resolve(makeCategoryPayloadWithMedia(targetPath, [makeMedia("A.jpg", "image")]));
      }
      if (targetPath === "beta") {
        return Promise.resolve(makeCategoryPayloadWithMedia(targetPath, [makeMedia("B.jpg", "image")]));
      }
      return Promise.resolve(makeCategoryPayloadWithMedia(targetPath, [makeMedia("G.jpg", "image")]));
    });
    mockedFetchFolderPreviews.mockResolvedValue({ items: [] });

    renderWithQueryClient(<App />);

    await screen.findByText("A.jpg");
    await userEvent.click(screen.getByRole("button", { name: /^beta/i }));
    expect(await screen.findByText("B.jpg")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    expect(await screen.findByText("G.jpg")).toBeInTheDocument();
    expect(screen.queryByText("B.jpg")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^gamma/i })).toBeInTheDocument();
  });

  it("closes the preview modal when the refreshed first page no longer contains the selected media", async () => {
    let alphaCalls = 0;
    mockedFetchFolder.mockImplementation((targetPath = "") => {
      if (targetPath === "") {
        return Promise.resolve(
          makeRootPayloadWithSubfolders([
            {
              ...makeLightRootPayload().subfolders[0],
              countsReady: true,
              previewReady: true,
              counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
            },
          ])
        );
      }

      alphaCalls += 1;
      return Promise.resolve(
        alphaCalls === 1
          ? makeCategoryPayloadWithMedia(targetPath, [makeMedia("Visible.jpg", "image")])
          : makeCategoryPayloadWithMedia(targetPath, [makeMedia("Replaced.jpg", "image")])
      );
    });
    mockedFetchFolderPreviews.mockResolvedValue({ items: [] });

    renderWithQueryClient(<App />);

    const mediaName = await screen.findByText("Visible.jpg");
    await userEvent.click(mediaName);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    expect(await screen.findByText("Replaced.jpg")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("restarts root preview backfill after refresh and ignores stale preview batches", async () => {
    const firstPreviewDeferred = deferred<FolderPreviewBatchOutput>();
    const secondPreviewDeferred = deferred<FolderPreviewBatchOutput>();

    mockedFetchFolder.mockImplementation((targetPath = "", options) => {
      if (targetPath === "") {
        expect(options?.mode).toBe("light");
        return Promise.resolve(
          makeRootPayloadWithSubfolders([
            {
              ...makeLightRootPayload().subfolders[0],
              countsReady: false,
              previewReady: false,
              counts: { images: 0, gifs: 0, videos: 0, subfolders: 0 },
              previews: [],
              approximate: true,
            },
          ])
        );
      }

      return Promise.resolve(makeCategoryPayloadWithMedia(targetPath, [makeMedia("A.jpg", "image")]));
    });

    let previewCalls = 0;
    mockedFetchFolderPreviews.mockImplementation(() => {
      previewCalls += 1;
      return previewCalls === 1 ? firstPreviewDeferred.promise : secondPreviewDeferred.promise;
    });

    renderWithQueryClient(<App />);

    await waitFor(() => {
      expect(mockedFetchFolderPreviews).toHaveBeenCalledTimes(1);
    });

    await userEvent.click(screen.getByRole("button", { name: "刷新" }));

    await waitFor(() => {
      expect(mockedFetchFolderPreviews).toHaveBeenCalledTimes(2);
    });

    firstPreviewDeferred.resolve({
      items: [
        {
          name: "alpha",
          path: "alpha",
          modified: 100,
          counts: { images: 9, gifs: 0, videos: 0, subfolders: 0 },
          previews: [makeMedia("stale.jpg", "image")],
          countsReady: true,
          previewReady: true,
          favorite: false,
        },
      ],
    });

    await waitFor(() => {
      expect(screen.queryByText("🖼️ 9")).not.toBeInTheDocument();
    });

    secondPreviewDeferred.resolve({
      items: [
        {
          name: "alpha",
          path: "alpha",
          modified: 110,
          counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
          previews: [makeMedia("fresh.jpg", "image")],
          countsReady: true,
          previewReady: true,
          favorite: false,
        },
      ],
    });

    expect(await screen.findByText("🖼️ 1")).toBeInTheDocument();
    expect(screen.queryByText("🖼️ 9")).not.toBeInTheDocument();
  });
});
