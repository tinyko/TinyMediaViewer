import { performance } from "node:perf_hooks";

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

export function summarizeDurations(samples) {
  if (!samples.length) {
    return {
      count: 0,
      minMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      maxMs: 0,
    };
  }

  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    count: samples.length,
    minMs: Math.min(...samples),
    avgMs: total / samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
  };
}

async function fetchJson(url, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(url, options);
  const elapsedMs = performance.now() - startedAt;

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Request failed (${response.status}) for ${url}: ${body}`);
  }

  return {
    elapsedMs,
    payload: await response.json(),
  };
}

export async function measureJsonEndpoint(label, request, iterations) {
  const samples = [];
  let lastPayload = null;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const result = await request();
    samples.push(result.elapsedMs);
    lastPayload = result.payload;
  }

  return {
    label,
    summary: summarizeDurations(samples),
    samplesMs: samples,
    lastPayload,
  };
}

export async function runApiBenchmarkSuite(options) {
  const {
    baseUrl,
    accountPaths,
    iterations = 8,
    previewBatchSize = Math.min(6, accountPaths.length),
  } = options;

  const firstAccount = accountPaths[0];
  if (!firstAccount) {
    throw new Error("API benchmark requires at least one account path");
  }

  await fetchJson(`${baseUrl}/api/root`);
  await fetchJson(
    `${baseUrl}/api/category?path=${encodeURIComponent(firstAccount)}&kind=image&sort=desc&limit=240`
  );
  await fetchJson(
    `${baseUrl}/api/category?path=${encodeURIComponent(firstAccount)}&kind=video&sort=desc&limit=240`
  );
  await fetchJson(`${baseUrl}/api/system-usage?limit=10&refresh=1`);

  return {
    root: await measureJsonEndpoint(
      "root",
      () => fetchJson(`${baseUrl}/api/root`),
      iterations
    ),
    categoryImage: await measureJsonEndpoint(
      "category-image",
      () =>
        fetchJson(
          `${baseUrl}/api/category?path=${encodeURIComponent(
            firstAccount
          )}&kind=image&sort=desc&limit=240`
        ),
      iterations
    ),
    categoryVideo: await measureJsonEndpoint(
      "category-video",
      () =>
        fetchJson(
          `${baseUrl}/api/category?path=${encodeURIComponent(
            firstAccount
          )}&kind=video&sort=desc&limit=240`
        ),
      iterations
    ),
    previewBatch: await measureJsonEndpoint(
      "preview-batch",
      () =>
        fetchJson(`${baseUrl}/api/folder/previews`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            paths: accountPaths.slice(0, previewBatchSize),
          }),
        }),
      iterations
    ),
    systemUsageCached: await measureJsonEndpoint(
      "system-usage-cached",
      () => fetchJson(`${baseUrl}/api/system-usage?limit=10`),
      Math.max(3, Math.ceil(iterations / 2))
    ),
    systemUsageRefresh: await measureJsonEndpoint(
      "system-usage-refresh",
      () => fetchJson(`${baseUrl}/api/system-usage?limit=10&refresh=1`),
      2
    ),
  };
}

export async function runApiLoadLoop(options) {
  const { baseUrl, accountPaths, deadlineMs } = options;
  const firstAccount = accountPaths[0];
  let requests = 0;

  while (Date.now() < deadlineMs) {
    await fetchJson(`${baseUrl}/api/root`);
    await fetchJson(
      `${baseUrl}/api/category?path=${encodeURIComponent(firstAccount)}&kind=image&sort=desc&limit=240`
    );
    await fetchJson(
      `${baseUrl}/api/category?path=${encodeURIComponent(firstAccount)}&kind=video&sort=desc&limit=240`
    );
    await fetchJson(`${baseUrl}/api/folder/previews`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        paths: accountPaths.slice(0, Math.min(8, accountPaths.length)),
      }),
    });
    await fetchJson(`${baseUrl}/api/system-usage?limit=10&refresh=1`);
    requests += 5;
  }

  return {
    requests,
  };
}
