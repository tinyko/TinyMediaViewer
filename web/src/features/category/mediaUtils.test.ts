import type { MediaItem } from "../../types";
import {
  filterMediaByKind,
  getMediaTimestamp,
  mergeMediaByPath,
  sortMediaByTime,
} from "./mediaUtils";

const makeItem = (overrides: Partial<MediaItem>): MediaItem => ({
  name: "sample.jpg",
  path: "folder/sample.jpg",
  url: "/media/folder/sample.jpg",
  kind: "image",
  size: 10,
  modified: 1000,
  ...overrides,
});

describe("mediaUtils", () => {
  it("includes gif in image filter and excludes it from video filter", () => {
    const image = makeItem({ kind: "image", path: "a", name: "a.jpg" });
    const gif = makeItem({ kind: "gif", path: "b", name: "b.gif" });
    const video = makeItem({ kind: "video", path: "c", name: "c.mp4" });

    expect(filterMediaByKind([image, gif, video], "image")).toEqual([image, gif]);
    expect(filterMediaByKind([image, gif, video], "video")).toEqual([video]);
  });

  it("sorts by timestamp from file name when available", () => {
    const oldByName = makeItem({
      name: "IMG_20250101_000000.jpg",
      path: "old-name",
      modified: 999999,
    });
    const newByName = makeItem({
      name: "IMG_20260101_000000.jpg",
      path: "new-name",
      modified: 1,
    });
    const sortedDesc = sortMediaByTime([oldByName, newByName], "desc");
    const sortedAsc = sortMediaByTime([oldByName, newByName], "asc");

    expect(sortedDesc.map((item) => item.path)).toEqual(["new-name", "old-name"]);
    expect(sortedAsc.map((item) => item.path)).toEqual(["old-name", "new-name"]);
    expect(getMediaTimestamp(newByName)).toBeGreaterThan(getMediaTimestamp(oldByName));
  });

  it("merges pages without duplicates", () => {
    const firstPage = [
      makeItem({ path: "1", name: "1.jpg", modified: 3 }),
      makeItem({ path: "2", name: "2.jpg", modified: 2 }),
    ];
    const secondPage = [
      makeItem({ path: "2", name: "2.jpg", modified: 2 }),
      makeItem({ path: "3", name: "3.jpg", modified: 1 }),
    ];

    const merged = mergeMediaByPath(firstPage, secondPage);
    expect(merged.map((item) => item.path)).toEqual(["1", "2", "3"]);
  });
});
