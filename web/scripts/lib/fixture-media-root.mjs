import fs from "node:fs/promises";
import path from "node:path";
import { repoRoot, ensureDir, ensureEmptyDir } from "./tmv-stack.mjs";

const demoImagePath = path.join(repoRoot, "demo.png");
const demoVideoPath = path.join(repoRoot, "demo.mp4");

async function materializeAsset(source, target, strategy) {
  await ensureDir(path.dirname(target));
  if (strategy === "hardlink") {
    try {
      await fs.link(source, target);
      return;
    } catch {
      // Cross-device hardlinks or existing files fall back to copies.
    }
  }
  await fs.copyFile(source, target);
}

async function touchFile(target, epochMs) {
  const seconds = epochMs / 1_000;
  await fs.utimes(target, seconds, seconds);
}

export async function createE2EMediaRoot(targetDir) {
  await ensureEmptyDir(targetDir);

  const accounts = [
    {
      path: "alpha-lounge",
      images: ["IMG_20260307_000001.png", "IMG_20260306_000001.png"],
      videos: ["VID_20260307_000001.mp4"],
    },
    {
      path: "beta-station",
      images: ["IMG_20260305_000001.png"],
      videos: ["VID_20260308_000001.mp4", "VID_20260304_000001.mp4"],
    },
    {
      path: "gamma-lab",
      images: ["IMG_20260303_000001.png"],
      videos: [],
    },
  ];

  let offset = 0;
  for (const account of accounts) {
    const imageDir = path.join(targetDir, account.path, "images");
    const videoDir = path.join(targetDir, account.path, "videos");
    await ensureDir(imageDir);
    await ensureDir(videoDir);

    for (const imageName of account.images) {
      const target = path.join(imageDir, imageName);
      await materializeAsset(demoImagePath, target, "copy");
      await touchFile(target, Date.UTC(2026, 2, 9, 10, 0, offset));
      offset += 1;
    }

    for (const videoName of account.videos) {
      const target = path.join(videoDir, videoName);
      await materializeAsset(demoVideoPath, target, "copy");
      await touchFile(target, Date.UTC(2026, 2, 9, 11, 0, offset));
      offset += 1;
    }
  }

  return {
    rootDir: targetDir,
    accounts,
  };
}

export async function createBenchmarkMediaRoot(targetDir, options = {}) {
  const {
    accountCount = 12,
    imagesPerAccount = 24,
    videosPerAccount = 6,
    strategy = "hardlink",
  } = options;

  await ensureEmptyDir(targetDir);
  const accounts = [];

  for (let accountIndex = 0; accountIndex < accountCount; accountIndex += 1) {
    const accountPath = `bench-account-${String(accountIndex + 1).padStart(3, "0")}`;
    const imageDir = path.join(targetDir, accountPath, "images");
    const videoDir = path.join(targetDir, accountPath, "videos");
    await ensureDir(imageDir);
    await ensureDir(videoDir);

    for (let imageIndex = 0; imageIndex < imagesPerAccount; imageIndex += 1) {
      const name = `IMG_20260309_${String(accountIndex + 1).padStart(3, "0")}${String(
        imageIndex + 1
      ).padStart(4, "0")}.png`;
      await materializeAsset(demoImagePath, path.join(imageDir, name), strategy);
    }

    for (let videoIndex = 0; videoIndex < videosPerAccount; videoIndex += 1) {
      const name = `VID_20260309_${String(accountIndex + 1).padStart(3, "0")}${String(
        videoIndex + 1
      ).padStart(4, "0")}.mp4`;
      await materializeAsset(demoVideoPath, path.join(videoDir, name), strategy);
    }

    accounts.push(accountPath);
  }

  return {
    rootDir: targetDir,
    accounts,
    accountCount,
    imagesPerAccount,
    videosPerAccount,
    strategy,
    totalFiles: accountCount * (imagesPerAccount + videosPerAccount),
  };
}
