import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRootFolderStore } from "../features/root/rootStore";
import { makePerfRootPayload } from "../test/performanceFixtures";
import { CategoryList } from "./CategoryList";

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [
      { index: 0, start: 0, key: "row-0" },
      { index: 1, start: 94, key: "row-1" },
    ],
    getTotalSize: () => 188,
  }),
}));

const items = [
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
];

const createStore = () => {
  const store = createRootFolderStore();
  store.replaceRoot({
    folder: { name: "root", path: "" },
    breadcrumb: [{ name: "root", path: "" }],
    subfolders: items,
    totals: { media: 0, subfolders: items.length },
  });
  return store;
};

describe("CategoryList", () => {
  it("only reports visible paths when the visible set actually changes", async () => {
    const onVisiblePathsChange = vi.fn();
    const store = createStore();
    const view = render(
      <CategoryList
        paths={items.map((item) => item.path)}
        rootStore={store}
        selectedPath="alpha"
        loading={false}
        onSelect={() => undefined}
        onToggleFavorite={() => undefined}
        onVisiblePathsChange={onVisiblePathsChange}
      />
    );

    await waitFor(() => {
      expect(onVisiblePathsChange).toHaveBeenCalledWith(["alpha", "beta"]);
    });
    expect(onVisiblePathsChange).toHaveBeenCalledTimes(1);

    view.rerender(
      <CategoryList
        paths={items.map((item) => item.path)}
        rootStore={store}
        selectedPath="beta"
        loading={false}
        onSelect={() => undefined}
        onToggleFavorite={() => undefined}
        onVisiblePathsChange={onVisiblePathsChange}
      />
    );

    await waitFor(() => {
      expect(onVisiblePathsChange).toHaveBeenCalledTimes(1);
    });
  });

  it("toggles favorites without selecting the account row", async () => {
    const onSelect = vi.fn();
    const onToggleFavorite = vi.fn();
    const store = createStore();

    render(
      <CategoryList
        paths={items.map((item) => item.path)}
        rootStore={store}
        selectedPath={null}
        loading={false}
        onSelect={onSelect}
        onToggleFavorite={onToggleFavorite}
        onVisiblePathsChange={() => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "收藏 alpha" }));

    expect(onToggleFavorite).toHaveBeenCalledWith("alpha", true);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("selects the account from the full row button", () => {
    const onSelect = vi.fn();
    const store = createStore();

    render(
      <CategoryList
        paths={items.map((item) => item.path)}
        rootStore={store}
        selectedPath={null}
        loading={false}
        onSelect={onSelect}
        onToggleFavorite={() => undefined}
        onVisiblePathsChange={() => undefined}
      />
    );

    const rowButton = screen.getByText("alpha").closest("button");
    expect(rowButton).not.toBeNull();
    if (!rowButton) return;

    fireEvent.click(rowButton);

    expect(onSelect).toHaveBeenCalledWith("alpha");
  });

  it("re-renders only the affected visible row for preview patches in a large list", async () => {
    const store = createRootFolderStore();
    store.replaceRoot(makePerfRootPayload(1_000));
    const onRowRender = vi.fn();

    render(
      <CategoryList
        paths={Array.from({ length: 1_000 }, (_, index) =>
          `account-${String(index + 1).padStart(4, "0")}`
        )}
        rootStore={store}
        selectedPath="account-0001"
        loading={false}
        onSelect={() => undefined}
        onToggleFavorite={() => undefined}
        onVisiblePathsChange={() => undefined}
        onRowRender={onRowRender}
      />
    );

    await waitFor(() => {
      expect(onRowRender).toHaveBeenCalledTimes(2);
    });

    onRowRender.mockClear();
    const target = store.getState().subfoldersByPath.get("account-0001");
    expect(target).toBeDefined();

    act(() => {
      store.applyPreviewBatch(
        [
          {
            ...target!,
            counts: { images: 99, gifs: 0, videos: 1, subfolders: 0 },
          },
        ],
        { expectedVersion: store.getVersion() }
      );
    });

    await waitFor(() => {
      expect(onRowRender.mock.calls.map(([path]) => path)).toEqual(["account-0001"]);
    });
  });
});
