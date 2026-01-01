import { mkdtemp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { cpus, freemem, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import lighthouse from "lighthouse";
import { launch as launchChrome } from "chrome-launcher";
import type { ApexCategory, ApexConfig, ApexDevice, ApexThrottlingMethod, MetricValues, CategoryScores, OpportunitySummary, PageDeviceSummary, RunSummary } from "./types.js";

interface ChromeSession {
  readonly port: number;
  readonly close?: () => Promise<void>;
}

type IncrementalCache = {
  readonly version: 1;
  readonly entries: Record<string, PageDeviceSummary>;
};

const CACHE_VERSION = 1 as const;
const CACHE_DIR = ".apex-auditor" as const;
const CACHE_FILE = "cache.json" as const;

const DEFAULT_WORKER_TASK_TIMEOUT_MS: number = 5 * 60 * 1000;
const WORKER_RESPONSE_TIMEOUT_GRACE_MS: number = 15 * 1000;
const MAX_PARENT_TASK_ATTEMPTS: number = 5;
const MAX_PARENT_BACKOFF_MS: number = 3000;

let lastProgressLine: string | undefined;

function logLinePreservingProgress(message: string): void {
  if (typeof process === "undefined" || !process.stdout || typeof process.stdout.write !== "function" || process.stdout.isTTY !== true) {
    // eslint-disable-next-line no-console
    console.warn(message);
    return;
  }
  if (lastProgressLine !== undefined) {
    const clear: string = " ".repeat(lastProgressLine.length);
    process.stdout.write(`\r${clear}\r`);
  }
  process.stdout.write(`${message}\n`);
  if (lastProgressLine !== undefined) {
    process.stdout.write(`\r${lastProgressLine}`);
  }
}

function buildFailureSummary(task: AuditTask, errorMessage: string): PageDeviceSummary {
  return {
    url: task.url,
    path: task.path,
    label: task.label,
    device: task.device,
    scores: {},
    metrics: {},
    opportunities: [],
    runtimeErrorMessage: errorMessage,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const timeoutPromise: Promise<T> = new Promise<T>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`ApexAuditor timeout after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

function computeParentRetryDelayMs(params: { readonly attempt: number }): number {
  const base: number = 200;
  const expFactor: number = Math.min(4, params.attempt);
  const candidate: number = base * Math.pow(2, expFactor);
  const jitter: number = Math.floor(Math.random() * 200);
  return Math.min(MAX_PARENT_BACKOFF_MS, candidate + jitter);
}

function buildCacheKey(params: {
  readonly buildId: string;
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
  readonly runs: number;
  readonly throttlingMethod: ApexThrottlingMethod;
  readonly cpuSlowdownMultiplier: number;
  readonly onlyCategories?: readonly ApexCategory[];
}): string {
  const onlyCategories: readonly ApexCategory[] = params.onlyCategories ?? [];
  return stableStringify({
    buildId: params.buildId,
    url: params.url,
    path: params.path,
    label: params.label,
    device: params.device,
    runs: params.runs,
    throttlingMethod: params.throttlingMethod,
    cpuSlowdownMultiplier: params.cpuSlowdownMultiplier,
    onlyCategories,
  });
}

async function loadIncrementalCache(): Promise<IncrementalCache | undefined> {
  const cachePath: string = resolve(CACHE_DIR, CACHE_FILE);
  try {
    const raw: string = await readFile(cachePath, "utf8");
    const parsed: unknown = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const maybe = parsed as { readonly version?: unknown; readonly entries?: unknown };
    if (maybe.version !== CACHE_VERSION || !maybe.entries || typeof maybe.entries !== "object") {
      return undefined;
    }
    return { version: CACHE_VERSION, entries: maybe.entries as Record<string, PageDeviceSummary> };
  } catch {
    return undefined;
  }
}

async function saveIncrementalCache(cache: IncrementalCache): Promise<void> {
  await mkdir(resolve(CACHE_DIR), { recursive: true });
  const cachePath: string = resolve(CACHE_DIR, CACHE_FILE);
  await writeFile(cachePath, JSON.stringify(cache, null, 2), "utf8");
}

function resolveWorkerEntryUrl(): { readonly entry: URL; readonly useTsx: boolean } {
  const jsEntry: URL = new URL("./lighthouse-worker.js", import.meta.url);
  const tsEntry: URL = new URL("./lighthouse-worker.ts", import.meta.url);
  const isSourceRun: boolean = import.meta.url.endsWith(".ts");
  return { entry: isSourceRun ? tsEntry : jsEntry, useTsx: isSourceRun };
}

function spawnWorker(): ReturnType<typeof spawn> {
  const resolved = resolveWorkerEntryUrl();
  const entryPath: string = fileURLToPath(resolved.entry);
  const args: string[] = resolved.useTsx ? ["--import", "tsx", entryPath] : [entryPath];
  return spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe", "ipc"] });
}

async function runParallelInProcesses(
  tasks: AuditTask[],
  parallelCount: number,
  auditTimeoutMs: number,
  signal: AbortSignal | undefined,
  updateProgress: (path: string, device: ApexDevice) => void,
): Promise<PageDeviceSummary[]> {
  const effectiveParallel: number = Math.min(parallelCount, tasks.length);
  const workers: Array<{ readonly child: ReturnType<typeof spawn>; busy: boolean; inFlightId?: string; inFlightTaskIndex?: number }> = [];
  for (let i = 0; i < effectiveParallel; i += 1) {
    if (i > 0) {
      await delayMs(200 * i);
    }
    workers.push({ child: spawnWorker(), busy: false });
  }
  type PendingItem = { readonly taskIndex: number; readonly runIndex: number; readonly attempts: number };
  const results: PageDeviceSummary[] = new Array(tasks.length);
  const pending: PendingItem[] = [];
  for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
    for (let runIndex = 0; runIndex < tasks[taskIndex].runs; runIndex += 1) {
      pending.push({ taskIndex, runIndex, attempts: 0 });
    }
  }
  const summariesByTask: PageDeviceSummary[][] = tasks.map(() => []);
  const inFlight: Map<string, PendingItem> = new Map();
  const waiters: Map<string, { resolve: (msg: WorkerResponseMessage) => void; reject: (err: Error) => void }> = new Map();
  const attachListeners = (child: ReturnType<typeof spawn>): void => {
    child.on("message", (raw: unknown) => {
      const msg: WorkerResponseMessage | undefined = raw && typeof raw === "object" ? (raw as WorkerResponseMessage) : undefined;
      if (!msg || typeof msg.id !== "string") {
        return;
      }
      const waiter = waiters.get(msg.id);
      if (!waiter) {
        return;
      }
      waiters.delete(msg.id);
      waiter.resolve(msg);
    });
    child.on("error", (error: Error) => {
      for (const [id, waiter] of waiters) {
        waiter.reject(error);
        waiters.delete(id);
      }
    });
    child.on("exit", () => {
      for (const [id, waiter] of waiters) {
        waiter.reject(new Error("Worker exited"));
        waiters.delete(id);
      }
    });
    child.on("disconnect", () => {
      for (const [id, waiter] of waiters) {
        waiter.reject(new Error("Worker disconnected"));
        waiters.delete(id);
      }
    });
  };
  for (const worker of workers) {
    attachListeners(worker.child);
  }
  if (signal) {
    const onAbort = (): void => {
      for (const worker of workers) {
        try {
          worker.child.kill();
        } catch {
          continue;
        }
      }
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  let consecutiveRetries = 0;
  const runOnWorker = async (workerIndex: number, taskIndex: number): Promise<void> => {
    const worker = workers[workerIndex];
    if (signal?.aborted) {
      return;
    }
    const next = pending.shift();
    if (!next) {
      return;
    }
    const task: AuditTask = tasks[next.taskIndex];
    const id: string = `${workerIndex}-${next.taskIndex}-${next.runIndex}-${Date.now()}`;
    const workerTask: WorkerTask = {
      url: task.url,
      path: task.path,
      label: task.label,
      device: task.device,
      logLevel: task.logLevel,
      throttlingMethod: task.throttlingMethod,
      cpuSlowdownMultiplier: task.cpuSlowdownMultiplier,
      timeoutMs: auditTimeoutMs,
      onlyCategories: task.onlyCategories,
    };
    worker.busy = true;
    worker.inFlightId = id;
    worker.inFlightTaskIndex = next.taskIndex;
    inFlight.set(id, next);
    const responseTimeoutMs: number = auditTimeoutMs + WORKER_RESPONSE_TIMEOUT_GRACE_MS;
    const response: WorkerResponseMessage = await new Promise<WorkerResponseMessage>((resolve, reject) => {
      const timeoutHandle: NodeJS.Timeout = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Worker response timeout after ${responseTimeoutMs}ms`));
      }, responseTimeoutMs);
      const abortListener = (): void => {
        clearTimeout(timeoutHandle);
        waiters.delete(id);
        reject(new Error("Aborted"));
      };
      signal?.addEventListener("abort", abortListener, { once: true });
      waiters.set(id, {
        resolve: (msg: WorkerResponseMessage) => {
          clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", abortListener);
          resolve(msg);
        },
        reject: (err: Error) => {
          clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", abortListener);
          reject(err);
        },
      });
      const request: WorkerRequestMessage = { type: "run", id, task: workerTask };
      try {
        worker.child.send(request);
      } catch (error) {
        clearTimeout(timeoutHandle);
        waiters.delete(id);
        reject(error instanceof Error ? error : new Error("Worker send failed"));
      }
    }).catch((error: unknown) => {
      return { type: "error", id, errorMessage: error instanceof Error ? error.message : "Worker failure" } as WorkerResponseMessage;
    });
    const flight: PendingItem | undefined = inFlight.get(id);
    inFlight.delete(id);
    worker.busy = false;
    worker.inFlightId = undefined;
    worker.inFlightTaskIndex = undefined;
    if (response.type === "error") {
      const isTimeout: boolean = response.errorMessage.includes("timeout") || response.errorMessage.includes("Timeout") || response.errorMessage.includes("ApexAuditor timeout");
      const prefix: string = isTimeout ? "Timeout" : "Worker error";
      logLinePreservingProgress(`${prefix}: ${task.path} [${task.device}] (run ${next.runIndex + 1}/${task.runs}). Retrying... (${response.errorMessage})`);
      const retryItem = flight
        ? { taskIndex: flight.taskIndex, runIndex: flight.runIndex, attempts: next.attempts + 1 }
        : { taskIndex: next.taskIndex, runIndex: next.runIndex, attempts: next.attempts + 1 };
      if (retryItem.attempts >= MAX_PARENT_TASK_ATTEMPTS) {
        logLinePreservingProgress(`Giving up: ${task.path} [${task.device}] (run ${next.runIndex + 1}/${task.runs}) after ${retryItem.attempts} attempts.`);
        summariesByTask[next.taskIndex].push(buildFailureSummary(task, response.errorMessage));
        updateProgress(task.path, task.device);
        if (summariesByTask[next.taskIndex].length === task.runs) {
          results[next.taskIndex] = aggregateSummaries(summariesByTask[next.taskIndex]);
        }
      } else {
        pending.unshift(retryItem);
      }
      consecutiveRetries += 1;
      try {
        worker.child.kill();
      } catch {
        return;
      }
      const replacement = spawnWorker();
      await delayMs(computeParentRetryDelayMs({ attempt: retryItem.attempts }));
      attachListeners(replacement);
      workers[workerIndex] = { child: replacement, busy: false };
      return;
    }
    consecutiveRetries = 0;
    summariesByTask[next.taskIndex].push(response.result);
    updateProgress(task.path, task.device);
    if (summariesByTask[next.taskIndex].length === task.runs) {
      results[next.taskIndex] = aggregateSummaries(summariesByTask[next.taskIndex]);
    }
  };
  try {
    while (pending.length > 0) {
      if (signal?.aborted) {
        throw new Error("Aborted");
      }
      if (consecutiveRetries >= 2) {
        logLinePreservingProgress(`Cooling down after ${consecutiveRetries} retry attempts; pausing briefly before resuming...`);
        await delayMs(computeParentRetryDelayMs({ attempt: consecutiveRetries }));
        consecutiveRetries = 0;
      }
      const idle: number[] = workers.map((w, idx) => (w.busy ? -1 : idx)).filter((idx) => idx >= 0);
      if (idle.length === 0) {
        await delayMs(50);
        continue;
      }
      await Promise.all(idle.map(async (workerIndex) => {
        await runOnWorker(workerIndex, workerIndex);
      }));
    }
  } finally {
    for (const worker of workers) {
      try {
        worker.child.kill();
      } catch {
        continue;
      }
    }
  }
  return results;
}

interface LighthouseCategoryLike {
  readonly score?: number;
}

interface LighthouseAuditDetailsLike {
  readonly type?: string;
  readonly overallSavingsMs?: number;
  readonly overallSavingsBytes?: number;
}

interface LighthouseAuditLike {
  readonly id?: string;
  readonly title?: string;
  readonly scoreDisplayMode?: string;
  readonly numericValue?: number;
  readonly details?: LighthouseAuditDetailsLike;
}

interface LighthouseResultLike {
  readonly finalDisplayedUrl?: string;
  readonly audits: { readonly [key: string]: unknown };
  readonly categories: {
    readonly performance?: LighthouseCategoryLike;
    readonly accessibility?: LighthouseCategoryLike;
    readonly ["best-practices"]?: LighthouseCategoryLike;
    readonly seo?: LighthouseCategoryLike;
  };
  readonly runtimeError?: {
    readonly code?: string;
    readonly message?: string;
  };
}

interface RunAuditParams {
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
  readonly port: number;
  readonly logLevel: "silent" | "error" | "info" | "verbose";
  readonly throttlingMethod: ApexThrottlingMethod;
  readonly cpuSlowdownMultiplier: number;
  readonly onlyCategories?: readonly ApexCategory[];
}

interface AuditTask {
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
  readonly runs: number;
  readonly logLevel: "silent" | "error" | "info" | "verbose";
  readonly throttlingMethod: ApexThrottlingMethod;
  readonly cpuSlowdownMultiplier: number;
  readonly onlyCategories?: readonly ApexCategory[];
}

type WorkerTask = {
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
  readonly logLevel: "silent" | "error" | "info" | "verbose";
  readonly throttlingMethod: ApexThrottlingMethod;
  readonly cpuSlowdownMultiplier: number;
  readonly timeoutMs: number;
  readonly onlyCategories?: readonly ApexCategory[];
};

type WorkerRequestMessage = {
  readonly type: "run";
  readonly id: string;
  readonly task: WorkerTask;
};

type WorkerResponseMessage =
  | {
      readonly type: "result";
      readonly id: string;
      readonly result: PageDeviceSummary;
    }
  | {
      readonly type: "error";
      readonly id: string;
      readonly errorMessage: string;
    };

async function createChromeSession(chromePort?: number): Promise<ChromeSession> {
  if (typeof chromePort === "number") {
    return { port: chromePort };
  }
  const userDataDir: string = await mkdtemp(join(tmpdir(), "apex-auditor-chrome-"));
  const chrome = await launchChrome({
    chromeFlags: [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-default-apps",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${userDataDir}`,
      // Additional flags for more consistent and accurate results
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-client-side-phishing-detection",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--safebrowsing-disable-auto-update",
      "--password-store=basic",
      "--use-mock-keychain",
    ],
  });
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

async function ensureUrlReachable(url: string, signal?: AbortSignal): Promise<void> {
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const request = client(
      {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
      },
      (response) => {
        const statusCode: number = response.statusCode ?? 0;
        response.resume();
        if (statusCode >= 200 && statusCode < 400) {
          resolve();
        } else {
          reject(new Error(`HTTP ${statusCode}`));
        }
      },
    );
    const abortListener = (): void => {
      request.destroy(new Error("Aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        abortListener();
      } else {
        signal.addEventListener("abort", abortListener, { once: true });
        request.on("close", () => signal.removeEventListener("abort", abortListener));
      }
    }
    request.on("error", (error: Error) => {
      reject(error);
    });
    request.end();
  }).catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(`Could not reach ${url}. Is your dev server running?`, error);
    throw error instanceof Error ? error : new Error(`URL not reachable: ${url}`);
  });
}

async function performWarmUp(config: ApexConfig, signal?: AbortSignal): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("Performing warm-up requests...");
  const uniqueUrls: Set<string> = new Set();
  for (const page of config.pages) {
    if (signal?.aborted) {
      throw new Error("Aborted");
    }
    const url: string = buildUrl({ baseUrl: config.baseUrl, path: page.path, query: config.query });
    uniqueUrls.add(url);
  }
  const urls: readonly string[] = Array.from(uniqueUrls);
  const warmUpConcurrency: number = Math.max(1, Math.min(4, config.parallel ?? 4));
  const warmUpNextIndex = { value: 0 };
  const warmWorker = async (): Promise<void> => {
    while (warmUpNextIndex.value < urls.length) {
      if (signal?.aborted) {
        throw new Error("Aborted");
      }
      const index: number = warmUpNextIndex.value;
      warmUpNextIndex.value += 1;
      const url: string = urls[index];
      try {
        await fetchUrl(url, signal);
      } catch {
        // Ignore warm-up errors, the actual audit will catch real issues
      }
    }
  };
  await Promise.all(new Array(warmUpConcurrency).fill(0).map(async () => warmWorker()));
  // eslint-disable-next-line no-console
  console.log(`Warm-up complete (${uniqueUrls.size} pages).`);
}

async function fetchUrl(url: string, signal?: AbortSignal): Promise<void> {
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  await new Promise<void>((resolve, reject) => {
    const request = client(
      {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
      },
      (response) => {
        response.resume();
        resolve();
      },
    );
    const abortListener = (): void => {
      request.destroy(new Error("Aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        abortListener();
      } else {
        signal.addEventListener("abort", abortListener, { once: true });
        request.on("close", () => signal.removeEventListener("abort", abortListener));
      }
    }
    request.on("error", reject);
    request.end();
  });
}

/**
 * Run audits for all pages defined in the config and return a structured summary.
 */
export async function runAuditsForConfig({
  config,
  configPath,
  showParallel,
  onlyCategories,
  signal,
  onAfterWarmUp,
  onProgress,
}: {
  readonly config: ApexConfig;
  readonly configPath: string;
  readonly showParallel?: boolean;
  readonly onlyCategories?: readonly ApexCategory[];
  readonly signal?: AbortSignal;
  readonly onAfterWarmUp?: () => void;
  readonly onProgress?: (params: { readonly completed: number; readonly total: number; readonly path: string; readonly device: ApexDevice; readonly etaMs?: number }) => void;
}): Promise<RunSummary> {
  const runs: number = 1;
  if (config.runs !== undefined && config.runs !== 1) {
    throw new Error("Multi-run mode is no longer supported. Set runs=1 and rerun the command multiple times for comparisons.");
  }
  const firstPage = config.pages[0];
  const healthCheckUrl: string = buildUrl({ baseUrl: config.baseUrl, path: firstPage.path, query: config.query });
  if (signal?.aborted) {
    throw new Error("Aborted");
  }
  await ensureUrlReachable(healthCheckUrl, signal);
  // Perform warm-up requests if enabled
  if (config.warmUp) {
    await performWarmUp(config, signal);
  }
  if (typeof onAfterWarmUp === "function") {
    onAfterWarmUp();
  }
  const throttlingMethod: ApexThrottlingMethod = config.throttlingMethod ?? "simulate";
  const cpuSlowdownMultiplier: number = config.cpuSlowdownMultiplier ?? 4;
  const logLevel = config.logLevel ?? "error";
  const auditTimeoutMs: number = config.auditTimeoutMs ?? DEFAULT_WORKER_TASK_TIMEOUT_MS;

  const incrementalEnabled: boolean = config.incremental === true && typeof config.buildId === "string" && config.buildId.length > 0;
  const cache: IncrementalCache | undefined = incrementalEnabled ? await loadIncrementalCache() : undefined;
  const cacheEntries: Record<string, PageDeviceSummary> = cache?.entries ?? {};

  // Build list of all audit tasks
  const tasks: AuditTask[] = [];
  for (const page of config.pages) {
    for (const device of page.devices) {
      const url: string = buildUrl({ baseUrl: config.baseUrl, path: page.path, query: config.query });
      tasks.push({
        url,
        path: page.path,
        label: page.label,
        device,
        runs,
        logLevel,
        throttlingMethod,
        cpuSlowdownMultiplier,
        onlyCategories,
      });
    }
  }

  const results: PageDeviceSummary[] = new Array(tasks.length);
  const tasksToRun: AuditTask[] = [];
  const taskIndexByRunIndex: number[] = [];
  let cachedSteps = 0;
  let cachedCombos = 0;
  if (incrementalEnabled) {
    for (let i = 0; i < tasks.length; i += 1) {
      const task: AuditTask = tasks[i];
      const key: string = buildCacheKey({
        buildId: config.buildId as string,
        url: task.url,
        path: task.path,
        label: task.label,
        device: task.device,
        runs: task.runs,
        throttlingMethod: task.throttlingMethod,
        cpuSlowdownMultiplier: task.cpuSlowdownMultiplier,
        onlyCategories: task.onlyCategories,
      });
      const cached: PageDeviceSummary | undefined = cacheEntries[key];
      if (cached) {
        results[i] = cached;
        cachedSteps += task.runs;
        cachedCombos += 1;
      } else {
        taskIndexByRunIndex.push(i);
        tasksToRun.push(task);
      }
    }
  } else {
    for (let i = 0; i < tasks.length; i += 1) {
      taskIndexByRunIndex.push(i);
      tasksToRun.push(tasks[i]);
    }
  }

  const startedAtMs: number = Date.now();
  const parallelCount: number = resolveParallelCount({ requested: config.parallel, chromePort: config.chromePort, taskCount: tasksToRun.length });
  if (showParallel === true) {
    // eslint-disable-next-line no-console
    console.log(`Resolved parallel workers: ${parallelCount}`);
  }
  const totalSteps: number = tasks.length * runs;
  const executedCombos: number = tasksToRun.length;
  const executedSteps: number = executedCombos * runs;
  const cachedComboCount: number = cachedCombos;
  let completedSteps = cachedSteps;
  const progressLock = { count: cachedSteps };

  const etaTracker = createEtaTracker({ totalSteps, initialCompleted: cachedSteps, parallel: parallelCount });

  const updateProgress = (path: string, device: ApexDevice): void => {
    progressLock.count += 1;
    completedSteps = progressLock.count;
    const etaMs: number | undefined = etaTracker.recordProgress(completedSteps);
    logProgress({ completed: completedSteps, total: totalSteps, path, device, etaMs });
    if (typeof onProgress === "function") {
      onProgress({ completed: completedSteps, total: totalSteps, path, device, etaMs });
    }
  };

  let resultsFromRunner: PageDeviceSummary[];

  if (tasksToRun.length === 0) {
    resultsFromRunner = [];
  } else if (parallelCount <= 1 || config.chromePort !== undefined) {
    // Sequential execution (original behavior) or using external Chrome
    resultsFromRunner = await runSequential(tasksToRun, config.chromePort, auditTimeoutMs, signal, updateProgress);
  } else {
    resultsFromRunner = await runParallelInProcesses(tasksToRun, parallelCount, auditTimeoutMs, signal, updateProgress);
  }

  for (let runIndex = 0; runIndex < resultsFromRunner.length; runIndex += 1) {
    const originalTaskIndex: number = taskIndexByRunIndex[runIndex];
    results[originalTaskIndex] = resultsFromRunner[runIndex];
  }

  if (incrementalEnabled) {
    const nextEntries: Record<string, PageDeviceSummary> = { ...cacheEntries };
    for (let i = 0; i < tasks.length; i += 1) {
      const task: AuditTask = tasks[i];
      const key: string = buildCacheKey({
        buildId: config.buildId as string,
        url: task.url,
        path: task.path,
        label: task.label,
        device: task.device,
        runs: task.runs,
        throttlingMethod: task.throttlingMethod,
        cpuSlowdownMultiplier: task.cpuSlowdownMultiplier,
        onlyCategories: task.onlyCategories,
      });
      nextEntries[key] = results[i];
    }
    await saveIncrementalCache({ version: CACHE_VERSION, entries: nextEntries });
  }

  const completedAtMs: number = Date.now();
  const elapsedMs: number = completedAtMs - startedAtMs;
  const averageStepMs: number = totalSteps > 0 ? elapsedMs / totalSteps : 0;
  return {
    meta: {
      configPath,
      buildId: typeof config.buildId === "string" ? config.buildId : undefined,
      incremental: incrementalEnabled,
      resolvedParallel: parallelCount,
      totalSteps,
      comboCount: tasks.length,
      executedCombos,
      cachedCombos: cachedComboCount,
      runsPerCombo: runs,
      executedSteps,
      cachedSteps,
      warmUp: config.warmUp === true,
      throttlingMethod,
      cpuSlowdownMultiplier,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      elapsedMs,
      averageStepMs,
    },
    results,
  };
}

async function runSequential(
  tasks: AuditTask[],
  chromePort: number | undefined,
  auditTimeoutMs: number,
  signal: AbortSignal | undefined,
  updateProgress: (path: string, device: ApexDevice) => void,
): Promise<PageDeviceSummary[]> {
  const results: PageDeviceSummary[] = [];
  const sessionRef: { session: ChromeSession } = { session: await createChromeSession(chromePort) };
  try {
    for (const task of tasks) {
      const summaries: PageDeviceSummary[] = [];
      for (let index = 0; index < task.runs; index += 1) {
        if (signal?.aborted) {
          throw new Error("Aborted");
        }
        const summary: PageDeviceSummary = await withTimeout(
          runSingleAudit({
            url: task.url,
            path: task.path,
            label: task.label,
            device: task.device,
            port: sessionRef.session.port,
            logLevel: task.logLevel,
            throttlingMethod: task.throttlingMethod,
            cpuSlowdownMultiplier: task.cpuSlowdownMultiplier,
            onlyCategories: task.onlyCategories,
          }),
          auditTimeoutMs,
        ).catch(async (error: unknown) => {
          const message: string = error instanceof Error ? error.message : "Unknown error";
          logLinePreservingProgress(`Timeout: ${task.path} [${task.device}] (run ${index + 1}/${task.runs}). Retrying... (${message})`);
          if (sessionRef.session.close) {
            await sessionRef.session.close();
          }
          sessionRef.session = await createChromeSession(chromePort);
          return withTimeout(
            runSingleAudit({
              url: task.url,
              path: task.path,
              label: task.label,
              device: task.device,
              port: sessionRef.session.port,
              logLevel: task.logLevel,
              throttlingMethod: task.throttlingMethod,
              cpuSlowdownMultiplier: task.cpuSlowdownMultiplier,
              onlyCategories: task.onlyCategories,
            }),
            auditTimeoutMs,
          ).catch((secondError: unknown) => {
            const secondMessage: string = secondError instanceof Error ? secondError.message : "Unknown error";
            logLinePreservingProgress(`Giving up: ${task.path} [${task.device}] (run ${index + 1}/${task.runs}) after timeout retry.`);
            return buildFailureSummary(task, secondMessage);
          });
        });
        summaries.push(summary);
        updateProgress(task.path, task.device);
      }
      results.push(aggregateSummaries(summaries));
    }
  } finally {
    if (sessionRef.session.close) {
      await sessionRef.session.close();
    }
  }
  return results;
}

async function runParallel(
  tasks: AuditTask[],
  parallelCount: number,
  updateProgress: (path: string, device: ApexDevice) => void,
): Promise<PageDeviceSummary[]> {
  // Create a pool of Chrome sessions
  const sessions: { session: ChromeSession }[] = [];
  const effectiveParallel: number = Math.min(parallelCount, tasks.length);
  
  for (let i = 0; i < effectiveParallel; i += 1) {
    if (i > 0) {
      await delayMs(200 * i);
    }
    sessions.push({ session: await createChromeSession() });
  }

  const results: PageDeviceSummary[] = new Array(tasks.length);
  let taskIndex = 0;

  const runWorker = async (sessionRef: { session: ChromeSession }, workerIndex: number): Promise<void> => {
    while (taskIndex < tasks.length) {
      const currentIndex = taskIndex;
      taskIndex += 1;
      const task = tasks[currentIndex];
      
      const summaries: PageDeviceSummary[] = [];
      for (let run = 0; run < task.runs; run += 1) {
        const summary: PageDeviceSummary = await runSingleAuditWithRetry({
          task,
          sessionRef,
          updateProgress,
          maxRetries: 2,
        });
        summaries.push(summary);
        updateProgress(task.path, task.device);
      }
      results[currentIndex] = aggregateSummaries(summaries);
    }
  };

  try {
    await Promise.all(sessions.map((sessionRef, index) => runWorker(sessionRef, index)));
  } finally {
    // Close all Chrome sessions
    await Promise.all(
      sessions.map(async (sessionRef) => {
        if (sessionRef.session.close) {
          await sessionRef.session.close();
        }
      }),
    );
  }

  return results;
}

function isTransientLighthouseError(error: unknown): boolean {
  const message: string = error instanceof Error && typeof error.message === "string" ? error.message : "";
  return (
    message.includes("performance mark has not been set") ||
    message.includes("TargetCloseError") ||
    message.includes("Target closed") ||
    message.includes("setAutoAttach") ||
    message.includes("LanternError") ||
    message.includes("top level events") ||
    message.includes("CDP") ||
    message.includes("disconnected")
  );
}

async function runSingleAuditWithRetry({
  task,
  sessionRef,
  updateProgress,
  maxRetries,
}: {
  readonly task: AuditTask;
  readonly sessionRef: { session: ChromeSession };
  readonly updateProgress: (path: string, device: ApexDevice) => void;
  readonly maxRetries: number;
}): Promise<PageDeviceSummary> {
  let attempt = 0;
  let lastError: unknown;
  while (attempt <= maxRetries) {
    try {
      return await runSingleAudit({
        url: task.url,
        path: task.path,
        label: task.label,
        device: task.device,
        port: sessionRef.session.port,
        logLevel: task.logLevel,
        throttlingMethod: task.throttlingMethod,
        cpuSlowdownMultiplier: task.cpuSlowdownMultiplier,
        onlyCategories: task.onlyCategories,
      });
    } catch (error: unknown) {
      lastError = error;
      const shouldRetry: boolean = isTransientLighthouseError(error) && attempt < maxRetries;
      if (!shouldRetry) {
        throw error instanceof Error ? error : new Error("Lighthouse failed");
      }
      if (sessionRef.session.close) {
        await sessionRef.session.close();
      }
      await delayMs(300 * (attempt + 1));
      sessionRef.session = await createChromeSession();
      attempt += 1;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Lighthouse failed after retries");
}

function buildUrl({ baseUrl, path, query }: { baseUrl: string; path: string; query?: string }): string {
  const cleanBase: string = baseUrl.replace(/\/$/, "");
  const cleanPath: string = path.startsWith("/") ? path : `/${path}`;
  const queryPart: string = query && query.length > 0 ? query : "";
  return `${cleanBase}${cleanPath}${queryPart}`;
}

function logProgress({
  completed,
  total,
  path,
  device,
  etaMs,
}: {
  readonly completed: number;
  readonly total: number;
  readonly path: string;
  readonly device: ApexDevice;
  readonly etaMs?: number;
}): void {
  const percentage: number = total > 0 ? Math.round((completed / total) * 100) : 0;
  const etaText: string = etaMs !== undefined ? ` | ETA ${formatEta(etaMs)}` : "";
  const message: string = `Running audits ${completed}/${total} (${percentage}%) – ${path} [${device}]${etaText}`;
  if (typeof process !== "undefined" && process.stdout && typeof process.stdout.write === "function" && process.stdout.isTTY) {
    const padded: string = message.padEnd(100, " ");
    lastProgressLine = padded;
    process.stdout.write(`\r${padded}`);
    if (completed === total) {
      process.stdout.write("\n");
      lastProgressLine = undefined;
    }
    return;
  }
  // eslint-disable-next-line no-console
  console.log(message);
}

async function runSingleAudit(params: RunAuditParams): Promise<PageDeviceSummary> {
  const options: Record<string, unknown> = {
    port: params.port,
    output: "json" as const,
    logLevel: params.logLevel,
    onlyCategories: ["performance", "accessibility", "best-practices", "seo"] as const,
    formFactor: params.device,
    throttlingMethod: params.throttlingMethod,
    screenEmulation: params.device === "mobile"
      ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }
      : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
  };
  if (params.throttlingMethod === "simulate") {
    options.throttling = {
      cpuSlowdownMultiplier: params.cpuSlowdownMultiplier,
      rttMs: 150,
      throughputKbps: 1638.4,
      requestLatencyMs: 150 * 3.75,
      downloadThroughputKbps: 1638.4,
      uploadThroughputKbps: 750,
    };
  }
  const runnerResult = await lighthouse(params.url, options);
  const lhrUnknown: unknown = runnerResult.lhr as unknown;
  if (!lhrUnknown || typeof lhrUnknown !== "object") {
    throw new Error("Lighthouse did not return a valid result");
  }
  const lhr: LighthouseResultLike = lhrUnknown as LighthouseResultLike;
  const scores: CategoryScores = extractScores(lhr);
  const metrics: MetricValues = extractMetrics(lhr);
  const opportunities: readonly OpportunitySummary[] = extractTopOpportunities(lhr, 3);
  return {
    url: lhr.finalDisplayedUrl ?? params.url,
    path: params.path,
    label: params.label,
    device: params.device,
    scores,
    metrics,
    opportunities,
    runtimeErrorCode: typeof lhr.runtimeError?.code === "string" ? lhr.runtimeError.code : undefined,
    runtimeErrorMessage: typeof lhr.runtimeError?.message === "string" ? lhr.runtimeError.message : undefined,
  };
}

function extractScores(lhr: LighthouseResultLike): CategoryScores {
  const performanceScore: number | undefined = lhr.categories.performance?.score;
  const accessibilityScore: number | undefined = lhr.categories.accessibility?.score;
  const bestPracticesScore: number | undefined = lhr.categories["best-practices"]?.score;
  const seoScore: number | undefined = lhr.categories.seo?.score;
  return {
    performance: normaliseScore(performanceScore),
    accessibility: normaliseScore(accessibilityScore),
    bestPractices: normaliseScore(bestPracticesScore),
    seo: normaliseScore(seoScore),
  };
}

function normaliseScore(score: number | undefined): number | undefined {
  if (typeof score !== "number") {
    return undefined;
  }
  return Math.round(score * 100);
}

function extractMetrics(lhr: LighthouseResultLike): MetricValues {
  const audits = lhr.audits;
  const lcpAudit = audits["largest-contentful-paint"] as LighthouseAuditLike | undefined;
  const fcpAudit = audits["first-contentful-paint"] as LighthouseAuditLike | undefined;
  const tbtAudit = audits["total-blocking-time"] as LighthouseAuditLike | undefined;
  const clsAudit = audits["cumulative-layout-shift"] as LighthouseAuditLike | undefined;
  const inpAudit = audits["interaction-to-next-paint"] as LighthouseAuditLike | undefined;
  const lcpMs: number | undefined = typeof lcpAudit?.numericValue === "number" ? lcpAudit.numericValue : undefined;
  const fcpMs: number | undefined = typeof fcpAudit?.numericValue === "number" ? fcpAudit.numericValue : undefined;
  const tbtMs: number | undefined = typeof tbtAudit?.numericValue === "number" ? tbtAudit.numericValue : undefined;
  const cls: number | undefined = typeof clsAudit?.numericValue === "number" ? clsAudit.numericValue : undefined;
  const inpMs: number | undefined = typeof inpAudit?.numericValue === "number" ? inpAudit.numericValue : undefined;
  return {
    lcpMs,
    fcpMs,
    tbtMs,
    cls,
    inpMs,
  };
}

function extractTopOpportunities(lhr: LighthouseResultLike, limit: number): readonly OpportunitySummary[] {
  const audits: LighthouseAuditLike[] = Object.values(lhr.audits) as LighthouseAuditLike[];
  const candidates: OpportunitySummary[] = audits
    .filter((audit) => audit.details?.type === "opportunity")
    .map((audit) => {
      const savingsMs: number | undefined = audit.details?.overallSavingsMs;
      const savingsBytes: number | undefined = audit.details?.overallSavingsBytes;
      return {
        id: audit.id ?? "unknown",
        title: audit.title ?? (audit.id ?? "Unknown"),
        estimatedSavingsMs: typeof savingsMs === "number" ? savingsMs : undefined,
        estimatedSavingsBytes: typeof savingsBytes === "number" ? savingsBytes : undefined,
      };
    });
  candidates.sort((a, b) => (b.estimatedSavingsMs ?? 0) - (a.estimatedSavingsMs ?? 0));
  return candidates.slice(0, limit);
}

function aggregateSummaries(summaries: PageDeviceSummary[]): PageDeviceSummary {
  if (summaries.length === 1) {
    return summaries[0];
  }
  const base = summaries[0];
  const count: number = summaries.length;
  const aggregateScores: CategoryScores = {
    performance: averageOf(summaries.map((s) => s.scores.performance)),
    accessibility: averageOf(summaries.map((s) => s.scores.accessibility)),
    bestPractices: averageOf(summaries.map((s) => s.scores.bestPractices)),
    seo: averageOf(summaries.map((s) => s.scores.seo)),
  };
  const aggregateMetrics: MetricValues = {
    lcpMs: averageOf(summaries.map((s) => s.metrics.lcpMs)),
    fcpMs: averageOf(summaries.map((s) => s.metrics.fcpMs)),
    tbtMs: averageOf(summaries.map((s) => s.metrics.tbtMs)),
    cls: averageOf(summaries.map((s) => s.metrics.cls)),
    inpMs: averageOf(summaries.map((s) => s.metrics.inpMs)),
  };
  const opportunities: readonly OpportunitySummary[] = summaries[0].opportunities;
  return {
    url: base.url,
    path: base.path,
    label: base.label,
    device: base.device,
    scores: aggregateScores,
    metrics: aggregateMetrics,
    opportunities,
    runtimeErrorCode: base.runtimeErrorCode,
    runtimeErrorMessage: base.runtimeErrorMessage,
  };
}

function averageOf(values: (number | undefined)[]): number | undefined {
  const defined: number[] = values.filter((v): v is number => typeof v === "number");
  if (defined.length === 0) {
    return undefined;
  }
  const total: number = defined.reduce((sum, value) => sum + value, 0);
  return total / defined.length;
}

function resolveParallelCount({
  requested,
  chromePort,
  taskCount,
}: {
  readonly requested: number | undefined;
  readonly chromePort: number | undefined;
  readonly taskCount: number;
}): number {
  if (chromePort !== undefined) {
    return 1;
  }
  if (requested !== undefined) {
    return requested;
  }
  const logicalCpus: number = cpus().length;
  const cpuBased: number = Math.max(1, Math.min(10, Math.floor(logicalCpus * 0.75)));
  const memoryBased: number = Math.max(1, Math.min(10, Math.floor(freemem() / 1_500_000_000)));
  const suggested: number = Math.max(1, Math.min(cpuBased, memoryBased));
  const cappedSuggested: number = Math.min(4, suggested || 1);
  return Math.max(1, Math.min(10, Math.min(taskCount, cappedSuggested)));
}

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

function createEtaTracker(params: { readonly totalSteps: number; readonly initialCompleted: number; readonly parallel: number }): {
  readonly recordProgress: (completedSteps: number) => number | undefined;
} {
  const windowSize: number = Math.max(8, Math.min(40, params.parallel * 10));
  const minimumSamples: number = Math.max(4, Math.min(12, params.parallel * 3));
  const minimumElapsedMs: number = 5_000;
  const minimumDeltaMs: number = 250;
  const ratesPerSecond: number[] = [];
  const startedAtMs: number = Date.now();
  let lastAtMs: number | undefined;
  let lastCompleted: number | undefined;

  const recordProgress = (completedSteps: number): number | undefined => {
    if (completedSteps <= params.initialCompleted) {
      return undefined;
    }
    const nowMs: number = Date.now();
    if (lastAtMs !== undefined && lastCompleted !== undefined) {
      const completedDelta: number = completedSteps - lastCompleted;
      const elapsedDeltaMs: number = nowMs - lastAtMs;
      if (completedDelta > 0 && elapsedDeltaMs >= minimumDeltaMs) {
        const perSecond: number = (completedDelta * 1000) / elapsedDeltaMs;
        if (Number.isFinite(perSecond) && perSecond > 0) {
          ratesPerSecond.push(perSecond);
          if (ratesPerSecond.length > windowSize) {
            ratesPerSecond.shift();
          }
        }
      }
    }
    lastAtMs = nowMs;
    lastCompleted = completedSteps;
    const elapsedSinceStartMs: number = nowMs - startedAtMs;
    if (elapsedSinceStartMs < minimumElapsedMs) {
      return undefined;
    }
    if (ratesPerSecond.length < minimumSamples) {
      return undefined;
    }
    const medianRate: number = computeMedian(ratesPerSecond);
    if (!Number.isFinite(medianRate) || medianRate <= 0) {
      return undefined;
    }
    const remainingSteps: number = Math.max(0, params.totalSteps - completedSteps);
    const etaSeconds: number = remainingSteps / medianRate;
    return Math.max(0, Math.round(etaSeconds * 1000));
  };

  return { recordProgress };
}

function formatEta(etaMs: number): string {
  const totalSeconds: number = Math.ceil(etaMs / 1000);
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  const minutesPart: string = minutes > 0 ? `${minutes}m ` : "";
  const secondsPart: string = `${seconds}s`;
  return `${minutesPart}${secondsPart}`.trim();
}

function delayMs(duration: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
}
