import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { launch as launchChrome } from "chrome-launcher";
import type { ApexConfig, ApexDevice } from "./types.js";
import { CdpClient } from "./cdp-client.js";
import type { MeasureSummary } from "./measure-types.js";

type ChromeSession = {
  readonly port: number;
  readonly close: () => Promise<void>;
};

type TargetInfo = {
  readonly targetId: string;
};

type AttachToTargetResult = {
  readonly sessionId: string;
};

type JsonVersionResponse = {
  readonly webSocketDebuggerUrl: string;
};

type NavigationResponse = {
  readonly frameId: string;
  readonly loaderId?: string;
  readonly errorText?: string;
};

type PageDeviceTask = {
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
};

type NavigationTiming = {
  readonly responseStart?: number;
  readonly domContentLoadedEventEnd?: number;
  readonly loadEventEnd?: number;
};

type MeasureEvaluateResult = {
  readonly navigation?: NavigationTiming;
  readonly vitals?: {
    readonly lcpMs?: number;
    readonly cls?: number;
    readonly inpMs?: number;
  };
  readonly longTasks?: {
    readonly count?: number;
    readonly totalMs?: number;
    readonly maxMs?: number;
  };
  readonly scriptingDurationMs?: number;
  readonly network?: {
    readonly totalRequests?: number;
    readonly totalBytes?: number;
    readonly thirdPartyRequests?: number;
    readonly thirdPartyBytes?: number;
    readonly cacheHitRatio?: number;
    readonly lateScriptRequests?: number;
  };
};

type MeasureArtifacts = {
  readonly screenshotPath?: string;
  readonly consoleErrors: readonly string[];
};

type MeasureResult = {
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
  readonly timings: {
    readonly ttfbMs?: number;
    readonly domContentLoadedMs?: number;
    readonly loadMs?: number;
  };
  readonly vitals: {
    readonly lcpMs?: number;
    readonly cls?: number;
    readonly inpMs?: number;
  };
  readonly longTasks: {
    readonly count: number;
    readonly totalMs: number;
    readonly maxMs: number;
  };
  readonly scriptingDurationMs?: number;
  readonly network: {
    readonly totalRequests: number;
    readonly totalBytes: number;
    readonly thirdPartyRequests: number;
    readonly thirdPartyBytes: number;
    readonly cacheHitRatio: number;
    readonly lateScriptRequests: number;
  };
  readonly artifacts: MeasureArtifacts;
  readonly runtimeErrorMessage?: string;
};

const DEFAULT_NAVIGATION_TIMEOUT_MS: number = 60_000;
const DEFAULT_MAX_PARALLEL: number = 4;
const DEFAULT_ARTIFACTS_DIR = ".apex-auditor/measure" as const;
const CHROME_FLAGS: readonly string[] = [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-extensions",
  "--disable-default-apps",
  "--no-first-run",
  "--no-default-browser-check",
] as const;
const MOBILE_METRICS = { mobile: true, width: 412, height: 823, deviceScaleFactor: 2 } as const;
const DESKTOP_METRICS = { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1 } as const;
const MOBILE_UA = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36" as const;

type TargetSession = { readonly targetId: string; readonly sessionId: string };

function computeMedian(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted: number[] = [...values].sort((a, b) => a - b);
  const mid: number = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  const a: number = sorted[mid - 1] ?? 0;
  const b: number = sorted[mid] ?? 0;
  return (a + b) / 2;
}

function createEtaTracker(params: { readonly total: number; readonly parallel: number }): {
  readonly recordProgress: (completed: number) => number | undefined;
} {
  const windowSize: number = Math.max(6, Math.min(30, params.parallel * 8));
  const minimumSamples: number = Math.max(3, Math.min(10, params.parallel * 3));
  const minimumElapsedMs: number = 2_000;
  const minimumDeltaMs: number = 200;
  const ratesPerSecond: number[] = [];
  const startedAtMs: number = Date.now();
  let lastAtMs: number | undefined;
  let lastCompleted: number | undefined;

  const recordProgress = (completed: number): number | undefined => {
    const nowMs: number = Date.now();
    if (lastAtMs !== undefined && lastCompleted !== undefined) {
      const deltaCompleted: number = completed - lastCompleted;
      const deltaMs: number = nowMs - lastAtMs;
      if (deltaCompleted > 0 && deltaMs >= minimumDeltaMs) {
        const perSecond: number = (deltaCompleted * 1000) / deltaMs;
        if (Number.isFinite(perSecond) && perSecond > 0) {
          ratesPerSecond.push(perSecond);
          if (ratesPerSecond.length > windowSize) {
            ratesPerSecond.shift();
          }
        }
      }
    }
    lastAtMs = nowMs;
    lastCompleted = completed;
    if (nowMs - startedAtMs < minimumElapsedMs) {
      return undefined;
    }
    if (ratesPerSecond.length < minimumSamples) {
      return undefined;
    }
    const medianRate: number = computeMedian(ratesPerSecond);
    if (!Number.isFinite(medianRate) || medianRate <= 0) {
      return undefined;
    }
    const remaining: number = Math.max(0, params.total - completed);
    const etaSeconds: number = remaining / medianRate;
    return Math.max(0, Math.round(etaSeconds * 1000));
  };

  return { recordProgress };
}

function buildUrl({ baseUrl, path, query }: { readonly baseUrl: string; readonly path: string; readonly query?: string }): string {
  const cleanBase: string = baseUrl.replace(/\/$/, "");
  const cleanPath: string = path.startsWith("/") ? path : `/${path}`;
  const queryPart: string = query && query.length > 0 ? query : "";
  return `${cleanBase}${cleanPath}${queryPart}`;
}

function slugify(value: string): string {
  const safe: string = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return safe.length > 0 ? safe : "page";
}

function buildArtifactBaseName(task: PageDeviceTask): string {
  const hash: string = createHash("sha1").update(`${task.url}::${task.device}`).digest("hex").slice(0, 10);
  const pathPart: string = slugify(task.path);
  return `${pathPart}-${task.device}-${hash}`;
}

function resolveParallelCount(params: { readonly requested?: number; readonly taskCount: number }): number {
  const requested: number | undefined = params.requested;
  if (requested !== undefined) {
    return Math.max(1, Math.min(DEFAULT_MAX_PARALLEL, Math.min(params.taskCount, requested)));
  }
  return Math.max(1, Math.min(DEFAULT_MAX_PARALLEL, params.taskCount));
}

async function createChromeSession(): Promise<ChromeSession> {
  const userDataDir: string = await mkdtemp(join(tmpdir(), "apex-auditor-measure-chrome-"));
  const chrome = await launchChrome({ chromeFlags: [...CHROME_FLAGS, `--user-data-dir=${userDataDir}`] });
  return {
    port: chrome.port,
    close: async () => {
      try {
        await chrome.kill();
        await rm(userDataDir, { recursive: true, force: true });
      } catch {
        return;
      }
    },
  };
}

async function fetchJsonVersion(port: number): Promise<JsonVersionResponse> {
  const url: string = `http://127.0.0.1:${port}/json/version`;
  return new Promise<JsonVersionResponse>((resolve, reject) => {
    const request = httpRequest(url, (response) => {
      const statusCode: number = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        response.resume();
        reject(new Error(`CDP /json/version returned HTTP ${statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        const raw: string = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") {
          reject(new Error("Invalid /json/version response"));
          return;
        }
        const record = parsed as { readonly webSocketDebuggerUrl?: unknown };
        if (typeof record.webSocketDebuggerUrl !== "string" || record.webSocketDebuggerUrl.length === 0) {
          reject(new Error("Missing webSocketDebuggerUrl in /json/version"));
          return;
        }
        resolve({ webSocketDebuggerUrl: record.webSocketDebuggerUrl });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function buildTasks(config: ApexConfig): readonly PageDeviceTask[] {
  const tasks: PageDeviceTask[] = [];
  for (const page of config.pages) {
    for (const device of page.devices) {
      const url: string = buildUrl({ baseUrl: config.baseUrl, path: page.path, query: config.query });
      tasks.push({ url, path: page.path, label: page.label, device });
    }
  }
  return tasks;
}

function buildMeasureScript(): string {
  return `(() => {
  const state = {
    cls: 0,
    lcp: undefined,
    inp: undefined,
  };
  const clsObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const e = entry;
      if (e.hadRecentInput) {
        continue;
      }
      state.cls += e.value;
    }
  });
  try { clsObserver.observe({ type: 'layout-shift', buffered: true }); } catch {}
  const lcpObserver = new PerformanceObserver((list) => {
    const entries = list.getEntries();
    const last = entries[entries.length - 1];
    if (last) {
      state.lcp = last.startTime;
    }
  });
  try { lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
  const inpObserver = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (typeof entry.interactionId !== 'number') {
        continue;
      }
      const duration = entry.duration;
      if (typeof duration === 'number') {
        state.inp = state.inp === undefined ? duration : Math.max(state.inp, duration);
      }
    }
  });
  try { inpObserver.observe({ type: 'event', buffered: true, durationThreshold: 40 }); } catch {}
  (globalThis).__apexMeasure = state;
})()`;
}

function applyDeviceEmulation(client: CdpClient, device: ApexDevice, sessionId: string): Promise<unknown> {
  if (device === "mobile") {
    return Promise.all([
      client.send("Emulation.setDeviceMetricsOverride", MOBILE_METRICS, sessionId),
      client.send("Emulation.setUserAgentOverride", { userAgent: MOBILE_UA }, sessionId),
    ]);
  }
  return client.send("Emulation.setDeviceMetricsOverride", DESKTOP_METRICS, sessionId);
}

function recordLogEvents(client: CdpClient, sessionId: string, bucket: string[]): () => void {
  const offException = client.onEvent("Runtime.exceptionThrown", sessionId, (payload: unknown) => {
    const text: string = typeof payload === "object" && payload !== null ? JSON.stringify(payload) : String(payload);
    bucket.push(`exception: ${text}`);
  });
  const offConsole = client.onEvent("Runtime.consoleAPICalled", sessionId, (payload: unknown) => {
    const text: string = typeof payload === "object" && payload !== null ? JSON.stringify(payload) : String(payload);
    if (text.toLowerCase().includes("error")) {
      bucket.push(`console: ${text}`);
    }
  });
  const offLog = client.onEvent("Log.entryAdded", sessionId, (payload: unknown) => {
    const record = payload as { readonly entry?: unknown };
    const entry = record.entry as { readonly level?: unknown; readonly text?: unknown } | undefined;
    const level: string = typeof entry?.level === "string" ? entry.level : "";
    const text: string = typeof entry?.text === "string" ? entry.text : "";
    if (level === "error" && text.length > 0) {
      bucket.push(text);
    }
  });
  return () => {
    offException();
    offConsole();
    offLog();
  };
}

async function captureScreenshot(client: CdpClient, task: PageDeviceTask, sessionId: string, artifactsDir: string): Promise<string | undefined> {
  try {
    const screenshot = await client.send<{ readonly data?: unknown }>("Page.captureScreenshot", { format: "png" }, sessionId);
    const data: string | undefined = typeof screenshot.data === "string" ? screenshot.data : undefined;
    if (!data) {
      return undefined;
    }
    const baseName: string = buildArtifactBaseName(task);
    const screenshotPath: string = resolve(artifactsDir, `${baseName}.png`);
    await writeFile(screenshotPath, Buffer.from(data, "base64"));
    return screenshotPath;
  } catch {
    return undefined;
  }
}

function parseMeasureResult(valueUnknown: unknown): {
  readonly timings: { readonly ttfbMs?: number; readonly domContentLoadedMs?: number; readonly loadMs?: number };
  readonly vitals: { readonly lcpMs?: number; readonly cls?: number; readonly inpMs?: number };
  readonly longTasks: { readonly count: number; readonly totalMs: number; readonly maxMs: number };
  readonly scriptingDurationMs?: number;
  readonly network: {
    readonly totalRequests: number;
    readonly totalBytes: number;
    readonly thirdPartyRequests: number;
    readonly thirdPartyBytes: number;
    readonly cacheHitRatio: number;
    readonly lateScriptRequests: number;
  };
} {
  const value: MeasureEvaluateResult =
    valueUnknown && typeof valueUnknown === "object" ? (valueUnknown as MeasureEvaluateResult) : {};
  const ttfbMs: number | undefined = typeof value.navigation?.responseStart === "number" ? value.navigation.responseStart : undefined;
  const domContentLoadedMs: number | undefined =
    typeof value.navigation?.domContentLoadedEventEnd === "number" ? value.navigation.domContentLoadedEventEnd : undefined;
  const loadMs: number | undefined = typeof value.navigation?.loadEventEnd === "number" ? value.navigation.loadEventEnd : undefined;
  const lcpMs: number | undefined = typeof value.vitals?.lcpMs === "number" ? value.vitals.lcpMs : undefined;
  const cls: number | undefined = typeof value.vitals?.cls === "number" ? value.vitals.cls : undefined;
  const inpMs: number | undefined = typeof value.vitals?.inpMs === "number" ? value.vitals.inpMs : undefined;
  const longTasks = {
    count: typeof value.longTasks?.count === "number" ? value.longTasks.count : 0,
    totalMs: typeof value.longTasks?.totalMs === "number" ? value.longTasks.totalMs : 0,
    maxMs: typeof value.longTasks?.maxMs === "number" ? value.longTasks.maxMs : 0,
  };
  const scriptingDurationMs: number | undefined = typeof value.scriptingDurationMs === "number" ? value.scriptingDurationMs : longTasks.totalMs;
  const network = {
    totalRequests: typeof value.network?.totalRequests === "number" ? value.network.totalRequests : 0,
    totalBytes: typeof value.network?.totalBytes === "number" ? value.network.totalBytes : 0,
    thirdPartyRequests: typeof value.network?.thirdPartyRequests === "number" ? value.network.thirdPartyRequests : 0,
    thirdPartyBytes: typeof value.network?.thirdPartyBytes === "number" ? value.network.thirdPartyBytes : 0,
    cacheHitRatio: typeof value.network?.cacheHitRatio === "number" ? value.network.cacheHitRatio : 0,
    lateScriptRequests: typeof value.network?.lateScriptRequests === "number" ? value.network.lateScriptRequests : 0,
  };
  return { timings: { ttfbMs, domContentLoadedMs, loadMs }, vitals: { lcpMs, cls, inpMs }, longTasks, scriptingDurationMs, network };
}

async function createTargetSession(client: CdpClient): Promise<TargetSession> {
  const created: TargetInfo = await client.send<TargetInfo>("Target.createTarget", { url: "about:blank" });
  const attached: AttachToTargetResult = await client.send<AttachToTargetResult>(
    "Target.attachToTarget",
    { targetId: created.targetId, flatten: true },
  );
  return { targetId: created.targetId, sessionId: attached.sessionId };
}

async function enableDomains(client: CdpClient, sessionId: string): Promise<void> {
  await client.send("Page.enable", {}, sessionId);
  await client.send("Log.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await client.send("Performance.enable", {}, sessionId);
}

async function injectMeasurementScript(client: CdpClient, sessionId: string): Promise<void> {
  const measurementScript: string = buildMeasureScript();
  await client.send("Runtime.evaluate", { expression: measurementScript, awaitPromise: false }, sessionId);
}

async function navigateAndAwaitLoad(client: CdpClient, sessionId: string, url: string, timeoutMs: number): Promise<void> {
  const response: NavigationResponse = await client.send<NavigationResponse>("Page.navigate", { url }, sessionId);
  if (response.errorText) {
    throw new Error(response.errorText);
  }
  await client.waitForEventForSession("Page.loadEventFired", sessionId, timeoutMs);
}

async function evaluateMetrics(client: CdpClient, sessionId: string): Promise<{
  readonly timings: { readonly ttfbMs?: number; readonly domContentLoadedMs?: number; readonly loadMs?: number };
  readonly vitals: { readonly lcpMs?: number; readonly cls?: number; readonly inpMs?: number };
  readonly longTasks: { readonly count: number; readonly totalMs: number; readonly maxMs: number };
  readonly scriptingDurationMs?: number;
  readonly network: {
    readonly totalRequests: number;
    readonly totalBytes: number;
    readonly thirdPartyRequests: number;
    readonly thirdPartyBytes: number;
    readonly cacheHitRatio: number;
    readonly lateScriptRequests: number;
  };
}> {
  const evaluateResult = await client.send<{ readonly result?: unknown }>(
    "Runtime.evaluate",
    {
      expression: `(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const state = (globalThis).__apexMeasure;
  const resources = performance.getEntriesByType('resource');
  const longTasks = performance.getEntriesByType('longtask');
  let longTaskCount = 0;
  let longTaskTotal = 0;
  let longTaskMax = 0;
  for (const lt of longTasks) {
    const duration = lt.duration || 0;
    longTaskCount += 1;
    longTaskTotal += duration;
    if (duration > longTaskMax) {
      longTaskMax = duration;
    }
  }
  let totalRequests = 0;
  let totalBytes = 0;
  let thirdPartyRequests = 0;
  let thirdPartyBytes = 0;
  let cacheHits = 0;
  let lateScriptRequests = 0;
  const pageHost = location.host;
  const loadEnd = nav ? nav.loadEventEnd : 0;
  for (const res of resources) {
    totalRequests += 1;
    const transfer = typeof res.transferSize === 'number' ? res.transferSize : 0;
    const encoded = typeof res.encodedBodySize === 'number' ? res.encodedBodySize : 0;
    totalBytes += transfer;
    try {
      const url = new URL(res.name, location.href);
      const isThirdParty = url.host !== pageHost;
      if (isThirdParty) {
        thirdPartyRequests += 1;
        thirdPartyBytes += transfer;
      }
    } catch {}
    if ((transfer === 0 && encoded > 0) || (encoded > 0 && transfer < encoded)) {
      cacheHits += 1;
    }
    if (res.initiatorType === 'script' && loadEnd && res.startTime >= loadEnd) {
      lateScriptRequests += 1;
    }
  }
  const cacheHitRatio = totalRequests > 0 ? cacheHits / totalRequests : 0;
  return {
    navigation: nav ? {
      responseStart: nav.responseStart,
      domContentLoadedEventEnd: nav.domContentLoadedEventEnd,
      loadEventEnd: nav.loadEventEnd,
    } : undefined,
    vitals: state ? {
      lcpMs: state.lcp,
      cls: state.cls,
      inpMs: state.inp,
    } : undefined,
    longTasks: {
      count: longTaskCount,
      totalMs: longTaskTotal,
      maxMs: longTaskMax,
    },
    scriptingDurationMs: longTaskTotal,
    network: {
      totalRequests,
      totalBytes,
      thirdPartyRequests,
      thirdPartyBytes,
      cacheHitRatio,
      lateScriptRequests,
    },
  };
})()`,
    },
    sessionId,
  );
  const valueUnknown: unknown = (evaluateResult.result as { readonly value?: unknown } | undefined)?.value;
  return parseMeasureResult(valueUnknown);
}

async function detachAndClose(client: CdpClient, context: TargetSession, stopLogging: () => void): Promise<void> {
  stopLogging();
  await client.send("Target.closeTarget", { targetId: context.targetId });
  await client.send("Target.detachFromTarget", { sessionId: context.sessionId });
}

async function collectMetrics(params: {
  readonly client: CdpClient;
  readonly task: PageDeviceTask;
  readonly sessionId: string;
  readonly timeoutMs: number;
  readonly artifactsDir: string;
  readonly consoleErrors: string[];
  readonly captureScreenshots: boolean;
}): Promise<{
  readonly parsed: {
    readonly timings: { readonly ttfbMs?: number; readonly domContentLoadedMs?: number; readonly loadMs?: number };
    readonly vitals: { readonly lcpMs?: number; readonly cls?: number; readonly inpMs?: number };
    readonly longTasks: { readonly count: number; readonly totalMs: number; readonly maxMs: number };
    readonly scriptingDurationMs?: number;
    readonly network: {
      readonly totalRequests: number;
      readonly totalBytes: number;
      readonly thirdPartyRequests: number;
      readonly thirdPartyBytes: number;
      readonly cacheHitRatio: number;
      readonly lateScriptRequests: number;
    };
  };
  readonly screenshotPath?: string;
  readonly stopLogging: () => void;
}> {
  const { client, task, sessionId, timeoutMs, artifactsDir, consoleErrors } = params;
  const stopLogging = recordLogEvents(client, sessionId, consoleErrors);
  await applyDeviceEmulation(client, task.device, sessionId);
  await injectMeasurementScript(client, sessionId);
  await navigateAndAwaitLoad(client, sessionId, task.url, timeoutMs);
  const screenshotPath: string | undefined = params.captureScreenshots
    ? await captureScreenshot(client, task, sessionId, artifactsDir)
    : undefined;
  await client.send("Runtime.evaluate", { expression: "void 0", awaitPromise: false }, sessionId);
  const parsed = await evaluateMetrics(client, sessionId);
  return { parsed, screenshotPath, stopLogging };
}

async function runSingleMeasure(params: {
  readonly client: CdpClient;
  readonly task: PageDeviceTask;
  readonly timeoutMs: number;
  readonly artifactsDir: string;
  readonly captureScreenshots: boolean;
}): Promise<MeasureResult> {
  const { client, task, timeoutMs, artifactsDir } = params;
  let finalUrl: string = task.url;
  const consoleErrors: string[] = [];
  let screenshotPath: string | undefined;
  try {
    const context: TargetSession = await createTargetSession(client);
    await enableDomains(client, context.sessionId);
    const { parsed, screenshotPath: shotPath, stopLogging } = await collectMetrics({
      client,
      task,
      sessionId: context.sessionId,
      timeoutMs,
      artifactsDir,
      consoleErrors,
      captureScreenshots: params.captureScreenshots,
    });
    screenshotPath = shotPath;
    finalUrl = task.url;
    await detachAndClose(client, context, stopLogging);
    return {
      url: finalUrl,
      path: task.path,
      label: task.label,
      device: task.device,
      timings: parsed.timings,
      vitals: parsed.vitals,
      longTasks: parsed.longTasks,
      scriptingDurationMs: parsed.scriptingDurationMs,
      network: parsed.network,
      artifacts: { screenshotPath, consoleErrors },
    };
  } catch (error: unknown) {
    const message: string = error instanceof Error ? error.message : "Unknown error";
    return {
      url: finalUrl,
      path: task.path,
      label: task.label,
      device: task.device,
      timings: {},
      vitals: {},
      longTasks: { count: 0, totalMs: 0, maxMs: 0 },
      scriptingDurationMs: 0,
      network: {
        totalRequests: 0,
        totalBytes: 0,
        thirdPartyRequests: 0,
        thirdPartyBytes: 0,
        cacheHitRatio: 0,
        lateScriptRequests: 0,
      },
      artifacts: { screenshotPath, consoleErrors },
      runtimeErrorMessage: message,
    };
  }
}

async function runWithConcurrency(params: {
  readonly tasks: readonly PageDeviceTask[];
  readonly parallel: number;
  readonly runner: (task: PageDeviceTask) => Promise<MeasureResult>;
}): Promise<readonly MeasureResult[]> {
  const results: MeasureResult[] = new Array(params.tasks.length);
  const nextIndex = { value: 0 };
  const worker = async (): Promise<void> => {
    while (true) {
      const index: number = nextIndex.value;
      if (index >= params.tasks.length) {
        return;
      }
      nextIndex.value += 1;
      const task: PageDeviceTask = params.tasks[index];
      results[index] = await params.runner(task);
    }
  };
  const workers: Promise<void>[] = new Array(params.parallel).fill(0).map(async () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Run fast, non-Lighthouse measurements across all page/device combos in the config.
 */
export async function runMeasureForConfig(params: {
  readonly config: ApexConfig;
  readonly configPath: string;
  readonly parallelOverride?: number;
  readonly timeoutMs?: number;
  readonly artifactsDir?: string;
  readonly captureScreenshots?: boolean;
  readonly signal?: AbortSignal;
  readonly onProgress?: (params: { readonly completed: number; readonly total: number; readonly path: string; readonly device: ApexDevice; readonly etaMs?: number }) => void;
}): Promise<MeasureSummary> {
  const startedAtMs: number = Date.now();
  const tasks: readonly PageDeviceTask[] = buildTasks(params.config);
  const parallel: number = resolveParallelCount({ requested: params.parallelOverride ?? params.config.parallel, taskCount: tasks.length });
  const timeoutMs: number = params.timeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const artifactsDir: string = params.artifactsDir ?? DEFAULT_ARTIFACTS_DIR;
  const captureScreenshots: boolean = params.captureScreenshots === true;
  await mkdir(artifactsDir, { recursive: true });
  const etaTracker = createEtaTracker({ total: tasks.length, parallel });
  const progressLock = { count: 0 };
  const chrome: ChromeSession = await createChromeSession();
  try {
    const version: JsonVersionResponse = await fetchJsonVersion(chrome.port);
    const client: CdpClient = new CdpClient(version.webSocketDebuggerUrl);
    await client.connect();
    try {
      const results: readonly MeasureResult[] = await runWithConcurrency({
        tasks,
        parallel,
        runner: async (task) => {
          if (params.signal?.aborted) {
            throw new Error("Aborted");
          }
          const result: MeasureResult = await runSingleMeasure({ client, task, timeoutMs, artifactsDir, captureScreenshots });
          progressLock.count += 1;
          const completed: number = progressLock.count;
          const etaMs: number | undefined = etaTracker.recordProgress(completed);
          if (typeof params.onProgress === "function") {
            params.onProgress({ completed, total: tasks.length, path: task.path, device: task.device, etaMs });
          }
          return result;
        },
      });
      const completedAtMs: number = Date.now();
      const elapsedMs: number = completedAtMs - startedAtMs;
      const averageComboMs: number = tasks.length > 0 ? Math.round(elapsedMs / tasks.length) : 0;
      return {
        meta: {
          configPath: params.configPath,
          resolvedParallel: parallel,
          comboCount: tasks.length,
          startedAt: new Date(startedAtMs).toISOString(),
          completedAt: new Date(completedAtMs).toISOString(),
          elapsedMs,
          averageComboMs,
        },
        results,
      };
    } finally {
      client.close();
    }
  } finally {
    await chrome.close();
  }
}
