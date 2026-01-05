import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ApexBudgets, ApexConfig, ApexPageScope, ApexThrottlingMethod, CategoryBudgetThresholds, MetricBudgetThresholds } from "./types.js";

/**
 * Load and minimally validate the ApexAuditor configuration file.
 */
export async function loadConfig({ configPath }: { configPath: string }): Promise<{
  readonly configPath: string;
  readonly config: ApexConfig;
}> {
  const absolutePath: string = resolve(configPath);
  const raw: string = await readFile(absolutePath, "utf8");
  const parsed: unknown = JSON.parse(raw) as unknown;
  const config: ApexConfig = normaliseConfig(parsed, absolutePath);
  return { configPath: absolutePath, config };
}

function normaliseConfig(input: unknown, absolutePath: string): ApexConfig {
  if (!input || typeof input !== "object") {
    throw new Error(`Invalid config at ${absolutePath}: expected object`);
  }
  const maybeConfig = input as {
    readonly baseUrl?: unknown;
    readonly query?: unknown;
    readonly buildId?: unknown;
    readonly chromePort?: unknown;
    readonly runs?: unknown;
    readonly auditTimeoutMs?: unknown;
    readonly gitIgnoreApexAuditorDir?: unknown;
    readonly pages?: unknown;
    readonly logLevel?: unknown;
    readonly throttlingMethod?: unknown;
    readonly cpuSlowdownMultiplier?: unknown;
    readonly parallel?: unknown;
    readonly warmUp?: unknown;
    readonly incremental?: unknown;
    readonly budgets?: unknown;
  };
  if (typeof maybeConfig.baseUrl !== "string" || maybeConfig.baseUrl.length === 0) {
    throw new Error(`Invalid config at ${absolutePath}: baseUrl must be a non-empty string`);
  }
  const pagesInput: unknown = maybeConfig.pages;
  if (!Array.isArray(pagesInput) || pagesInput.length === 0) {
    throw new Error(`Invalid config at ${absolutePath}: pages must be a non-empty array`);
  }
  const pages = pagesInput.map((page, index) => normalisePage(page, index, absolutePath));
  const baseUrl: string = maybeConfig.baseUrl.replace(/\/$/, "");
  const query: string | undefined = typeof maybeConfig.query === "string" ? maybeConfig.query : undefined;
  const buildId: string | undefined = typeof maybeConfig.buildId === "string" && maybeConfig.buildId.length > 0 ? maybeConfig.buildId : undefined;
  const chromePort: number | undefined = typeof maybeConfig.chromePort === "number" ? maybeConfig.chromePort : undefined;
  const runs: number | undefined = typeof maybeConfig.runs === "number" && maybeConfig.runs > 0 ? maybeConfig.runs : undefined;
  if (runs !== undefined && runs !== 1) {
    throw new Error(`Invalid config at ${absolutePath}: runs must be 1 (multi-run mode is no longer supported)`);
  }
  const auditTimeoutMs: number | undefined =
    typeof maybeConfig.auditTimeoutMs === "number" && maybeConfig.auditTimeoutMs > 0
      ? maybeConfig.auditTimeoutMs
      : undefined;
  const gitIgnoreApexAuditorDir: boolean | undefined =
    typeof maybeConfig.gitIgnoreApexAuditorDir === "boolean" ? maybeConfig.gitIgnoreApexAuditorDir : undefined;
  const rawLogLevel: unknown = maybeConfig.logLevel;
  const logLevel: "silent" | "error" | "info" | "verbose" | undefined =
    rawLogLevel === "silent" || rawLogLevel === "error" || rawLogLevel === "info" || rawLogLevel === "verbose"
      ? rawLogLevel
      : undefined;
  const rawThrottlingMethod: unknown = maybeConfig.throttlingMethod;
  const throttlingMethod: ApexThrottlingMethod | undefined =
    rawThrottlingMethod === "simulate" || rawThrottlingMethod === "devtools"
      ? rawThrottlingMethod
      : undefined;
  const rawCpuSlowdown: unknown = maybeConfig.cpuSlowdownMultiplier;
  const cpuSlowdownMultiplier: number | undefined =
    typeof rawCpuSlowdown === "number" && rawCpuSlowdown > 0 && rawCpuSlowdown <= 20
      ? rawCpuSlowdown
      : undefined;
  const rawParallel: unknown = maybeConfig.parallel;
  const parallel: number | undefined =
    typeof rawParallel === "number" && Number.isInteger(rawParallel) && rawParallel >= 1 && rawParallel <= 10
      ? rawParallel
      : undefined;
  const warmUp: boolean | undefined =
    typeof maybeConfig.warmUp === "boolean" ? maybeConfig.warmUp : undefined;
  const incremental: boolean | undefined =
    typeof maybeConfig.incremental === "boolean" ? maybeConfig.incremental : undefined;
  const budgets: ApexBudgets | undefined = normaliseBudgets(maybeConfig.budgets, absolutePath);
  return {
    baseUrl,
    query,
    buildId,
    chromePort,
    runs,
    auditTimeoutMs,
    gitIgnoreApexAuditorDir,
    logLevel,
    throttlingMethod,
    cpuSlowdownMultiplier,
    parallel,
    warmUp,
    incremental,
    pages,
    budgets,
  };
}

function normalisePage(page: unknown, index: number, absolutePath: string) {
  if (!page || typeof page !== "object") {
    throw new Error(`Invalid page at index ${index} in ${absolutePath}: expected object`);
  }
  const maybePage = page as {
    readonly path?: unknown;
    readonly label?: unknown;
    readonly devices?: unknown;
    readonly scope?: unknown;
  };
  if (typeof maybePage.path !== "string" || !maybePage.path.startsWith("/")) {
    throw new Error(`Invalid page at index ${index} in ${absolutePath}: path must start with '/'`);
  }
  const label: string = typeof maybePage.label === "string" && maybePage.label.length > 0
    ? maybePage.label
    : maybePage.path;
  const devicesInput: unknown = maybePage.devices;
  const devices: ("mobile" | "desktop")[] = Array.isArray(devicesInput) && devicesInput.length > 0
    ? devicesInput.map((d, deviceIndex) => {
        if (d !== "mobile" && d !== "desktop") {
          throw new Error(`Invalid device at pages[${index}].devices[${deviceIndex}] in ${absolutePath}`);
        }
        return d;
      })
    : ["mobile"];
  const rawScope: unknown = maybePage.scope;
  const scope: ApexPageScope | undefined = rawScope === "public" || rawScope === "requires-auth" ? rawScope : undefined;
  return {
    path: maybePage.path,
    label,
    devices,
    scope,
  } as const;
}

function normaliseBudgets(input: unknown, absolutePath: string): ApexBudgets | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!input || typeof input !== "object") {
    throw new Error(`Invalid budgets in ${absolutePath}: expected object`);
  }
  const maybeBudgets = input as {
    readonly categories?: unknown;
    readonly metrics?: unknown;
  };
  const categories: CategoryBudgetThresholds | undefined = normaliseCategoryBudgets(maybeBudgets.categories, absolutePath);
  const metrics: MetricBudgetThresholds | undefined = normaliseMetricBudgets(maybeBudgets.metrics, absolutePath);
  if (!categories && !metrics) {
    return undefined;
  }
  return {
    categories,
    metrics,
  };
}

function normaliseCategoryBudgets(input: unknown, absolutePath: string): CategoryBudgetThresholds | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!input || typeof input !== "object") {
    throw new Error(`Invalid budgets.categories in ${absolutePath}: expected object`);
  }
  const maybeCategories = input as {
    readonly performance?: unknown;
    readonly accessibility?: unknown;
    readonly bestPractices?: unknown;
    readonly seo?: unknown;
  };
  const performance: number | undefined = normaliseScoreBudget(maybeCategories.performance, "performance", absolutePath);
  const accessibility: number | undefined = normaliseScoreBudget(maybeCategories.accessibility, "accessibility", absolutePath);
  const bestPractices: number | undefined = normaliseScoreBudget(maybeCategories.bestPractices, "bestPractices", absolutePath);
  const seo: number | undefined = normaliseScoreBudget(maybeCategories.seo, "seo", absolutePath);
  if (
    performance === undefined &&
    accessibility === undefined &&
    bestPractices === undefined &&
    seo === undefined
  ) {
    return undefined;
  }
  return {
    performance,
    accessibility,
    bestPractices,
    seo,
  };
}

function normaliseMetricBudgets(input: unknown, absolutePath: string): MetricBudgetThresholds | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (!input || typeof input !== "object") {
    throw new Error(`Invalid budgets.metrics in ${absolutePath}: expected object`);
  }
  const maybeMetrics = input as {
    readonly lcpMs?: unknown;
    readonly fcpMs?: unknown;
    readonly tbtMs?: unknown;
    readonly cls?: unknown;
    readonly inpMs?: unknown;
  };
  const lcpMs: number | undefined = normaliseMetricBudget(maybeMetrics.lcpMs, "lcpMs", absolutePath);
  const fcpMs: number | undefined = normaliseMetricBudget(maybeMetrics.fcpMs, "fcpMs", absolutePath);
  const tbtMs: number | undefined = normaliseMetricBudget(maybeMetrics.tbtMs, "tbtMs", absolutePath);
  const cls: number | undefined = normaliseMetricBudget(maybeMetrics.cls, "cls", absolutePath);
  const inpMs: number | undefined = normaliseMetricBudget(maybeMetrics.inpMs, "inpMs", absolutePath);
  if (lcpMs === undefined && fcpMs === undefined && tbtMs === undefined && cls === undefined && inpMs === undefined) {
    return undefined;
  }
  return {
    lcpMs,
    fcpMs,
    tbtMs,
    cls,
    inpMs,
  };
}

function normaliseScoreBudget(value: unknown, key: string, absolutePath: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || value < 0 || value > 100) {
    throw new Error(
      `Invalid budgets.categories.${key} in ${absolutePath}: expected number between 0 and 100`,
    );
  }
  return value;
}

function normaliseMetricBudget(value: unknown, key: string, absolutePath: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || value < 0) {
    throw new Error(
      `Invalid budgets.metrics.${key} in ${absolutePath}: expected non-negative number`,
    );
  }
  return value;
}
