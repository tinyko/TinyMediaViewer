import { act, renderHook, waitFor } from "@testing-library/react";
import { fetchFolder } from "../../api";
import type { FolderPayload } from "../../types";
import { makePerfMediaItem } from "../../test/performanceFixtures";
import { createQueryClientWrapper } from "../../test/queryClient";
import { useCategoryMedia } from "./useCategoryMedia";

vi.mock("../../api", () => ({
  fetchFolder: vi.fn(),
}));

const mockedFetchFolder = vi.mocked(fetchFolder);

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
): FolderPayload => {
  const kind = options.kind ?? "image";
  return {
    folder: { name: path, path },
    breadcrumb: [
      { name: "root", path: "" },
      { name: path, path },
    ],
    subfolders: [],
    media: names.map((name, index) => ({
      ...makePerfMediaItem(path, index + 1, kind),
      name,
      path: `${path}/${name}`,
      url: `/media/${path}/${name}`,
      thumbnailUrl: `/thumb/${path}/${name}`,
      modified: names.length - index,
    })),
    totals: { media: names.length, subfolders: 0 },
    nextCursor: options.nextCursor,
  };
};

describe("useCategoryMedia", () => {
  beforeEach(() => {
    mockedFetchFolder.mockReset();
  });

  it("requests sort-specific pages from the backend", async () => {
    mockedFetchFolder.mockImplementation((path = "", options) => {
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
      mockedFetchFolder.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "image" && options?.sort === "desc"
      )
    ).toHaveLength(1);
    expect(
      mockedFetchFolder.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "image" && options?.sort === "asc"
      )
    ).toHaveLength(1);
  });

  it("caches independently by media kind and sort order", async () => {
    mockedFetchFolder.mockImplementation((path = "", options) => {
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
      mockedFetchFolder.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "image" && options?.sort === "desc"
      )
    ).toHaveLength(1);
    expect(
      mockedFetchFolder.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "image" && options?.sort === "asc"
      )
    ).toHaveLength(1);
    expect(
      mockedFetchFolder.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "video" && options?.sort === "desc"
      )
    ).toHaveLength(1);
  });

  it("merges paged media without duplicates in backend sort order", async () => {
    mockedFetchFolder.mockImplementation((path = "", options) => {
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
  });

  it("rerolls media locally in random mode without refetching backend pages", async () => {
    mockedFetchFolder.mockImplementation((path = "", options) => {
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
      mockedFetchFolder.mock.calls.filter(
        ([path, options]) =>
          path === "alpha" && options?.kind === "image" && options?.sort === "desc"
      )
    ).toHaveLength(1);
  });
});
