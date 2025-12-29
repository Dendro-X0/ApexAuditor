import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { cpus, freemem } from "node:os";
import lighthouse from "lighthouse";
import { launch as launchChrome } from "chrome-launcher";
import type { ApexConfig, ApexDevice, ApexThrottlingMethod, MetricValues, CategoryScores, OpportunitySummary, PageDeviceSummary, RunSummary } from "./types.js";

interface ChromeSession {
  readonly port: number;
  readonly close?: () => Promise<void>;
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
}

async function createChromeSession(chromePort?: number): Promise<ChromeSession> {
  if (typeof chromePort === "number") {
    return { port: chromePort };
  }
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
      } catch {
        return;
      }
    },
  };
}

async function ensureUrlReachable(url: string): Promise<void> {
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

async function performWarmUp(config: ApexConfig): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("Performing warm-up requests...");
  const uniqueUrls: Set<string> = new Set();
  for (const page of config.pages) {
    const url: string = buildUrl({ baseUrl: config.baseUrl, path: page.path, query: config.query });
    uniqueUrls.add(url);
  }
  // Make parallel warm-up requests to all unique URLs
  const warmUpPromises: Promise<void>[] = Array.from(uniqueUrls).map(async (url) => {
    try {
      await fetchUrl(url);
    } catch {
      // Ignore warm-up errors, the actual audit will catch real issues
    }
  });
  await Promise.all(warmUpPromises);
  // eslint-disable-next-line no-console
  console.log(`Warm-up complete (${uniqueUrls.size} pages).`);
}

async function fetchUrl(url: string): Promise<void> {
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
}: {
  readonly config: ApexConfig;
  readonly configPath: string;
  readonly showParallel?: boolean;
}): Promise<RunSummary> {
  const runs: number = config.runs ?? 1;
  const firstPage = config.pages[0];
  const healthCheckUrl: string = buildUrl({ baseUrl: config.baseUrl, path: firstPage.path, query: config.query });
  await ensureUrlReachable(healthCheckUrl);
  // Perform warm-up requests if enabled
  if (config.warmUp) {
    await performWarmUp(config);
  }
  const throttlingMethod: ApexThrottlingMethod = config.throttlingMethod ?? "simulate";
  const cpuSlowdownMultiplier: number = config.cpuSlowdownMultiplier ?? 4;
  const logLevel = config.logLevel ?? "error";

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
      });
    }
  }

  const startedAtMs: number = Date.now();
  const parallelCount: number = resolveParallelCount({ requested: config.parallel, chromePort: config.chromePort, taskCount: tasks.length });
  if (showParallel === true) {
    // eslint-disable-next-line no-console
    console.log(`Resolved parallel workers: ${parallelCount}`);
  }
  const totalSteps: number = tasks.length * runs;
  let completedSteps = 0;
  const progressLock = { count: 0 };

  const updateProgress = (path: string, device: ApexDevice): void => {
    progressLock.count += 1;
    completedSteps = progressLock.count;
    const etaMs: number | undefined = computeEtaMs({ startedAtMs, completed: completedSteps, total: totalSteps });
    logProgress({ completed: completedSteps, total: totalSteps, path, device, etaMs });
  };

  let results: PageDeviceSummary[];

  if (parallelCount <= 1 || config.chromePort !== undefined) {
    // Sequential execution (original behavior) or using external Chrome
    results = await runSequential(tasks, config.chromePort, updateProgress);
  } else {
    // Parallel execution with multiple Chrome instances
    results = await runParallel(tasks, parallelCount, updateProgress);
  }

  const completedAtMs: number = Date.now();
  const elapsedMs: number = completedAtMs - startedAtMs;
  const averageStepMs: number = totalSteps > 0 ? elapsedMs / totalSteps : 0;
  return {
    meta: {
      configPath,
      resolvedParallel: parallelCount,
      totalSteps,
      comboCount: tasks.length,
      runsPerCombo: runs,
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
  updateProgress: (path: string, device: ApexDevice) => void,
): Promise<PageDeviceSummary[]> {
  const results: PageDeviceSummary[] = [];
  const session: ChromeSession = await createChromeSession(chromePort);
  try {
    for (const task of tasks) {
      const summaries: PageDeviceSummary[] = [];
      for (let index = 0; index < task.runs; index += 1) {
        const summary: PageDeviceSummary = await runSingleAudit({
          url: task.url,
          path: task.path,
          label: task.label,
          device: task.device,
          port: session.port,
          logLevel: task.logLevel,
          throttlingMethod: task.throttlingMethod,
          cpuSlowdownMultiplier: task.cpuSlowdownMultiplier,
        });
        summaries.push(summary);
        updateProgress(task.path, task.device);
      }
      results.push(aggregateSummaries(summaries));
    }
  } finally {
    if (session.close) {
      await session.close();
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
  const sessions: ChromeSession[] = [];
  const effectiveParallel: number = Math.min(parallelCount, tasks.length);
  
  for (let i = 0; i < effectiveParallel; i += 1) {
    sessions.push(await createChromeSession());
  }

  const results: PageDeviceSummary[] = new Array(tasks.length);
  let taskIndex = 0;

  const runWorker = async (session: ChromeSession, workerIndex: number): Promise<void> => {
    while (taskIndex < tasks.length) {
      const currentIndex = taskIndex;
      taskIndex += 1;
      const task = tasks[currentIndex];
      
      const summaries: PageDeviceSummary[] = [];
      for (let run = 0; run < task.runs; run += 1) {
        const summary: PageDeviceSummary = await runSingleAudit({
          url: task.url,
          path: task.path,
          label: task.label,
          device: task.device,
          port: session.port,
          logLevel: task.logLevel,
          throttlingMethod: task.throttlingMethod,
          cpuSlowdownMultiplier: task.cpuSlowdownMultiplier,
        });
        summaries.push(summary);
        updateProgress(task.path, task.device);
      }
      results[currentIndex] = aggregateSummaries(summaries);
    }
  };

  try {
    await Promise.all(sessions.map((session, index) => runWorker(session, index)));
  } finally {
    // Close all Chrome sessions
    await Promise.all(
      sessions.map(async (session) => {
        if (session.close) {
          await session.close();
        }
      }),
    );
  }

  return results;
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
    const padded: string = message.padEnd(80, " ");
    process.stdout.write(`\r${padded}`);
    if (completed === total) {
      process.stdout.write("\n");
    }
    return;
  }
  // eslint-disable-next-line no-console
  console.log(message);
}

async function runSingleAudit(params: RunAuditParams): Promise<PageDeviceSummary> {
  const options = {
    port: params.port,
    output: "json" as const,
    logLevel: params.logLevel,
    onlyCategories: ["performance", "accessibility", "best-practices", "seo"] as const,
    formFactor: params.device,
    // Throttling configuration for more accurate results
    throttlingMethod: params.throttlingMethod,
    throttling: {
      // CPU throttling - adjustable via config
      cpuSlowdownMultiplier: params.cpuSlowdownMultiplier,
      // Network throttling (Slow 4G / Fast 3G preset - Lighthouse default)
      rttMs: 150,
      throughputKbps: 1638.4,
      requestLatencyMs: 150 * 3.75,
      downloadThroughputKbps: 1638.4,
      uploadThroughputKbps: 750,
    },
    screenEmulation: params.device === "mobile"
      ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }
      : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
  };
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
  const cpuBased: number = Math.max(1, Math.min(6, Math.floor(cpus().length / 2)));
  const memoryBased: number = Math.max(1, Math.min(6, Math.floor(freemem() / 1_500_000_000)));
  const suggested: number = Math.max(1, Math.min(cpuBased, memoryBased));
  return Math.max(1, Math.min(10, Math.min(taskCount, suggested || 1)));
}

function computeEtaMs({
  startedAtMs,
  completed,
  total,
}: {
  readonly startedAtMs: number;
  readonly completed: number;
  readonly total: number;
}): number | undefined {
  if (completed === 0 || total === 0 || completed > total) {
    return undefined;
  }
  const elapsedMs: number = Date.now() - startedAtMs;
  const averagePerStep: number = elapsedMs / completed;
  const remainingSteps: number = total - completed;
  return Math.max(0, Math.round(averagePerStep * remainingSteps));
}

function formatEta(etaMs: number): string {
  const totalSeconds: number = Math.ceil(etaMs / 1000);
  const minutes: number = Math.floor(totalSeconds / 60);
  const seconds: number = totalSeconds % 60;
  const minutesPart: string = minutes > 0 ? `${minutes}m ` : "";
  const secondsPart: string = `${seconds}s`;
  return `${minutesPart}${secondsPart}`.trim();
}
