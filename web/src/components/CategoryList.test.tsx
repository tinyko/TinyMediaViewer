import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

describe("CategoryList", () => {
  it("only reports visible paths when the visible set actually changes", async () => {
    const onVisiblePathsChange = vi.fn();
    const view = render(
      <CategoryList
        items={items}
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
        items={[...items]}
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

    render(
      <CategoryList
        items={items}
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

    render(
      <CategoryList
        items={items}
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
});
