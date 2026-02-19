import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildServer } from "./app";
import type { AppConfig } from "./config";
import { MediaScanner } from "./scanner";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const baseConfig = (
  mediaRoot: string,
  overrides: Partial<AppConfig> = {}
): AppConfig => ({
  mediaRoot,
  port: 0,
  host: "127.0.0.1",
  previewLimit: 6,
  previewBatchLimit: 64,
  maxItemsPerFolder: 20000,
  folderPageLimit: 2,
  maxFolderPageLimit: 1000,
  statConcurrency: 8,
  cacheTtlMs: 60_000,
  cacheMaxEntries: 256,
  cacheMaxBytes: 200 * 1024 * 1024,
  enableLightRootMode: true,
  enableIndexPersist: true,
  indexDir: path.join(mediaRoot, ".index"),
  indexMaxBytes: 128 * 1024 * 1024,
  requireLanToken: false,
  mediaAccessToken: "test-token",
  corsAllowedOrigins: ["http://localhost", "http://127.0.0.1"],
  ...overrides,
});

const withTempMediaRoot = async <T>(
  run: (mediaRoot: string) => Promise<T>
): Promise<T> => {
  const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tmv-server-test-"));
  try {
    return await run(mediaRoot);
  } finally {
    await fs.rm(mediaRoot, { recursive: true, force: true });
  }
};

test("GET /api/folder supports pagination with nextCursor", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.writeFile(path.join(mediaRoot, "a.jpg"), "a");
    await fs.writeFile(path.join(mediaRoot, "b.png"), "b");
    await fs.writeFile(path.join(mediaRoot, "c.mp4"), "c");

    const app = buildServer(
      baseConfig(mediaRoot, {
        folderPageLimit: 2,
      })
    );

    try {
      const pageOne = await app.inject({
        method: "GET",
        url: "/api/folder?limit=2",
      });
      assert.equal(pageOne.statusCode, 200);
      const pageOneBody = pageOne.json();
      assert.equal(pageOneBody.media.length, 2);
      assert.equal(pageOneBody.totals.media, 3);
      assert.equal(pageOneBody.nextCursor, "2");

      const pageTwo = await app.inject({
        method: "GET",
        url: "/api/folder?limit=2&cursor=2",
      });
      assert.equal(pageTwo.statusCode, 200);
      const pageTwoBody = pageTwo.json();
      assert.equal(pageTwoBody.media.length, 1);
      assert.equal(pageTwoBody.nextCursor, undefined);
    } finally {
      await app.close();
    }
  });
});

test("mode=light keeps root response shallow and mode param is validated", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "alpha"), { recursive: true });
    await fs.writeFile(path.join(mediaRoot, "alpha", "1.jpg"), "1");
    await fs.writeFile(path.join(mediaRoot, "alpha", "2.gif"), "2");

    const app = buildServer(baseConfig(mediaRoot));

    try {
      const light = await app.inject({
        method: "GET",
        url: "/api/folder?mode=light",
      });
      assert.equal(light.statusCode, 200);
      const lightBody = light.json();
      const lightPreview = lightBody.subfolders.find(
        (entry: { path: string }) => entry.path === "alpha"
      );
      assert.ok(lightPreview);
      assert.equal(lightPreview.countsReady, false);
      assert.equal(lightPreview.previewReady, false);
      assert.equal(lightPreview.approximate, true);
      assert.deepEqual(lightPreview.counts, {
        images: 0,
        gifs: 0,
        videos: 0,
        subfolders: 0,
      });

      const full = await app.inject({
        method: "GET",
        url: "/api/folder?mode=full",
      });
      assert.equal(full.statusCode, 200);
      const fullBody = full.json();
      const fullPreview = fullBody.subfolders.find(
        (entry: { path: string }) => entry.path === "alpha"
      );
      assert.ok(fullPreview);
      assert.equal(fullPreview.countsReady, true);
      assert.equal(fullPreview.previewReady, true);
      assert.equal(fullPreview.approximate, false);
      assert.deepEqual(fullPreview.counts, {
        images: 1,
        gifs: 1,
        videos: 0,
        subfolders: 0,
      });

      const invalidMode = await app.inject({
        method: "GET",
        url: "/api/folder?mode=invalid",
      });
      assert.equal(invalidMode.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

test("POST /api/folder/previews validates payload and returns preview batch", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "a"), { recursive: true });
    await fs.mkdir(path.join(mediaRoot, "b"), { recursive: true });
    await fs.writeFile(path.join(mediaRoot, "a", "1.jpg"), "1");
    await fs.writeFile(path.join(mediaRoot, "a", "2.mp4"), "2");
    await fs.writeFile(path.join(mediaRoot, "b", "1.gif"), "1");

    const app = buildServer(
      baseConfig(mediaRoot, {
        previewBatchLimit: 2,
      })
    );

    try {
      const ok = await app.inject({
        method: "POST",
        url: "/api/folder/previews",
        payload: {
          paths: ["a", "b"],
          limitPerFolder: 3,
        },
      });
      assert.equal(ok.statusCode, 200);
      const okBody = ok.json();
      assert.equal(okBody.items.length, 2);

      const itemA = okBody.items.find((entry: { path: string }) => entry.path === "a");
      const itemB = okBody.items.find((entry: { path: string }) => entry.path === "b");
      assert.ok(itemA);
      assert.ok(itemB);
      assert.equal(itemA.countsReady, true);
      assert.equal(itemA.previewReady, true);
      assert.equal(itemA.counts.images, 1);
      assert.equal(itemA.counts.videos, 1);
      assert.equal(itemB.counts.gifs, 1);

      const overLimit = await app.inject({
        method: "POST",
        url: "/api/folder/previews",
        payload: {
          paths: ["a", "b", "c"],
        },
      });
      assert.equal(overLimit.statusCode, 400);

      const invalid = await app.inject({
        method: "POST",
        url: "/api/folder/previews",
        payload: {
          paths: ["a", 123],
        },
      });
      assert.equal(invalid.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

test("path traversal and non-media files are blocked", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.writeFile(path.join(mediaRoot, "safe.jpg"), "safe");
    await fs.writeFile(path.join(mediaRoot, "note.txt"), "note");

    const app = buildServer(baseConfig(mediaRoot));

    try {
      const folderTraversal = await app.inject({
        method: "GET",
        url: "/api/folder?path=../../etc",
      });
      assert.equal(folderTraversal.statusCode, 400);

      const mediaTraversal = await app.inject({
        method: "GET",
        url: "/media/..%2F..%2Fetc%2Fpasswd",
      });
      assert.equal(mediaTraversal.statusCode, 404);

      const nonMedia = await app.inject({
        method: "GET",
        url: "/media/note.txt",
      });
      assert.equal(nonMedia.statusCode, 403);

      const safeMedia = await app.inject({
        method: "GET",
        url: "/media/safe.jpg",
      });
      assert.equal(safeMedia.statusCode, 200);
    } finally {
      await app.close();
    }
  });
});

test("LAN requests require token and origin whitelist is enforced", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.writeFile(path.join(mediaRoot, "safe.jpg"), "safe");

    const app = buildServer(
      baseConfig(mediaRoot, {
        requireLanToken: true,
        mediaAccessToken: "secret-token",
        corsAllowedOrigins: ["http://127.0.0.1:4300"],
      })
    );

    try {
      const blockedOrigin = await app.inject({
        method: "GET",
        url: "/api/folder",
        headers: {
          origin: "http://evil.example.com",
        },
      });
      assert.equal(blockedOrigin.statusCode, 403);

      const missingToken = await app.inject({
        method: "GET",
        url: "/api/folder",
        headers: {
          origin: "http://127.0.0.1:4300",
        },
        remoteAddress: "192.168.1.50",
      });
      assert.equal(missingToken.statusCode, 401);

      const withToken = await app.inject({
        method: "GET",
        url: "/api/folder",
        headers: {
          origin: "http://127.0.0.1:4300",
          "x-media-viewer-token": "secret-token",
        },
        remoteAddress: "192.168.1.50",
      });
      assert.equal(withToken.statusCode, 200);
    } finally {
      await app.close();
    }
  });
});

test("scanner deduplicates concurrent full scans for the same folder", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.writeFile(path.join(mediaRoot, "a.jpg"), "a");

    const scanner = new MediaScanner(
      mediaRoot,
      6,
      20000,
      240,
      1000,
      8,
      60_000,
      256,
      200 * 1024 * 1024,
      false,
      path.join(mediaRoot, ".index"),
      128 * 1024 * 1024
    );

    const scannerAny = scanner as unknown as {
      buildFullFolderSnapshot: (...args: unknown[]) => Promise<unknown>;
    };
    const original = scannerAny.buildFullFolderSnapshot.bind(scanner);
    let calls = 0;
    scannerAny.buildFullFolderSnapshot = async (...args: unknown[]) => {
      calls += 1;
      await sleep(40);
      return original(...args);
    };

    const [one, two, three] = await Promise.all([
      scanner.getFolder("", { mode: "full" }),
      scanner.getFolder("", { mode: "full" }),
      scanner.getFolder("", { mode: "full" }),
    ]);

    assert.equal(calls, 1);
    assert.equal(one.totals.media, 1);
    assert.equal(two.totals.media, 1);
    assert.equal(three.totals.media, 1);
  });
});

test("scanner uses persisted index snapshot and invalidates on mtime change", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    const indexDir = await fs.mkdtemp(path.join(os.tmpdir(), "tmv-index-test-"));
    try {
      await fs.writeFile(path.join(mediaRoot, "a.jpg"), "a");

      const createScanner = () =>
        new MediaScanner(
          mediaRoot,
          6,
          20000,
          240,
          1000,
          8,
          60_000,
          256,
          200 * 1024 * 1024,
          true,
          indexDir,
          64 * 1024 * 1024
        );

      const warmScanner = createScanner();
      await warmScanner.getFolder("", { mode: "full" });

      const coldScanner = createScanner();
      const coldAny = coldScanner as unknown as {
        buildFullFolderSnapshot: (...args: unknown[]) => Promise<unknown>;
      };
      const original = coldAny.buildFullFolderSnapshot.bind(coldScanner);
      let calls = 0;
      coldAny.buildFullFolderSnapshot = async (...args: unknown[]) => {
        calls += 1;
        return original(...args);
      };

      await coldScanner.getFolder("", { mode: "full" });
      assert.equal(calls, 0);

      await sleep(10);
      await fs.writeFile(path.join(mediaRoot, "b.jpg"), "b");
      await coldScanner.getFolder("", { mode: "full" });
      assert.equal(calls, 1);
    } finally {
      await fs.rm(indexDir, { recursive: true, force: true });
    }
  });
});
