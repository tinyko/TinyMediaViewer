import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import {
  fetchCategoryPage,
  fetchRootSummary,
  fetchFolderPreviews,
  fetchSystemUsage,
  fetchViewerPreferences,
  postFolderFavorite,
  postPerfDiagnostics,
  postPreviewDiagnostics,
  postViewerPreferences,
} from "./api";
import type { CategoryPagePayload, RootSummaryPayload, ViewerPreferences } from "./types";
import { renderWithQueryClient } from "./test/queryClient";

vi.mock("./api", () => ({
  fetchCategoryPage: vi.fn(),
  fetchRootSummary: vi.fn(),
  fetchFolderPreviews: vi.fn(),
  fetchSystemUsage: vi.fn(),
  fetchViewerPreferences: vi.fn(),
  postFolderFavorite: vi.fn(),
  postPreviewDiagnostics: vi.fn(),
  postPerfDiagnostics: vi.fn(),
  postViewerPreferences: vi.fn(),
}));

const mockedFetchCategoryPage = vi.mocked(fetchCategoryPage);
const mockedFetchRootSummary = vi.mocked(fetchRootSummary);
const mockedFetchFolderPreviews = vi.mocked(fetchFolderPreviews);
const mockedFetchSystemUsage = vi.mocked(fetchSystemUsage);
const mockedFetchViewerPreferences = vi.mocked(fetchViewerPreferences);
const mockedPostFolderFavorite = vi.mocked(postFolderFavorite);
const mockedPostPreviewDiagnostics = vi.mocked(postPreviewDiagnostics);
const mockedPostPerfDiagnostics = vi.mocked(postPerfDiagnostics);
const mockedPostViewerPreferences = vi.mocked(postViewerPreferences);

const makeViewerPreferences = (
  overrides: Partial<ViewerPreferences> = {}
): ViewerPreferences => ({
  search: "",
  sortMode: "time",
  randomSeed: 0,
  mediaSort: "desc",
  mediaRandomSeed: 0,
  mediaFilter: "image",
  categoryPath: undefined,
  theme: "light",
  manualTheme: false,
  effectsMode: "auto",
  effectsRenderer: "webgpu",
  ...overrides,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const rootPayload = (): RootSummaryPayload => ({
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
  totals: { media: 0, subfolders: 2 },
});

const categoryPayload = (path: string, mediaName: string): CategoryPagePayload => ({
  folder: { name: path, path },
  breadcrumb: [
    { name: "root", path: "" },
    { name: path, path },
  ],
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
  counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
  totalMedia: 1,
  filteredTotal: 1,
});

describe("App request race handling", () => {
  beforeEach(() => {
    mockedFetchCategoryPage.mockReset();
    mockedFetchRootSummary.mockReset();
    mockedFetchFolderPreviews.mockReset();
    mockedFetchSystemUsage.mockReset();
    mockedFetchViewerPreferences.mockReset();
    mockedPostFolderFavorite.mockReset();
    mockedPostPreviewDiagnostics.mockReset();
    mockedPostPerfDiagnostics.mockReset();
    mockedPostViewerPreferences.mockReset();
    mockedFetchSystemUsage.mockResolvedValue({
      rootPath: "/Users/tiny/X",
      generatedAt: Date.now(),
      items: [],
    });
    mockedFetchViewerPreferences.mockResolvedValue(makeViewerPreferences());
    mockedPostFolderFavorite.mockResolvedValue({ path: "alpha", favorite: true });
    mockedPostPreviewDiagnostics.mockResolvedValue();
    mockedPostPerfDiagnostics.mockResolvedValue();
    mockedPostViewerPreferences.mockImplementation(async (input) => input);
    mockedFetchFolderPreviews.mockResolvedValue({ items: [] });
  });

  it("keeps latest selected category result when responses return out of order", async () => {
    const alphaDeferred = deferred<CategoryPagePayload>();
    const betaDeferred = deferred<CategoryPagePayload>();

    mockedFetchRootSummary.mockResolvedValue(rootPayload());
    mockedFetchCategoryPage.mockImplementation((path) => {
      if (path === "alpha") {
        return alphaDeferred.promise;
      }
      if (path === "beta") {
        return betaDeferred.promise;
      }
      return Promise.reject(new Error(`Unexpected path: ${path}`));
    });

    renderWithQueryClient(<App />);

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
