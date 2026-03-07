#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pickFreePort, startBackend, stopBackend } from "./backend-runner.mjs";

const TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "tmv-contract-"));
const FIXTURE_ROOT = path.join(TMP_ROOT, "media-root");
const JPG_BASE64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxAQEBAQEA8PDw8PDw8PDw8PDw8PDw8QFREWFhURFRUYHSggGBolHRUVITEhJSkrLi4uFx8zODMsNygtLisBCgoKDg0OGxAQGy8lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAAEAAQMBIgACEQEDEQH/xAAXAAEBAQEAAAAAAAAAAAAAAAAAAQID/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEAMQAAAB9hAAAAAAAAAB/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAEP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAEP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAEP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAEP/aAAgBAQABPyF//9k=";

const writeFile = async (relativePath, buffer) => {
  const fullPath = path.join(FIXTURE_ROOT, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, buffer);
};

const encodePath = (value) =>
  value
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");

const fetchJson = async (baseUrl, pathname, init = undefined) => {
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    json: text ? JSON.parse(text) : null,
  };
};

const compareJsonEndpoint = async (nodeUrl, rustUrl, pathname, init = undefined) => {
  const [nodeResult, rustResult] = await Promise.all([
    fetchJson(nodeUrl, pathname, init),
    fetchJson(rustUrl, pathname, init),
  ]);
  assert.equal(rustResult.status, nodeResult.status, `status mismatch for ${pathname}`);
  assert.deepEqual(rustResult.json, nodeResult.json, `json mismatch for ${pathname}`);
};

const compareMediaEndpoint = async (nodeUrl, rustUrl, pathname, init = undefined) => {
  const [nodeResponse, rustResponse] = await Promise.all([
    fetch(`${nodeUrl}${pathname}`, init),
    fetch(`${rustUrl}${pathname}`, init),
  ]);
  assert.equal(rustResponse.status, nodeResponse.status, `status mismatch for ${pathname}`);
  for (const headerName of [
    "content-type",
    "cache-control",
    "accept-ranges",
    "content-range",
  ]) {
    assert.equal(
      rustResponse.headers.get(headerName),
      nodeResponse.headers.get(headerName),
      `header mismatch for ${pathname}: ${headerName}`
    );
  }
};

const compareStatusEndpoint = async (nodeUrl, rustUrl, pathname, init = undefined) => {
  const [nodeResponse, rustResponse] = await Promise.all([
    fetch(`${nodeUrl}${pathname}`, init),
    fetch(`${rustUrl}${pathname}`, init),
  ]);
  assert.equal(rustResponse.status, nodeResponse.status, `status mismatch for ${pathname}`);
  assert.equal(
    rustResponse.headers.get("content-type"),
    nodeResponse.headers.get("content-type"),
    `content-type mismatch for ${pathname}`
  );
};

await fs.mkdir(FIXTURE_ROOT, { recursive: true });
await writeFile("alpha/images/a.jpg", Buffer.from(JPG_BASE64, "base64"));
await writeFile("alpha/videos/b.mp4", Buffer.from("not-a-real-video"));
await writeFile("beta/1.gif", Buffer.from("GIF89a"));
await writeFile("secret.txt", Buffer.from("secret"));

const nodePort = await pickFreePort();
const rustPort = await pickFreePort();
const nodeHandle = await startBackend({
  backend: "node",
  mediaRoot: FIXTURE_ROOT,
  port: nodePort,
  indexDir: path.join(TMP_ROOT, "node-index"),
  thumbnailDir: path.join(TMP_ROOT, "node-thumbs"),
  diagnosticsDir: path.join(TMP_ROOT, "node-diag"),
});
const rustHandle = await startBackend({
  backend: "rust",
  mediaRoot: FIXTURE_ROOT,
  port: rustPort,
  indexDir: path.join(TMP_ROOT, "rust-index"),
  thumbnailDir: path.join(TMP_ROOT, "rust-thumbs"),
  diagnosticsDir: path.join(TMP_ROOT, "rust-diag"),
});

try {
  await compareJsonEndpoint(nodeHandle.baseUrl, rustHandle.baseUrl, "/api/folder?mode=light");
  await compareJsonEndpoint(
    nodeHandle.baseUrl,
    rustHandle.baseUrl,
    "/api/folder?path=alpha&mode=full"
  );
  await compareJsonEndpoint(
    nodeHandle.baseUrl,
    rustHandle.baseUrl,
    "/api/folder?path=alpha&mode=full&kind=image"
  );
  await compareJsonEndpoint(
    nodeHandle.baseUrl,
    rustHandle.baseUrl,
    "/api/folder/previews",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: ["alpha", "beta"],
        limitPerFolder: 3,
      }),
    }
  );

  const imagePath = encodePath("alpha/images/a.jpg");
  await compareMediaEndpoint(
    nodeHandle.baseUrl,
    rustHandle.baseUrl,
    `/media/${imagePath}`,
    {
      headers: {
        Range: "bytes=0-3",
      },
    }
  );
  await compareStatusEndpoint(
    nodeHandle.baseUrl,
    rustHandle.baseUrl,
    "/media/%2E%2E%2Fsecret.txt"
  );
  await compareMediaEndpoint(
    nodeHandle.baseUrl,
    rustHandle.baseUrl,
    `/thumb/${imagePath}`
  );

  console.log(
    JSON.stringify(
      {
        node: nodeHandle.baseUrl,
        rust: rustHandle.baseUrl,
        status: "ok",
      },
      null,
      2
    )
  );
} finally {
  await stopBackend(nodeHandle.child);
  await stopBackend(rustHandle.child);
  await fs.rm(TMP_ROOT, { recursive: true, force: true });
}
