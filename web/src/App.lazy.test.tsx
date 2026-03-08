import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  CategoryPagePayload,
  MediaItem,
  RootSummaryPayload,
  SystemUsageReport,
  ViewerPreferences,
} from "./types";

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

const makeMedia = (name: string): MediaItem => ({
  name,
  path: `alpha/${name}`,
  url: `/media/alpha/${name}`,
  kind: "image",
  size: 1024,
  modified: 1,
});

const makeRootPayload = (): RootSummaryPayload => ({
  folder: { name: "root", path: "" },
  breadcrumb: [{ name: "root", path: "" }],
  subfolders: [
    {
      name: "alpha",
      path: "alpha",
      modified: 1,
      counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
      previews: [makeMedia("Lazy.jpg")],
      countsReady: true,
      previewReady: true,
      favorite: false,
    },
  ],
  totals: { media: 1, subfolders: 1 },
});

const makeCategoryPayload = (path: string): CategoryPagePayload => ({
  folder: { name: path, path },
  breadcrumb: [
    { name: "root", path: "" },
    { name: path, path },
  ],
  media: [makeMedia("Lazy.jpg")],
  counts: { images: 1, gifs: 0, videos: 0, subfolders: 0 },
  totalMedia: 1,
  filteredTotal: 1,
});

const makeSystemUsageReport = (): SystemUsageReport => ({
  rootPath: "/Users/tiny/X",
  generatedAt: Date.now(),
  items: [
    {
      account: "alpha",
      totalSize: 1024,
      imageSize: 1024,
      gifSize: 0,
      videoSize: 0,
      otherSize: 0,
      topFiles: [{ path: "alpha/Lazy.jpg", size: 1024 }],
    },
  ],
});

const setupLazyApp = async (preferences: Partial<ViewerPreferences> = {}) => {
  vi.resetModules();

  const loadCounts = {
    effects: 0,
    preview: 0,
    systemUsage: 0,
  };
  const api = {
    fetchCategoryPage: vi.fn((path: string) => Promise.resolve(makeCategoryPayload(path))),
    fetchRootSummary: vi.fn(() => Promise.resolve(makeRootPayload())),
    fetchFolderPreviews: vi.fn(() => Promise.resolve({ items: [] })),
    fetchSystemUsage: vi.fn(() => Promise.resolve(makeSystemUsageReport())),
    fetchViewerPreferences: vi.fn(() => Promise.resolve(makeViewerPreferences(preferences))),
    postFolderFavorite: vi.fn(() => Promise.resolve({ path: "alpha", favorite: false })),
    postPreviewDiagnostics: vi.fn(() => Promise.resolve()),
    postPerfDiagnostics: vi.fn(() => Promise.resolve()),
    postViewerPreferences: vi.fn((input: ViewerPreferences) => Promise.resolve(input)),
  };

  vi.doMock("./api", () => api);
  vi.doMock("./features/effects/EffectsStage", () => {
    loadCounts.effects += 1;
    return {
      EffectsStage: () => <div data-testid="effects-stage" />,
    };
  });
  vi.doMock("./features/preview/MediaPreviewModal", () => {
    loadCounts.preview += 1;
    return {
      MediaPreviewModal: ({ media }: { media: MediaItem | null }) =>
        media ? <div role="dialog" aria-label="preview-lazy">{media.name}</div> : null,
    };
  });
  vi.doMock("./features/systemUsage/SystemUsageModal", () => {
    loadCounts.systemUsage += 1;
    return {
      SystemUsageModal: ({ open }: { open: boolean }) =>
        open ? <div role="dialog" aria-label="system-usage-lazy">system usage</div> : null,
    };
  });

  const [{ default: App }, { renderWithQueryClient }] = await Promise.all([
    import("./App"),
    import("./test/queryClient"),
  ]);

  renderWithQueryClient(<App />);
  return { loadCounts, api };
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("./api");
  vi.doUnmock("./features/effects/EffectsStage");
  vi.doUnmock("./features/preview/MediaPreviewModal");
  vi.doUnmock("./features/systemUsage/SystemUsageModal");
});

describe("App lazy boundaries", () => {
  it("defers optional chunks until the corresponding UI path is used", async () => {
    const { loadCounts, api } = await setupLazyApp({
      effectsMode: "off",
    });

    await screen.findByRole("button", { name: /^alpha/i });

    expect(loadCounts.effects).toBe(0);
    expect(loadCounts.preview).toBe(0);
    expect(loadCounts.systemUsage).toBe(0);
    expect(api.fetchSystemUsage).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "系统占用情况" }));

    await waitFor(() => {
      expect(loadCounts.systemUsage).toBe(1);
      expect(screen.getByRole("dialog", { name: "system-usage-lazy" })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: /Lazy\.jpg/ }));

    await waitFor(() => {
      expect(loadCounts.preview).toBe(1);
      expect(screen.getByRole("dialog", { name: "preview-lazy" })).toBeInTheDocument();
    });
  });
});
