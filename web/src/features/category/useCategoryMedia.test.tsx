import { act, renderHook, waitFor } from "@testing-library/react";
import { fetchCategoryPage } from "../../api";
import type { CategoryPagePayload } from "../../types";
import { makePerfMediaItem } from "../../test/performanceFixtures";
import { createQueryClientWrapper } from "../../test/queryClient";
import { useCategoryMedia } from "./useCategoryMedia";

vi.mock("../../api", () => ({
  fetchCategoryPage: vi.fn(),
}));

const mockedFetchCategoryPage = vi.mocked(fetchCategoryPage);

interface HookProps {
  rootVersion: number;
  mediaFilter: "image" | "video";
  mediaSort: "asc" | "desc" | "random";
  mediaRandomSeed: number;
}

const makeCategoryPage = (
  path: string,
  names: string[],
  options: { nextCursor?: string; kind?: "image" | "video" } = {}
): CategoryPagePayload => {
  const kind = options.kind ?? "image";
  return {
    folder: { name: path, path },
    breadcrumb: [
      { name: "root", path: "" },
      { name: path, path },
    ],
    media: names.map((name, index) => ({
      ...makePerfMediaItem(path, index + 1, kind),
      name,
      path: `${path}/${name}`,
      url: `/media/${path}/${name}`,
      thumbnailUrl: `/thumb/${path}/${name}`,
      modified: names.length - index,
    })),
    counts: {
      images: kind === "video" ? 0 : names.length,
      gifs: 0,
      videos: kind === "video" ? names.length : 0,
      subfolders: 0,
    },
    totalMedia: names.length,
    filteredTotal: names.length,
    nextCursor: options.nextCursor,
  };
};

describe("useCategoryMedia", () => {
  beforeEach(() => {
    mockedFetchCategoryPage.mockReset();
  });

  it("requests sort-specific pages from the backend", async () => {
    mockedFetchCategoryPage.mockImplementation((path, options) => {
      if (path !== "alpha") {
        throw new Error(`Unexpected path ${path}`);
      }
      if (options?.sort === "asc") {
        return Promise.resolve(
          makeCategoryPage("alpha", [
            "IMG_20260307_000001.jpg",
            "IMG_20260307_000002.jpg",
            "IMG_20260307_000003.jpg",
          ])
        );
      }
      return Promise.resolve(
        makeCategoryPage("alpha", [
          "IMG_20260307_000003.jpg",
          "IMG_20260307_000002.jpg",
          "IMG_20260307_000001.jpg",
        ])
      );
    });

    const { result, rerender } = renderHook<ReturnType<typeof useCategoryMedia>, HookProps>(
      ({ rootVersion, mediaFilter, mediaSort }) =>
        useCategoryMedia({ rootVersion, mediaFilter, mediaSort, mediaRandomSeed: 0 }),
      {
        wrapper: createQueryClientWrapper(),
        initialProps: {
          rootVersion: 1,
          mediaFilter: "image",
          mediaSort: "desc",
          mediaRandomSeed: 0,
        },
      }
    );

    await act(async () => {
      await result.current.handleSelectCategory("alpha");
    });

    await waitFor(() => {
      expect(result.current.categoryMedia.map((item) => item.name)).toEqual([
        "IMG_20260307_000003.jpg",
        "IMG_20260307_000002.jpg",
        "IMG_20260307_000001.jpg",
      ]);
    });

    rerender({
      rootVersion: 1,
      mediaFilter: "image",
      mediaSort: "asc",
      mediaRandomSeed: 0,
    });

    await waitFor(() => {
      expect(result.current.categoryMedia.map((item) => item.name)).toEqual([
        "IMG_20260307_000001.jpg",
        "IMG_20260307_000002.jpg",
        "IMG_20260307_000003.jpg",
      ]);
    });

    rerender({
      rootVersion: 1,
      mediaFilter: "image",
      mediaSort: "desc",
      mediaRandomSeed: 0,
    });

    await waitFor(() => {
      expect(result.current.categoryMedia.map((item) => item.name)).toEqual([
        "IMG_20260307_000003.jpg",
        "IMG_20260307_000002.jpg",
        "IMG_20260307_000001.jpg",
      ]);
    });

    expect(
      mockedFetchCategoryPage.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "image" && options?.sort === "desc"
      )
    ).toHaveLength(1);
    expect(
      mockedFetchCategoryPage.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "image" && options?.sort === "asc"
      )
    ).toHaveLength(1);
  });

  it("caches independently by media kind and sort order", async () => {
    mockedFetchCategoryPage.mockImplementation((path, options) => {
      if (path !== "alpha") {
        throw new Error(`Unexpected path ${path}`);
      }

      if (options?.kind === "video") {
        return Promise.resolve(
          makeCategoryPage("alpha", ["video_3.mp4", "video_2.mp4", "video_1.mp4"], {
            kind: "video",
          })
        );
      }
      if (options?.sort === "asc") {
        return Promise.resolve(
          makeCategoryPage("alpha", [
            "IMG_20260307_000001.jpg",
            "IMG_20260307_000002.jpg",
            "IMG_20260307_000003.jpg",
          ])
        );
      }
      return Promise.resolve(
        makeCategoryPage("alpha", [
          "IMG_20260307_000003.jpg",
          "IMG_20260307_000002.jpg",
          "IMG_20260307_000001.jpg",
        ])
      );
    });

    const { result, rerender } = renderHook<ReturnType<typeof useCategoryMedia>, HookProps>(
      ({ rootVersion, mediaFilter, mediaSort }) =>
        useCategoryMedia({ rootVersion, mediaFilter, mediaSort, mediaRandomSeed: 0 }),
      {
        wrapper: createQueryClientWrapper(),
        initialProps: {
          rootVersion: 1,
          mediaFilter: "image",
          mediaSort: "desc",
          mediaRandomSeed: 0,
        },
      }
    );

    await act(async () => {
      await result.current.handleSelectCategory("alpha");
    });

    await waitFor(() => {
      expect(result.current.categoryMedia.map((item) => item.name)).toEqual([
        "IMG_20260307_000003.jpg",
        "IMG_20260307_000002.jpg",
        "IMG_20260307_000001.jpg",
      ]);
    });

    rerender({
      rootVersion: 1,
      mediaFilter: "image",
      mediaSort: "asc",
      mediaRandomSeed: 0,
    });

    await waitFor(() => {
      expect(result.current.categoryMedia.map((item) => item.name)).toEqual([
        "IMG_20260307_000001.jpg",
        "IMG_20260307_000002.jpg",
        "IMG_20260307_000003.jpg",
      ]);
    });

    rerender({
      rootVersion: 1,
      mediaFilter: "video",
      mediaSort: "desc",
      mediaRandomSeed: 0,
    });

    await waitFor(() => {
      expect(result.current.categoryMedia.map((item) => item.name)).toEqual([
        "video_3.mp4",
        "video_2.mp4",
        "video_1.mp4",
      ]);
    });

    rerender({
      rootVersion: 1,
      mediaFilter: "image",
      mediaSort: "desc",
      mediaRandomSeed: 0,
    });

    await waitFor(() => {
      expect(result.current.categoryMedia.map((item) => item.name)).toEqual([
        "IMG_20260307_000003.jpg",
        "IMG_20260307_000002.jpg",
        "IMG_20260307_000001.jpg",
      ]);
    });

    expect(
      mockedFetchCategoryPage.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "image" && options?.sort === "desc"
      )
    ).toHaveLength(1);
    expect(
      mockedFetchCategoryPage.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "image" && options?.sort === "asc"
      )
    ).toHaveLength(1);
    expect(
      mockedFetchCategoryPage.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "video" && options?.sort === "desc"
      )
    ).toHaveLength(1);
  });

  it("merges paged media without duplicates in backend sort order", async () => {
    mockedFetchCategoryPage.mockImplementation((path, options) => {
      if (path !== "alpha") {
        throw new Error(`Unexpected path ${path}`);
      }
      expect(options?.sort).toBe("desc");
      if (options?.cursor === "page-2") {
        return Promise.resolve(
          makeCategoryPage("alpha", ["IMG_20260307_000002.jpg", "IMG_20260307_000001.jpg"])
        );
      }
      return Promise.resolve(
        makeCategoryPage(
          "alpha",
          ["IMG_20260307_000004.jpg", "IMG_20260307_000003.jpg", "IMG_20260307_000002.jpg"],
          { nextCursor: "page-2" }
        )
      );
    });

    const { result } = renderHook(
      () =>
        useCategoryMedia({
          rootVersion: 1,
          mediaFilter: "image",
          mediaSort: "desc",
          mediaRandomSeed: 0,
        }),
      {
        wrapper: createQueryClientWrapper(),
      }
    );

    await act(async () => {
      await result.current.handleSelectCategory("alpha");
    });

    await waitFor(() => {
      expect(result.current.categoryHasMore).toBe(true);
    });

    const firstPageItems = result.current.categoryMedia.slice();

    await act(async () => {
      await result.current.loadMoreCategory();
    });

    await waitFor(() => {
      expect(result.current.categoryMedia.map((item) => item.path)).toEqual([
        "alpha/IMG_20260307_000004.jpg",
        "alpha/IMG_20260307_000003.jpg",
        "alpha/IMG_20260307_000002.jpg",
        "alpha/IMG_20260307_000001.jpg",
      ]);
      expect(result.current.categoryHasMore).toBe(false);
    });
    expect(result.current.categoryMedia[0]).toBe(firstPageItems[0]);
    expect(result.current.categoryMedia[1]).toBe(firstPageItems[1]);
    expect(result.current.categoryMedia[2]).toBe(firstPageItems[2]);
  });

  it("rerolls media locally in random mode without refetching backend pages", async () => {
    mockedFetchCategoryPage.mockImplementation((path, options) => {
      if (path !== "alpha") {
        throw new Error(`Unexpected path ${path}`);
      }
      expect(options?.sort).toBe("desc");
      return Promise.resolve(
        makeCategoryPage("alpha", [
          "IMG_20260307_000005.jpg",
          "IMG_20260307_000004.jpg",
          "IMG_20260307_000003.jpg",
          "IMG_20260307_000002.jpg",
          "IMG_20260307_000001.jpg",
        ])
      );
    });

    const { result, rerender } = renderHook<ReturnType<typeof useCategoryMedia>, HookProps>(
      ({ rootVersion, mediaFilter, mediaSort, mediaRandomSeed }) =>
        useCategoryMedia({ rootVersion, mediaFilter, mediaSort, mediaRandomSeed }),
      {
        wrapper: createQueryClientWrapper(),
        initialProps: {
          rootVersion: 1,
          mediaFilter: "image",
          mediaSort: "desc",
          mediaRandomSeed: 0,
        },
      }
    );

    await act(async () => {
      await result.current.handleSelectCategory("alpha");
    });

    await waitFor(() => {
      expect(result.current.categoryMedia.map((item) => item.name)).toEqual([
        "IMG_20260307_000005.jpg",
        "IMG_20260307_000004.jpg",
        "IMG_20260307_000003.jpg",
        "IMG_20260307_000002.jpg",
        "IMG_20260307_000001.jpg",
      ]);
    });

    rerender({
      rootVersion: 1,
      mediaFilter: "image",
      mediaSort: "random",
      mediaRandomSeed: 1,
    });

    let firstRandomOrder: string[] = [];
    await waitFor(() => {
      firstRandomOrder = result.current.categoryMedia.map((item) => item.name);
      expect(firstRandomOrder).not.toEqual([
        "IMG_20260307_000005.jpg",
        "IMG_20260307_000004.jpg",
        "IMG_20260307_000003.jpg",
        "IMG_20260307_000002.jpg",
        "IMG_20260307_000001.jpg",
      ]);
    });

    rerender({
      rootVersion: 1,
      mediaFilter: "image",
      mediaSort: "random",
      mediaRandomSeed: 2,
    });

    await waitFor(() => {
      expect(result.current.categoryMedia.map((item) => item.name)).not.toEqual(firstRandomOrder);
    });

    expect(
      mockedFetchCategoryPage.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "image" && options?.sort === "desc"
      )
    ).toHaveLength(1);
  });

  it("rebuilds aggregated media when the category query key changes", async () => {
    mockedFetchCategoryPage.mockImplementation((_path, options) => {
      if (options?.cursor === "page-2" && options?.kind === "image" && options?.sort === "desc") {
        return Promise.resolve(
          makeCategoryPage("alpha", ["IMG_20260307_000002.jpg", "IMG_20260307_000001.jpg"])
        );
      }
      if (options?.kind === "image" && options?.sort === "desc") {
        if (options?.cursor) {
          throw new Error(`Unexpected cursor: ${options.cursor}`);
        }
        if (callCount === 0) {
          callCount += 1;
          return Promise.resolve(
            makeCategoryPage(
              "alpha",
              ["IMG_20260307_000004.jpg", "IMG_20260307_000003.jpg", "IMG_20260307_000002.jpg"],
              { nextCursor: "page-2" }
            )
          );
        }
        return Promise.resolve(
          makeCategoryPage("alpha", ["IMG_20260308_000006.jpg", "IMG_20260308_000005.jpg"])
        );
      }
      throw new Error(`Unexpected query: ${JSON.stringify(options)}`);
    });

    let callCount = 0;
    const { result, rerender } = renderHook<ReturnType<typeof useCategoryMedia>, HookProps>(
      ({ rootVersion, mediaFilter, mediaSort, mediaRandomSeed }) =>
        useCategoryMedia({ rootVersion, mediaFilter, mediaSort, mediaRandomSeed }),
      {
        wrapper: createQueryClientWrapper(),
        initialProps: {
          rootVersion: 1,
          mediaFilter: "image",
          mediaSort: "desc",
          mediaRandomSeed: 0,
        },
      }
    );

    await act(async () => {
      await result.current.handleSelectCategory("alpha");
    });

    await waitFor(() => {
      expect(result.current.categoryHasMore).toBe(true);
    });

    await act(async () => {
      await result.current.loadMoreCategory();
    });

    await waitFor(() => {
      expect(result.current.categoryMedia.map((item) => item.path)).toEqual([
        "alpha/IMG_20260307_000004.jpg",
        "alpha/IMG_20260307_000003.jpg",
        "alpha/IMG_20260307_000002.jpg",
        "alpha/IMG_20260307_000001.jpg",
      ]);
    });

    rerender({
      rootVersion: 2,
      mediaFilter: "image",
      mediaSort: "desc",
      mediaRandomSeed: 0,
    });

    await waitFor(() => {
      expect(result.current.categoryMedia.map((item) => item.path)).toEqual([
        "alpha/IMG_20260308_000006.jpg",
        "alpha/IMG_20260308_000005.jpg",
      ]);
      expect(result.current.categoryHasMore).toBe(false);
    });

    expect(
      mockedFetchCategoryPage.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "image" && options?.sort === "desc"
      )
    ).toHaveLength(3);
  });
});
