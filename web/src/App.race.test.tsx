import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import {
  fetchFolder,
  fetchFolderPreviews,
  postFolderFavorite,
  postPerfDiagnostics,
  postPreviewDiagnostics,
} from "./api";
import type { FolderPayload } from "./types";

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

const rootPayload = (): FolderPayload => ({
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
    {
      name: "beta",
      path: "beta",
      modified: 99,
      counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
      previews: [],
      countsReady: true,
      previewReady: true,
      favorite: false,
    },
  ],
  media: [],
  totals: { media: 0, subfolders: 2 },
});

const categoryPayload = (path: string, mediaName: string): FolderPayload => ({
  folder: { name: path, path },
  breadcrumb: [
    { name: "root", path: "" },
    { name: path, path },
  ],
  subfolders: [],
  media: [
    {
      name: mediaName,
      path: `${path}/${mediaName}`,
      url: `/media/${path}/${mediaName}`,
      kind: "image",
      size: 1024,
      modified: Date.now(),
    },
  ],
  totals: { media: 1, subfolders: 0 },
});

describe("App request race handling", () => {
  beforeEach(() => {
    mockedFetchFolder.mockReset();
    mockedFetchFolderPreviews.mockReset();
    mockedPostFolderFavorite.mockReset();
    mockedPostPreviewDiagnostics.mockReset();
    mockedPostPerfDiagnostics.mockReset();
    mockedPostFolderFavorite.mockResolvedValue({ path: "alpha", favorite: true });
    mockedPostPreviewDiagnostics.mockResolvedValue();
    mockedPostPerfDiagnostics.mockResolvedValue();
    mockedFetchFolderPreviews.mockResolvedValue({ items: [] });
  });

  it("keeps latest selected category result when responses return out of order", async () => {
    const alphaDeferred = deferred<FolderPayload>();
    const betaDeferred = deferred<FolderPayload>();

    mockedFetchFolder.mockImplementation((path = "") => {
      if (path === "") {
        return Promise.resolve(rootPayload());
      }
      if (path === "alpha") {
        return alphaDeferred.promise;
      }
      if (path === "beta") {
        return betaDeferred.promise;
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    render(<App />);

    const betaButton = await screen.findByRole("button", { name: /^beta/i });
    await userEvent.click(betaButton);

    betaDeferred.resolve(categoryPayload("beta", "B_photo.jpg"));
    expect(await screen.findByText("B_photo.jpg")).toBeInTheDocument();

    alphaDeferred.resolve(categoryPayload("alpha", "A_photo.jpg"));
    await waitFor(() => {
      expect(screen.queryByText("A_photo.jpg")).not.toBeInTheDocument();
    });
    expect(screen.getByText("B_photo.jpg")).toBeInTheDocument();
  });
});
