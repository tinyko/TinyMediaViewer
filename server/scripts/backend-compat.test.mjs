import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pickFreePort, startBackend, stopBackend } from "./backend-runner.mjs";

const execFileAsync = promisify(execFile);
const ffmpegBin = process.env.FFMPEG_BIN?.trim() || "ffmpeg";
const hasFfmpeg = spawnSync(ffmpegBin, ["-version"], { stdio: "ignore" }).status === 0;
const BACKENDS = (process.env.TMV_COMPAT_BACKENDS ?? "node,rust")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const rmWithRetries = async (targetPath) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error?.code;
      if (code !== "ENOTEMPTY" && code !== "EBUSY" && code !== "EPERM") {
        throw error;
      }
      await sleep(25);
    }
  }
  await fs.rm(targetPath, { recursive: true, force: true });
};

const withTempMediaRoot = async (run) => {
  const mediaRoot = await fs.mkdtemp(path.join(os.tmpdir(), "tmv-backend-compat-"));
  try {
    return await run(mediaRoot);
  } finally {
    await rmWithRetries(mediaRoot);
  }
};

const withBackend = async (backend, mediaRoot, extraEnv, run) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), `tmv-backend-runtime-${backend}-`));
  const port = await pickFreePort();
  try {
    const handle = await startBackend({
      backend,
      mediaRoot,
      port,
      indexDir: path.join(runtimeRoot, "index"),
      thumbnailDir: path.join(runtimeRoot, "thumb"),
      diagnosticsDir: path.join(runtimeRoot, "diag"),
      extraEnv,
    });

    try {
      return await run(handle.baseUrl);
    } finally {
      await stopBackend(handle.child);
    }
  } finally {
    await rmWithRetries(runtimeRoot);
  }
};

const requestJson = async (baseUrl, targetPath, init = {}) => {
  const response = await fetch(`${baseUrl}${targetPath}`, init);
  const text = await response.text();
  const json = text ? JSON.parse(text) : null;
  return { response, json };
};

const createTestVideo = async (outputPath) => {
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

const createTestImage = async (outputPath) => {
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

const backendCompatEnv = (pairs) =>
  Object.fromEntries(
    pairs.flatMap(([legacyKey, legacyValue, tmvKey = `TMV_${legacyKey}`]) => [
      [legacyKey, legacyValue],
      [tmvKey, legacyValue],
    ])
  );

for (const backend of BACKENDS) {
  test(`${backend}: /api/folder paginates with nextCursor`, async () => {
    await withTempMediaRoot(async (mediaRoot) => {
      await fs.writeFile(path.join(mediaRoot, "a.jpg"), "a");
      await fs.writeFile(path.join(mediaRoot, "b.png"), "b");
      await fs.writeFile(path.join(mediaRoot, "c.mp4"), "c");

      await withBackend(
        backend,
        mediaRoot,
        backendCompatEnv([
          ["FOLDER_PAGE_LIMIT", "2"],
          ["MAX_FOLDER_PAGE_LIMIT", "1000"],
        ]),
        async (baseUrl) => {
          const pageOne = await requestJson(baseUrl, "/api/folder?limit=2");
          assert.equal(pageOne.response.status, 200);
          assert.equal(pageOne.json.media.length, 2);
          assert.equal(pageOne.json.totals.media, 3);
          assert.equal(pageOne.json.nextCursor, "2");

          const pageTwo = await requestJson(baseUrl, "/api/folder?limit=2&cursor=2");
          assert.equal(pageTwo.response.status, 200);
          assert.equal(pageTwo.json.media.length, 1);
          assert.equal(pageTwo.json.nextCursor, undefined);
        }
      );
    });
  });

  test(`${backend}: /api/folder paginates within kind filter`, async () => {
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

      await withBackend(
        backend,
        mediaRoot,
        backendCompatEnv([
          ["FOLDER_PAGE_LIMIT", "1"],
          ["MAX_FOLDER_PAGE_LIMIT", "1000"],
        ]),
        async (baseUrl) => {
          const pageOne = await requestJson(baseUrl, "/api/folder?mode=full&kind=video&limit=1");
          assert.equal(pageOne.response.status, 200);
          assert.equal(pageOne.json.totals.media, 4);
          assert.equal(pageOne.json.nextCursor, "1");
          assert.deepEqual(
            pageOne.json.media.map((item) => item.name),
            ["d.mp4"]
          );

          const pageTwo = await requestJson(
            baseUrl,
            "/api/folder?mode=full&kind=video&limit=1&cursor=1"
          );
          assert.equal(pageTwo.response.status, 200);
          assert.equal(pageTwo.json.nextCursor, undefined);
          assert.deepEqual(
            pageTwo.json.media.map((item) => item.name),
            ["b.mp4"]
          );

          const invalidKind = await requestJson(baseUrl, "/api/folder?mode=full&kind=gif");
          assert.equal(invalidKind.response.status, 400);
          assert.match(invalidKind.json.error, /image or video/i);
        }
      );
    });
  });

  test(`${backend}: light root mode stays shallow and validates mode`, async () => {
    await withTempMediaRoot(async (mediaRoot) => {
      await fs.mkdir(path.join(mediaRoot, "alpha"), { recursive: true });
      await fs.writeFile(path.join(mediaRoot, "alpha", "1.jpg"), "1");
      await fs.writeFile(path.join(mediaRoot, "alpha", "2.gif"), "2");

      await withBackend(backend, mediaRoot, {}, async (baseUrl) => {
        const light = await requestJson(baseUrl, "/api/folder?mode=light");
        assert.equal(light.response.status, 200);
        const lightPreview = light.json.subfolders.find((entry) => entry.path === "alpha");
        assert.ok(lightPreview);
        assert.equal(lightPreview.countsReady, false);
        assert.equal(lightPreview.previewReady, false);
        assert.equal(lightPreview.approximate, true);

        const full = await requestJson(baseUrl, "/api/folder?mode=full");
        assert.equal(full.response.status, 200);
        const fullPreview = full.json.subfolders.find((entry) => entry.path === "alpha");
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

        const invalidMode = await requestJson(baseUrl, "/api/folder?mode=invalid");
        assert.equal(invalidMode.response.status, 400);
      });
    });
  });

  test(`${backend}: preview batch validates payload and returns partial success`, async () => {
    await withTempMediaRoot(async (mediaRoot) => {
      await fs.mkdir(path.join(mediaRoot, "a"), { recursive: true });
      await fs.mkdir(path.join(mediaRoot, "b"), { recursive: true });
      await fs.writeFile(path.join(mediaRoot, "a", "1.jpg"), "1");
      await fs.writeFile(path.join(mediaRoot, "a", "2.mp4"), "2");
      await fs.writeFile(path.join(mediaRoot, "b", "1.gif"), "1");

      await withBackend(
        backend,
        mediaRoot,
        backendCompatEnv([["PREVIEW_BATCH_LIMIT", "2"]]),
        async (baseUrl) => {
          const ok = await requestJson(baseUrl, "/api/folder/previews", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              paths: ["a", "b"],
              limitPerFolder: 3,
            }),
          });
          assert.equal(ok.response.status, 200);
          assert.equal(ok.json.items.length, 2);
          const itemA = ok.json.items.find((entry) => entry.path === "a");
          const itemB = ok.json.items.find((entry) => entry.path === "b");
          assert.equal(itemA.counts.images, 1);
          assert.equal(itemA.counts.videos, 1);
          assert.equal(itemB.counts.gifs, 1);

          const overLimit = await requestJson(baseUrl, "/api/folder/previews", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paths: ["a", "b", "c"] }),
          });
          assert.equal(overLimit.response.status, 400);

          const invalid = await requestJson(baseUrl, "/api/folder/previews", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paths: ["a", 123] }),
          });
          assert.equal(invalid.response.status, 400);

          const empty = await requestJson(baseUrl, "/api/folder/previews", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paths: [] }),
          });
          assert.equal(empty.response.status, 200);
          assert.deepEqual(empty.json, { items: [] });

          const partial = await requestJson(baseUrl, "/api/folder/previews", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ paths: ["a", "__missing__"] }),
          });
          assert.equal(partial.response.status, 200);
          assert.equal(partial.json.items.length, 1);
          assert.equal(partial.json.items[0].path, "a");
        }
      );
    });
  });

  test(`${backend}: path traversal, non-media, and range semantics are enforced`, async () => {
    await withTempMediaRoot(async (mediaRoot) => {
      await fs.writeFile(path.join(mediaRoot, "safe.jpg"), "abcdef");
      await fs.writeFile(path.join(mediaRoot, "note.txt"), "note");

      await withBackend(backend, mediaRoot, {}, async (baseUrl) => {
        const folderTraversal = await requestJson(baseUrl, "/api/folder?path=../../etc");
        assert.equal(folderTraversal.response.status, 400);

        const mediaTraversal = await requestJson(baseUrl, "/media/..%2F..%2Fetc%2Fpasswd");
        assert.equal(mediaTraversal.response.status, 404);

        const nonMedia = await requestJson(baseUrl, "/media/note.txt");
        assert.equal(nonMedia.response.status, 403);

        const ranged = await fetch(`${baseUrl}/media/safe.jpg`, {
          headers: {
            Range: "bytes=1-3",
          },
        });
        assert.equal(ranged.status, 206);
        assert.equal(ranged.headers.get("accept-ranges"), "bytes");
        assert.equal(ranged.headers.get("content-range"), "bytes 1-3/6");
        assert.equal(ranged.headers.get("cache-control"), "public, max-age=86400");
        const rangedBody = Buffer.from(await ranged.arrayBuffer()).toString("utf8");
        assert.equal(rangedBody, "bcd");
      });
    });
  });

  test(`${backend}: root-internal symlinks are allowed and root-external symlinks are blocked`, async () => {
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

        await withBackend(backend, mediaRoot, {}, async (baseUrl) => {
          const root = await requestJson(baseUrl, "/api/folder?mode=full");
          assert.equal(root.response.status, 200);
          assert.ok(root.json.subfolders.some((item) => item.path === "alias"));
          assert.ok(root.json.media.some((item) => item.path === "linked.jpg"));
          assert.ok(!root.json.subfolders.some((item) => item.path === "escape-dir"));
          assert.ok(!root.json.media.some((item) => item.path === "escape.jpg"));

          const aliasFolder = await requestJson(baseUrl, "/api/folder?path=alias&mode=full");
          assert.equal(aliasFolder.response.status, 200);
          assert.equal(aliasFolder.json.folder.path, "alias");

          const linkedMedia = await fetch(`${baseUrl}/media/linked.jpg`);
          assert.equal(linkedMedia.status, 200);

          const escapedFolder = await requestJson(baseUrl, "/api/folder?path=escape-dir&mode=full");
          assert.equal(escapedFolder.response.status, 400);

          const escapedMedia = await requestJson(baseUrl, "/media/escape.jpg");
          assert.equal(escapedMedia.response.status, 404);
        });
      } finally {
        await rmWithRetries(outsideRoot);
      }
    });
  });

  test(`${backend}: legacy standalone origin whitelist is enforced`, async () => {
    await withTempMediaRoot(async (mediaRoot) => {
      await fs.writeFile(path.join(mediaRoot, "safe.jpg"), "safe");

      await withBackend(
        backend,
        mediaRoot,
        backendCompatEnv([
          ["REQUIRE_LAN_TOKEN", "true"],
          ["MEDIA_ACCESS_TOKEN", "secret-token"],
          ["CORS_ALLOWED_ORIGINS", "http://127.0.0.1:4300"],
        ]),
        async (baseUrl) => {
          const blockedOrigin = await requestJson(baseUrl, "/api/folder", {
            headers: {
              origin: "http://evil.example.com",
            },
          });
          assert.equal(blockedOrigin.response.status, 403);

          const allowedOrigin = await requestJson(baseUrl, "/api/folder", {
            headers: {
              origin: "http://127.0.0.1:4300",
            },
          });
          assert.equal(allowedOrigin.response.status, 200);
        }
      );
    });
  });

  if (hasFfmpeg) {
    test(`${backend}: /thumb generates cached thumbnails for video and image files`, async () => {
      await withTempMediaRoot(async (mediaRoot) => {
        const videoPath = path.join(mediaRoot, "clip.mp4");
        await createTestVideo(videoPath);
        await createTestImage(path.join(mediaRoot, "still.jpg"));
        await fs.symlink(videoPath, path.join(mediaRoot, "linked-clip.mp4"));

        await withBackend(backend, mediaRoot, {}, async (baseUrl) => {
          const first = await fetch(`${baseUrl}/thumb/clip.mp4`);
          assert.equal(first.status, 200);
          assert.equal(first.headers.get("content-type"), "image/jpeg");
          assert.ok((await first.arrayBuffer()).byteLength > 0);

          const second = await fetch(`${baseUrl}/thumb/clip.mp4`);
          assert.equal(second.status, 200);
          assert.ok((await second.arrayBuffer()).byteLength > 0);

          const linked = await fetch(`${baseUrl}/thumb/linked-clip.mp4`);
          assert.equal(linked.status, 200);
          assert.ok((await linked.arrayBuffer()).byteLength > 0);

          const still = await fetch(`${baseUrl}/thumb/still.jpg`);
          assert.equal(still.status, 200);
          assert.equal(still.headers.get("content-type"), "image/jpeg");
          assert.ok((await still.arrayBuffer()).byteLength > 0);
        });
      });
    });
  }
}
