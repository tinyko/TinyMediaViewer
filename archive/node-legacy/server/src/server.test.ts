import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildServer } from "./app";
import type { AppConfig } from "./config";
import { IndexStore } from "./index_store";
import { MediaScanner, type FolderPreview, type FolderSnapshot } from "./scanner";

const execFileAsync = promisify(execFile);
const ffmpegBin = process.env.FFMPEG_BIN?.trim() || "ffmpeg";
const hasFfmpeg = spawnSync(ffmpegBin, ["-version"], { stdio: "ignore" }).status === 0;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const testWithFfmpeg = hasFfmpeg ? test : test.skip;

const baseConfig = (
  mediaRoot: string,
  overrides: Partial<AppConfig> = {}
): AppConfig => ({
  mediaRoot,
  port: 0,
  host: "127.0.0.1",
  ffmpegBin,
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
  indexDir: indexDirForMediaRoot(mediaRoot),
  indexMaxBytes: 128 * 1024 * 1024,
  thumbnailCacheDir: path.join(mediaRoot, ".thumbs"),
  requireLanToken: false,
  mediaAccessToken: "test-token",
  corsAllowedOrigins: ["http://localhost", "http://127.0.0.1"],
  ...overrides,
});

const indexDirForMediaRoot = (mediaRoot: string) =>
  path.join(os.tmpdir(), `${path.basename(mediaRoot)}-index`);

const rmWithRetries = async (targetPath: string) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") {
        throw error;
      }
      await sleep(25);
    }
  }
  await fs.rm(targetPath, { recursive: true, force: true });
};

const withTempMediaRoot = async <T>(
  run: (mediaRoot: string) => Promise<T>
): Promise<T> => {
  const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tmv-server-test-"));
  const indexDir = indexDirForMediaRoot(mediaRoot);
  try {
    return await run(mediaRoot);
  } finally {
    await rmWithRetries(indexDir);
    await rmWithRetries(mediaRoot);
  }
};

const createTestVideo = async (outputPath: string) => {
  await execFileAsync(ffmpegBin, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=160x90:d=1",
    "-pix_fmt",
    "yuv420p",
    outputPath,
  ]);
};

const createTestImage = async (outputPath: string) => {
  await execFileAsync(ffmpegBin, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=1600x900",
    "-frames:v",
    "1",
    outputPath,
  ]);
};

const waitForIndexSnapshot = async (indexDir: string) => {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const files = await fs.readdir(indexDir);
      if (files.some((name) => name.endsWith(".json"))) {
        return;
      }
    } catch {
      // Keep polling until the index directory is materialized.
    }
    await sleep(25);
  }
  assert.fail(`Timed out waiting for persisted index snapshot in ${indexDir}`);
};

const waitForWatchEvents = async () => {
  await sleep(150);
};

test("IndexStore round-trips snapshots via chunked JSON serialization", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    const store = new IndexStore({
      dir: indexDirForMediaRoot(mediaRoot),
      maxBytes: 32 * 1024 * 1024,
      version: 2,
    });

    const media = Array.from({ length: 320 }, (_, index) => ({
      name: `clip-${index}.mp4`,
      path: `account/videos/clip-${index}.mp4`,
      url: `/media/account/videos/clip-${index}.mp4`,
      thumbnailUrl: `/thumb/account/videos/clip-${index}.mp4?m=${index}`,
      kind: "video" as const,
      size: 1024 + index,
      modified: 10_000 + index,
    }));

    const snapshot: FolderSnapshot = {
      folder: {
        name: "account",
        path: "account",
      },
      breadcrumb: [
        { name: "root", path: "" },
        { name: "account", path: "account" },
      ],
      subfolders: [
        {
          name: "alpha",
          path: "account/alpha",
          modified: 2000,
          counts: {
            images: 1,
            gifs: 0,
            videos: 2,
            subfolders: 0,
          },
          previews: media.slice(0, 2),
          countsReady: true,
          previewReady: true,
          approximate: false,
        },
      ],
      media,
      totals: {
        media: media.length,
        subfolders: 1,
      },
    };

    await store.writeSnapshot("account", "stamp-1", snapshot);

    const restored = await store.readSnapshot<FolderSnapshot>("account", "stamp-1");
    assert.deepEqual(restored, snapshot);
    assert.equal(await store.readSnapshot("account", "stamp-2"), null);
  });
});

test("light snapshots restore from persisted index across scanner instances", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.writeFile(path.join(mediaRoot, "a.jpg"), "a");
    const indexDir = indexDirForMediaRoot(mediaRoot);

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

    const firstScanner = createScanner();
    const first = await firstScanner.getFolder("", { mode: "light" });
    assert.equal(first.totals.media, 1);

    await waitForIndexSnapshot(indexDir);

    const secondScanner = createScanner();
    const scannerAny = secondScanner as unknown as {
      buildLightFolderSnapshot: (...args: unknown[]) => Promise<unknown>;
    };
    scannerAny.buildLightFolderSnapshot = async () => {
      throw new Error("buildLightFolderSnapshot should not run when index snapshot exists");
    };

    const restored = await secondScanner.getFolder("", { mode: "light" });
    assert.equal(restored.totals.media, 1);
    assert.equal(restored.media[0]?.name, "a.jpg");
  });
});

test("full folder payload exposes thumbnails for large images but not tiny ones", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.writeFile(path.join(mediaRoot, "poster.jpg"), Buffer.alloc(600 * 1024, 1));
    await fs.writeFile(path.join(mediaRoot, "icon.jpg"), "tiny");

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
      true,
      indexDirForMediaRoot(mediaRoot),
      64 * 1024 * 1024
    );

    const payload = await scanner.getFolder("", { mode: "full" });
    const poster = payload.media.find((item) => item.name === "poster.jpg");
    const icon = payload.media.find((item) => item.name === "icon.jpg");

    assert.ok(poster?.thumbnailUrl?.startsWith("/thumb/poster.jpg"));
    assert.equal(icon?.thumbnailUrl, undefined);
  });
});

test("folder previews restore from persisted index across scanner instances", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "account", "images"), { recursive: true });
    await fs.writeFile(path.join(mediaRoot, "account", "images", "a.jpg"), "a");
    const indexDir = indexDirForMediaRoot(mediaRoot);

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

    const firstScanner = createScanner();
    const first = await firstScanner.getFolderPreviews(["account"], 6);
    assert.equal(first.items.length, 1);
    assert.equal(first.items[0].previews[0]?.name, "a.jpg");

    await waitForIndexSnapshot(indexDir);

    const secondScanner = createScanner();
    const scannerAny = secondScanner as unknown as {
      buildFolderPreview: (...args: unknown[]) => Promise<unknown>;
    };
    scannerAny.buildFolderPreview = async () => {
      throw new Error("buildFolderPreview should not run when preview index exists");
    };

    const restored = await secondScanner.getFolderPreviews(["account"], 6);
    assert.equal(restored.items.length, 1);
    assert.equal(restored.items[0].previews[0]?.name, "a.jpg");
  });
});

test("folder previews invalidate persisted index when category media changes", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    const accountDir = path.join(mediaRoot, "account");
    const imagesDir = path.join(accountDir, "images");
    const mediaPath = path.join(imagesDir, "a.jpg");
    await fs.mkdir(imagesDir, { recursive: true });
    await fs.writeFile(mediaPath, "v1");
    const indexDir = indexDirForMediaRoot(mediaRoot);

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

    const firstScanner = createScanner();
    const first = await firstScanner.getFolderPreviews(["account"], 6);
    assert.equal(first.items.length, 1);
    const firstModified = first.items[0].previews[0]?.modified ?? 0;
    await waitForIndexSnapshot(indexDir);

    const accountBefore = await fs.stat(accountDir);
    const imagesBefore = await fs.stat(imagesDir);

    await sleep(1100);
    await fs.writeFile(mediaPath, "v2");

    const accountAfter = await fs.stat(accountDir);
    const imagesAfter = await fs.stat(imagesDir);
    assert.equal(accountAfter.mtimeMs, accountBefore.mtimeMs);
    assert.equal(imagesAfter.mtimeMs, imagesBefore.mtimeMs);

    const secondScanner = createScanner();
    const scannerAny = secondScanner as unknown as {
      buildFolderPreview: (...args: unknown[]) => Promise<FolderPreview>;
    };
    const original = scannerAny.buildFolderPreview.bind(secondScanner);
    let calls = 0;
    scannerAny.buildFolderPreview = async (...args: unknown[]) => {
      calls += 1;
      return original(...args);
    };

    const refreshed = await secondScanner.getFolderPreviews(["account"], 6);
    assert.equal(calls, 1);
    assert.equal(refreshed.items.length, 1);
    assert.ok((refreshed.items[0].previews[0]?.modified ?? 0) > firstModified);
  });
});

test("full snapshots reuse persisted subfolder previews across scanner instances", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "account", "alpha"), { recursive: true });
    await fs.writeFile(path.join(mediaRoot, "account", "alpha", "a.jpg"), "a");
    const indexDir = indexDirForMediaRoot(mediaRoot);

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

    const firstScanner = createScanner();
    const previewWarmup = await firstScanner.getFolderPreviews(["account/alpha"], 6);
    assert.equal(previewWarmup.items.length, 1);
    await waitForIndexSnapshot(indexDir);

    const secondScanner = createScanner();
    const scannerAny = secondScanner as unknown as {
      buildFolderPreview: (...args: unknown[]) => Promise<unknown>;
    };
    scannerAny.buildFolderPreview = async () => {
      throw new Error("buildFolderPreview should not run when full reuses preview index");
    };

    const full = await secondScanner.getFolder("account", { mode: "full" });
    assert.equal(full.subfolders.length, 1);
    assert.equal(full.subfolders[0]?.path, "account/alpha");
    assert.equal(full.subfolders[0]?.previews[0]?.name, "a.jpg");
  });
});

test("full snapshots restore persisted directory manifests across scanner instances", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "account", "images"), { recursive: true });
    await fs.writeFile(path.join(mediaRoot, "account", "images", "a.jpg"), "a");
    const indexDir = indexDirForMediaRoot(mediaRoot);

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

    const firstScanner = createScanner();
    const warmup = await firstScanner.getFolder("account", { mode: "full" });
    assert.equal(warmup.totals.media, 1);
    await waitForIndexSnapshot(indexDir);

    const secondScanner = createScanner();
    const scannerAny = secondScanner as unknown as {
      buildMediaItems: (...args: unknown[]) => Promise<unknown>;
      buildManifestIndexStamp: (...args: unknown[]) => Promise<string>;
      scanFolderEntries: (...args: unknown[]) => Promise<unknown>;
    };
    scannerAny.buildMediaItems = async () => {
      throw new Error("buildMediaItems should not run when manifest index exists");
    };
    scannerAny.buildManifestIndexStamp = async () => {
      throw new Error("buildManifestIndexStamp should not run when manifest index exists");
    };
    const originalScan = scannerAny.scanFolderEntries.bind(secondScanner);
    scannerAny.scanFolderEntries = async (...args: unknown[]) => {
      if (args[1] === "account") {
        throw new Error("scanFolderEntries should not run when manifest index exists");
      }
      return originalScan(...args);
    };

    const restored = await secondScanner.getFolder("account", { mode: "full" });
    assert.equal(restored.totals.media, 1);
    assert.equal(restored.media[0]?.name, "a.jpg");
  });
});

test("persisted manifests refresh modified category media without root rescans", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    const accountDir = path.join(mediaRoot, "account");
    const imagesDir = path.join(accountDir, "images");
    const mediaPath = path.join(imagesDir, "a.jpg");
    await fs.mkdir(imagesDir, { recursive: true });
    await fs.writeFile(mediaPath, "v1");
    const indexDir = indexDirForMediaRoot(mediaRoot);

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

    const firstScanner = createScanner();
    const first = await firstScanner.getFolder("account", { mode: "full" });
    const firstModified = first.media[0]?.modified ?? 0;
    await waitForIndexSnapshot(indexDir);

    const accountBefore = await fs.stat(accountDir);
    const imagesBefore = await fs.stat(imagesDir);

    await sleep(1100);
    await fs.writeFile(mediaPath, "v2");

    const accountAfter = await fs.stat(accountDir);
    const imagesAfter = await fs.stat(imagesDir);
    assert.equal(accountAfter.mtimeMs, accountBefore.mtimeMs);
    assert.equal(imagesAfter.mtimeMs, imagesBefore.mtimeMs);

    const secondScanner = createScanner();
    const scannerAny = secondScanner as unknown as {
      buildManifestIndexStamp: (...args: unknown[]) => Promise<string>;
      scanFolderEntries: (...args: unknown[]) => Promise<unknown>;
    };
    scannerAny.buildManifestIndexStamp = async () => {
      throw new Error("buildManifestIndexStamp should not run for persisted manifest validation");
    };
    const originalScan = scannerAny.scanFolderEntries.bind(secondScanner);
    scannerAny.scanFolderEntries = async (...args: unknown[]) => {
      if (args[1] === "account") {
        throw new Error("scanFolderEntries should not run for persisted manifest validation");
      }
      return originalScan(...args);
    };

    const restored = await secondScanner.getFolder("account", { mode: "full" });
    let refreshed = restored;
    const deadline = Date.now() + 1_000;
    while ((refreshed.media[0]?.modified ?? 0) <= firstModified && Date.now() < deadline) {
      await sleep(25);
      refreshed = await secondScanner.getFolder("account", { mode: "full" });
    }
    assert.ok((refreshed.media[0]?.modified ?? 0) > firstModified);

    firstScanner.close();
    secondScanner.close();
  });
});

test("full snapshots return persisted manifests before background validation completes", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "account", "images"), { recursive: true });
    await fs.writeFile(path.join(mediaRoot, "account", "images", "a.jpg"), "a");
    const indexDir = indexDirForMediaRoot(mediaRoot);

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

    const firstScanner = createScanner();
    const warmup = await firstScanner.getFolder("account", { mode: "full" });
    assert.equal(warmup.totals.media, 1);
    await waitForIndexSnapshot(indexDir);

    const secondScanner = createScanner();
    const scannerAny = secondScanner as unknown as {
      validatePersistedDirectoryManifest: (...args: unknown[]) => Promise<unknown>;
    };
    const originalValidate =
      scannerAny.validatePersistedDirectoryManifest.bind(secondScanner);
    let releaseValidation!: () => void;
    let validationStarted = false;
    const validationGate = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    scannerAny.validatePersistedDirectoryManifest = async (...args: unknown[]) => {
      validationStarted = true;
      await validationGate;
      return originalValidate(...args);
    };

    const restored = await Promise.race([
      secondScanner.getFolder("account", { mode: "full" }),
      sleep(100).then(() => "timeout" as const),
    ]);

    assert.notEqual(restored, "timeout");
    if (restored === "timeout") {
      assert.fail("persisted full restore should not wait for background validation");
    }
    assert.equal(restored.totals.media, 1);
    assert.equal(restored.media[0]?.name, "a.jpg");

    await sleep(10);
    assert.equal(validationStarted, true);
    releaseValidation();
    await sleep(10);
  });
});

test("folder previews derive index stamps from warm directory manifests", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "account", "images"), { recursive: true });
    await fs.writeFile(path.join(mediaRoot, "account", "images", "a.jpg"), "a");

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
      indexDirForMediaRoot(mediaRoot),
      64 * 1024 * 1024
    );

    const full = await scanner.getFolder("account", { mode: "full" });
    assert.equal(full.totals.media, 1);

    const scannerAny = scanner as unknown as {
      buildPreviewIndexStamp: (...args: unknown[]) => Promise<string>;
    };
    scannerAny.buildPreviewIndexStamp = async () => {
      throw new Error("buildPreviewIndexStamp should not run when manifest is warm");
    };

    const previews = await scanner.getFolderPreviews(["account"], 6);
    assert.equal(previews.items.length, 1);
    assert.equal(previews.items[0].previews[0]?.name, "a.jpg");
  });
});

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

test("GET /api/folder paginates within the requested media kind", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    const oldest = path.join(mediaRoot, "a.jpg");
    const olderVideo = path.join(mediaRoot, "b.mp4");
    const newerImage = path.join(mediaRoot, "c.jpg");
    const newestVideo = path.join(mediaRoot, "d.mp4");

    await fs.writeFile(oldest, "a");
    await fs.writeFile(olderVideo, "b");
    await fs.writeFile(newerImage, "c");
    await fs.writeFile(newestVideo, "d");

    const now = Date.now() / 1000;
    await fs.utimes(oldest, now - 400, now - 400);
    await fs.utimes(olderVideo, now - 300, now - 300);
    await fs.utimes(newerImage, now - 200, now - 200);
    await fs.utimes(newestVideo, now - 100, now - 100);

    const app = buildServer(
      baseConfig(mediaRoot, {
        folderPageLimit: 1,
      })
    );

    try {
      const pageOne = await app.inject({
        method: "GET",
        url: "/api/folder?mode=full&kind=video&limit=1",
      });
      assert.equal(pageOne.statusCode, 200);
      const pageOneBody = pageOne.json();
      assert.equal(pageOneBody.totals.media, 4);
      assert.equal(pageOneBody.nextCursor, "1");
      assert.deepEqual(
        pageOneBody.media.map((item: { name: string }) => item.name),
        ["d.mp4"]
      );

      const pageTwo = await app.inject({
        method: "GET",
        url: "/api/folder?mode=full&kind=video&limit=1&cursor=1",
      });
      assert.equal(pageTwo.statusCode, 200);
      const pageTwoBody = pageTwo.json();
      assert.equal(pageTwoBody.totals.media, 4);
      assert.equal(pageTwoBody.nextCursor, undefined);
      assert.deepEqual(
        pageTwoBody.media.map((item: { name: string }) => item.name),
        ["b.mp4"]
      );

      const invalidKind = await app.inject({
        method: "GET",
        url: "/api/folder?mode=full&kind=gif",
      });
      assert.equal(invalidKind.statusCode, 400);
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

      const partial = await app.inject({
        method: "POST",
        url: "/api/folder/previews",
        payload: {
          paths: ["a", "__missing__"],
        },
      });
      assert.equal(partial.statusCode, 200);
      const partialBody = partial.json();
      assert.equal(partialBody.items.length, 1);
      assert.equal(partialBody.items[0].path, "a");
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

test("scanner allows root-internal symlinks and blocks root-external symlinks", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tmv-server-outside-"));

    try {
      await fs.mkdir(path.join(mediaRoot, "albums"), { recursive: true });
      await fs.writeFile(path.join(mediaRoot, "albums", "inside.jpg"), "inside");
      await fs.writeFile(path.join(mediaRoot, "real.jpg"), "real");
      await fs.writeFile(path.join(outsideRoot, "escape.jpg"), "escape");

      await fs.symlink(path.join(mediaRoot, "albums"), path.join(mediaRoot, "alias"));
      await fs.symlink(path.join(mediaRoot, "real.jpg"), path.join(mediaRoot, "linked.jpg"));
      await fs.symlink(path.join(outsideRoot, "escape.jpg"), path.join(mediaRoot, "escape.jpg"));
      await fs.symlink(outsideRoot, path.join(mediaRoot, "escape-dir"));

      const app = buildServer(baseConfig(mediaRoot));

      try {
        const root = await app.inject({
          method: "GET",
          url: "/api/folder?mode=full",
        });
        assert.equal(root.statusCode, 200);
        const rootBody = root.json();
        assert.ok(
          rootBody.subfolders.some((item: { path: string }) => item.path === "alias")
        );
        assert.ok(
          rootBody.media.some((item: { path: string }) => item.path === "linked.jpg")
        );
        assert.ok(
          !rootBody.subfolders.some(
            (item: { path: string }) => item.path === "escape-dir"
          )
        );
        assert.ok(
          !rootBody.media.some((item: { path: string }) => item.path === "escape.jpg")
        );

        const aliasFolder = await app.inject({
          method: "GET",
          url: "/api/folder?path=alias&mode=full",
        });
        assert.equal(aliasFolder.statusCode, 200);
        assert.equal(aliasFolder.json().folder.path, "alias");

        const linkedMedia = await app.inject({
          method: "GET",
          url: "/media/linked.jpg",
        });
        assert.equal(linkedMedia.statusCode, 200);

        const escapedFolder = await app.inject({
          method: "GET",
          url: "/api/folder?path=escape-dir&mode=full",
        });
        assert.equal(escapedFolder.statusCode, 400);

        const escapedMedia = await app.inject({
          method: "GET",
          url: "/media/escape.jpg",
        });
        assert.equal(escapedMedia.statusCode, 404);
      } finally {
        await app.close();
      }
    } finally {
      await fs.rm(outsideRoot, { recursive: true, force: true });
    }
  });
});

testWithFfmpeg("GET /thumb generates cached thumbnails for video and image files", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    const videoPath = path.join(mediaRoot, "clip.mp4");
    await createTestVideo(videoPath);
    await createTestImage(path.join(mediaRoot, "still.jpg"));
    await fs.symlink(videoPath, path.join(mediaRoot, "linked-clip.mp4"));

    const app = buildServer(baseConfig(mediaRoot));

    try {
      const first = await app.inject({
        method: "GET",
        url: "/thumb/clip.mp4",
      });
      assert.equal(first.statusCode, 200);
      assert.equal(first.headers["content-type"], "image/jpeg");
      assert.ok(first.rawPayload.length > 0);

      const thumbFiles = await fs.readdir(path.join(mediaRoot, ".thumbs"));
      assert.ok(thumbFiles.some((name) => name.endsWith(".jpg")));
      assert.ok(thumbFiles.some((name) => name.endsWith(".json")));

      const second = await app.inject({
        method: "GET",
        url: "/thumb/clip.mp4",
      });
      assert.equal(second.statusCode, 200);
      assert.equal(second.rawPayload.length, first.rawPayload.length);

      const linked = await app.inject({
        method: "GET",
        url: "/thumb/linked-clip.mp4",
      });
      assert.equal(linked.statusCode, 200);
      assert.ok(linked.rawPayload.length > 0);

      const still = await app.inject({
        method: "GET",
        url: "/thumb/still.jpg",
      });
      assert.equal(still.statusCode, 200);
      assert.equal(still.headers["content-type"], "image/jpeg");
      assert.ok(still.rawPayload.length > 0);
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
      indexDirForMediaRoot(mediaRoot),
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

test("full snapshots refresh when nested media changes without parent directory mtime changes", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "alpha"), { recursive: true });
    const nestedMedia = path.join(mediaRoot, "alpha", "a.jpg");
    await fs.writeFile(nestedMedia, "v1");

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
      true,
      indexDirForMediaRoot(mediaRoot),
      64 * 1024 * 1024
    );

    const first = await scanner.getFolder("", { mode: "full" });
    const before = first.subfolders.find((item) => item.path === "alpha")?.modified ?? 0;

    await sleep(1100);
    await fs.writeFile(nestedMedia, "v2");
    await waitForWatchEvents();

    const second = await scanner.getFolder("", { mode: "full" });
    const after = second.subfolders.find((item) => item.path === "alpha")?.modified ?? 0;

    assert.ok(before > 0);
    assert.ok(after > before);
  });
});

test("full snapshots reuse watcher-backed cache and invalidate on nested changes", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "account", "images"), { recursive: true });
    const mediaPath = path.join(mediaRoot, "account", "images", "a.jpg");
    await fs.writeFile(mediaPath, "v1");

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
      indexDirForMediaRoot(mediaRoot),
      64 * 1024 * 1024
    );

    try {
      const first = await scanner.getFolder("account", { mode: "full" });
      assert.equal(first.totals.media, 1);

      const scannerAny = scanner as unknown as {
        buildFullFolderSnapshot: (...args: unknown[]) => Promise<FolderSnapshot>;
        buildMediaItems: (...args: unknown[]) => Promise<unknown>;
      };
      const original = scannerAny.buildFullFolderSnapshot.bind(scanner);

      scannerAny.buildFullFolderSnapshot = async () => {
        throw new Error("buildFullFolderSnapshot should not run when full cache is warm");
      };
      const cached = await scanner.getFolder("account", { mode: "full" });
      assert.equal(cached.totals.media, 1);

      await sleep(1100);
      await fs.writeFile(mediaPath, "v2");
      await waitForWatchEvents();

      let rebuilds = 0;
      scannerAny.buildMediaItems = async () => {
        throw new Error("buildMediaItems should not run when watch preheats manifest");
      };
      scannerAny.buildFullFolderSnapshot = async (...args: unknown[]) => {
        rebuilds += 1;
        return original(...args);
      };

      const refreshed = await scanner.getFolder("account", { mode: "full" });
      assert.equal(rebuilds, 1);
      assert.ok((refreshed.media[0]?.modified ?? 0) > (first.media[0]?.modified ?? 0));
    } finally {
      scanner.close();
    }
  });
});

test("watch-driven manifest updates persist across scanner instances", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "account", "images"), { recursive: true });
    const mediaPath = path.join(mediaRoot, "account", "images", "a.jpg");
    await fs.writeFile(mediaPath, "v1");
    const indexDir = indexDirForMediaRoot(mediaRoot);

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

    const firstScanner = createScanner();
    const first = await firstScanner.getFolder("account", { mode: "full" });
    const firstModified = first.media[0]?.modified ?? 0;
    await waitForIndexSnapshot(indexDir);

    await sleep(1100);
    await fs.writeFile(mediaPath, "v2");
    await waitForWatchEvents();
    await sleep(150);

    const secondScanner = createScanner();
    const scannerAny = secondScanner as unknown as {
      buildMediaItems: (...args: unknown[]) => Promise<unknown>;
    };
    scannerAny.buildMediaItems = async () => {
      throw new Error("buildMediaItems should not run when watch-updated manifest index exists");
    };

    const restored = await secondScanner.getFolder("account", { mode: "full" });
    assert.ok((restored.media[0]?.modified ?? 0) > firstModified);

    firstScanner.close();
    secondScanner.close();
  });
});

test("watch-driven subfolder additions persist root manifests across scanner instances", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "account"), { recursive: true });
    const indexDir = indexDirForMediaRoot(mediaRoot);

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

    const firstScanner = createScanner();
    const warm = await firstScanner.getFolder("account", { mode: "full" });
    assert.equal(warm.subfolders.length, 0);
    await waitForIndexSnapshot(indexDir);

    await fs.mkdir(path.join(mediaRoot, "account", "alpha"), { recursive: true });
    await waitForWatchEvents();
    await sleep(150);

    const secondScanner = createScanner();
    const scannerAny = secondScanner as unknown as {
      scanFolderEntries: (...args: unknown[]) => Promise<unknown>;
    };
    const original = scannerAny.scanFolderEntries.bind(secondScanner);
    scannerAny.scanFolderEntries = async (...args: unknown[]) => {
      if (args[1] === "account") {
        throw new Error("scanFolderEntries should not run for root manifest restore");
      }
      return original(...args);
    };

    const restored = await secondScanner.getFolder("account", { mode: "full" });
    assert.equal(restored.subfolders.length, 1);
    assert.equal(restored.subfolders[0]?.path, "account/alpha");

    firstScanner.close();
    secondScanner.close();
  });
});

test("watch-driven category directory renames persist flattened media across scanner instances", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "account", "stash"), { recursive: true });
    await fs.writeFile(path.join(mediaRoot, "account", "stash", "a.jpg"), "a");
    const indexDir = indexDirForMediaRoot(mediaRoot);

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

    const firstScanner = createScanner();
    const warm = await firstScanner.getFolder("account", { mode: "full" });
    assert.equal(warm.totals.media, 0);
    assert.equal(warm.subfolders[0]?.path, "account/stash");
    await waitForIndexSnapshot(indexDir);

    await fs.rename(
      path.join(mediaRoot, "account", "stash"),
      path.join(mediaRoot, "account", "images")
    );
    await waitForWatchEvents();
    await sleep(150);

    const secondScanner = createScanner();
    const scannerAny = secondScanner as unknown as {
      scanFolderEntries: (...args: unknown[]) => Promise<unknown>;
      buildMediaItems: (...args: unknown[]) => Promise<unknown>;
    };
    const originalScan = scannerAny.scanFolderEntries.bind(secondScanner);
    scannerAny.scanFolderEntries = async (...args: unknown[]) => {
      if (args[1] === "account") {
        throw new Error("scanFolderEntries should not run for renamed category restore");
      }
      return originalScan(...args);
    };
    scannerAny.buildMediaItems = async () => {
      throw new Error("buildMediaItems should not run when renamed category manifest index exists");
    };

    const restored = await secondScanner.getFolder("account", { mode: "full" });
    assert.equal(restored.subfolders.length, 0);
    assert.equal(restored.totals.media, 1);
    assert.equal(restored.media[0]?.path, "account/images/a.jpg");

    firstScanner.close();
    secondScanner.close();
  });
});

test("missing watcher filenames trigger manifest rebuild fallback", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "account", "images"), { recursive: true });
    const mediaPath = path.join(mediaRoot, "account", "images", "a.jpg");
    await fs.writeFile(mediaPath, "v1");
    const indexDir = indexDirForMediaRoot(mediaRoot);

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

    const firstScanner = createScanner();
    await firstScanner.getFolder("account", { mode: "full" });
    await waitForIndexSnapshot(indexDir);

    const scannerAny = firstScanner as unknown as {
      watchedDirs: Map<string, { close: () => void }>;
      handleWatchedDirectoryEvent: (
        watchedRelativePath: string,
        filename?: string | Buffer | null
      ) => Promise<void>;
    };
    for (const watcher of scannerAny.watchedDirs.values()) {
      watcher.close();
    }
    scannerAny.watchedDirs.clear();

    await sleep(1100);
    await fs.writeFile(path.join(mediaRoot, "account", "images", "b.jpg"), "v2");
    await scannerAny.handleWatchedDirectoryEvent("account/images", undefined);

    const secondScanner = createScanner();
    const secondAny = secondScanner as unknown as {
      scanFolderEntries: (...args: unknown[]) => Promise<unknown>;
    };
    const originalScan = secondAny.scanFolderEntries.bind(secondScanner);
    secondAny.scanFolderEntries = async (...args: unknown[]) => {
      if (args[1] === "account") {
        throw new Error("scanFolderEntries should not run after missing-filename fallback");
      }
      return originalScan(...args);
    };

    const restored = await secondScanner.getFolder("account", { mode: "full" });
    assert.equal(restored.totals.media, 2);
    assert.deepEqual(
      restored.media.map((item) => item.path).sort(),
      ["account/images/a.jpg", "account/images/b.jpg"]
    );

    firstScanner.close();
    secondScanner.close();
  });
});

test("batched watcher updates coalesce into one persisted root manifest", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "account"), { recursive: true });
    const indexDir = indexDirForMediaRoot(mediaRoot);

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

    const firstScanner = createScanner();
    await firstScanner.getFolder("account", { mode: "full" });
    await waitForIndexSnapshot(indexDir);

    const scannerAny = firstScanner as unknown as {
      watchedDirs: Map<string, { close: () => void }>;
      handleWatchedDirectoryEvent: (
        watchedRelativePath: string,
        filename?: string | Buffer | null
      ) => Promise<void>;
    };
    for (const watcher of scannerAny.watchedDirs.values()) {
      watcher.close();
    }
    scannerAny.watchedDirs.clear();

    await fs.writeFile(path.join(mediaRoot, "account", "cover.jpg"), "cover");
    await fs.mkdir(path.join(mediaRoot, "account", "alpha"), { recursive: true });

    await Promise.all([
      scannerAny.handleWatchedDirectoryEvent("account", "cover.jpg"),
      scannerAny.handleWatchedDirectoryEvent("account", "alpha"),
    ]);

    const secondScanner = createScanner();
    const secondAny = secondScanner as unknown as {
      scanFolderEntries: (...args: unknown[]) => Promise<unknown>;
    };
    const originalScan = secondAny.scanFolderEntries.bind(secondScanner);
    secondAny.scanFolderEntries = async (...args: unknown[]) => {
      if (args[1] === "account") {
        throw new Error("scanFolderEntries should not run after batched watcher updates");
      }
      return originalScan(...args);
    };

    const restored = await secondScanner.getFolder("account", { mode: "full" });
    assert.equal(restored.totals.media, 1);
    assert.equal(restored.media[0]?.path, "account/cover.jpg");
    assert.equal(restored.subfolders.length, 1);
    assert.equal(restored.subfolders[0]?.path, "account/alpha");

    firstScanner.close();
    secondScanner.close();
  });
});

test("full mode paginates complete sorted media beyond maxItemsPerFolder", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "images"), { recursive: true });

    const oldest = path.join(mediaRoot, "a.jpg");
    const middle = path.join(mediaRoot, "b.jpg");
    const newest = path.join(mediaRoot, "images", "c.jpg");
    const latest = path.join(mediaRoot, "images", "d.jpg");

    await fs.writeFile(oldest, "a");
    await fs.writeFile(middle, "b");
    await fs.writeFile(newest, "c");
    await fs.writeFile(latest, "d");

    const now = Date.now() / 1000;
    await fs.utimes(oldest, now - 400, now - 400);
    await fs.utimes(middle, now - 300, now - 300);
    await fs.utimes(newest, now - 200, now - 200);
    await fs.utimes(latest, now - 100, now - 100);

    const app = buildServer(
      baseConfig(mediaRoot, {
        folderPageLimit: 2,
        maxItemsPerFolder: 2,
      })
    );

    try {
      const pageOne = await app.inject({
        method: "GET",
        url: "/api/folder?mode=full&limit=2",
      });
      assert.equal(pageOne.statusCode, 200);
      const pageOneBody = pageOne.json();
      assert.equal(pageOneBody.totals.media, 4);
      assert.equal(pageOneBody.nextCursor, "2");
      assert.deepEqual(
        pageOneBody.media.map((item: { name: string }) => item.name),
        ["d.jpg", "c.jpg"]
      );

      const pageTwo = await app.inject({
        method: "GET",
        url: "/api/folder?mode=full&limit=2&cursor=2",
      });
      assert.equal(pageTwo.statusCode, 200);
      const pageTwoBody = pageTwo.json();
      assert.equal(pageTwoBody.totals.media, 4);
      assert.equal(pageTwoBody.nextCursor, undefined);
      assert.deepEqual(
        pageTwoBody.media.map((item: { name: string }) => item.name),
        ["b.jpg", "a.jpg"]
      );
    } finally {
      await app.close();
    }
  });
});

test("preview batches still cap preview items while preserving full counts", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "alpha"), { recursive: true });

    const oldest = path.join(mediaRoot, "alpha", "a.jpg");
    const middle = path.join(mediaRoot, "alpha", "b.jpg");
    const newest = path.join(mediaRoot, "alpha", "c.jpg");

    await fs.writeFile(oldest, "a");
    await fs.writeFile(middle, "b");
    await fs.writeFile(newest, "c");

    const now = Date.now() / 1000;
    await fs.utimes(oldest, now - 300, now - 300);
    await fs.utimes(middle, now - 200, now - 200);
    await fs.utimes(newest, now - 100, now - 100);

    const scanner = new MediaScanner(
      mediaRoot,
      6,
      2,
      240,
      1000,
      8,
      60_000,
      256,
      200 * 1024 * 1024,
      false,
      indexDirForMediaRoot(mediaRoot),
      64 * 1024 * 1024
    );

    const result = await scanner.getFolderPreviews(["alpha"], 6);
    assert.equal(result.items.length, 1);
    assert.deepEqual(
      result.items[0].previews.map((item) => item.name),
      ["c.jpg", "b.jpg"]
    );
    assert.deepEqual(result.items[0].counts, {
      images: 3,
      gifs: 0,
      videos: 0,
      subfolders: 0,
    });
  });
});

test("category directories only flatten top-level media in full mode and previews", async () => {
  await withTempMediaRoot(async (mediaRoot) => {
    await fs.mkdir(path.join(mediaRoot, "account", "images", "nested"), {
      recursive: true,
    });
    await fs.mkdir(path.join(mediaRoot, "account", "videos", "deep"), {
      recursive: true,
    });

    await fs.writeFile(path.join(mediaRoot, "account", "images", "top.jpg"), "top");
    await fs.writeFile(
      path.join(mediaRoot, "account", "images", "nested", "deep.jpg"),
      "deep"
    );
    await fs.writeFile(path.join(mediaRoot, "account", "videos", "clip.mp4"), "clip");
    await fs.writeFile(
      path.join(mediaRoot, "account", "videos", "deep", "skip.mp4"),
      "skip"
    );

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
      indexDirForMediaRoot(mediaRoot),
      64 * 1024 * 1024
    );

    const full = await scanner.getFolder("account", { mode: "full" });
    assert.equal(full.totals.media, 2);
    assert.deepEqual(
      full.media.map((item) => item.name).sort(),
      ["clip.mp4", "top.jpg"]
    );

    const previews = await scanner.getFolderPreviews(["account"], 6);
    assert.equal(previews.items.length, 1);
    assert.deepEqual(previews.items[0].counts, {
      images: 1,
      gifs: 0,
      videos: 1,
      subfolders: 0,
    });
    assert.deepEqual(
      previews.items[0].previews.map((item) => item.name).sort(),
      ["clip.mp4", "top.jpg"]
    );
  });
});
