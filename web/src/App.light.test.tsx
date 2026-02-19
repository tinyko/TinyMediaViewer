import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import {
  fetchFolder,
  fetchFolderPreviews,
  postPerfDiagnostics,
  postPreviewDiagnostics,
} from "./api";
import type {
  FolderPayload,
  FolderPreviewBatchOutput,
  MediaItem,
} from "./types";

vi.mock("./api", () => ({
  fetchFolder: vi.fn(),
  fetchFolderPreviews: vi.fn(),
  postPreviewDiagnostics: vi.fn(),
  postPerfDiagnostics: vi.fn(),
}));

const mockedFetchFolder = vi.mocked(fetchFolder);
const mockedFetchFolderPreviews = vi.mocked(fetchFolderPreviews);
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
      approximate: true,
    },
  ],
  media: [],
  totals: { media: 0, subfolders: 2 },
});

const makeCategoryPayload = (path: string): FolderPayload => ({
  folder: { name: path, path },
  breadcrumb: [
    { name: "root", path: "" },
    { name: path, path },
  ],
  subfolders: [],
  media: [makeMedia("IMG_20260219_120000.jpg", "image")],
  totals: { media: 1, subfolders: 0 },
});

describe("App root light mode + preview backfill", () => {
  beforeEach(() => {
    mockedFetchFolder.mockReset();
    mockedFetchFolderPreviews.mockReset();
    mockedPostPreviewDiagnostics.mockReset();
    mockedPostPerfDiagnostics.mockReset();
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
        },
        {
          name: "beta",
          path: "beta",
          modified: 90,
          counts: { images: 0, gifs: 1, videos: 1, subfolders: 0 },
          previews: [makeMedia("B.gif", "gif"), makeMedia("B.mp4", "video")],
          countsReady: true,
          previewReady: true,
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

    render(<App />);

    expect(await screen.findByRole("button", { name: /alpha/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /beta/i })).toBeInTheDocument();

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

    render(<App />);

    const alphaButton = await screen.findByRole("button", { name: /alpha/i });
    expect(alphaButton).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "视频" }));
    expect(screen.getByRole("button", { name: /alpha/i })).toBeInTheDocument();

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
        },
      ],
    });

    render(<App />);

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

    render(<App />);

    expect(await screen.findByText("4112 / 4114 媒体")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "视频" }));

    await waitFor(() => {
      expect(screen.getByText("2 / 4114 媒体")).toBeInTheDocument();
    });
  });
});
