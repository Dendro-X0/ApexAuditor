import lighthouse from "lighthouse";
import chromeLauncher from "chrome-launcher";
import type { ApexConfig, ApexDevice, MetricValues, CategoryScores, OpportunitySummary, PageDeviceSummary, RunSummary } from "./types.js";

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
}

interface RunAuditParams {
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
  readonly port: number;
}

async function createChromeSession(chromePort?: number): Promise<ChromeSession> {
  if (typeof chromePort === "number") {
    return { port: chromePort };
  }
  const chrome = await chromeLauncher.launch({
    chromeFlags: [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--disable-default-apps",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  return {
    port: chrome.port,
    close: async () => {
      await chrome.kill();
    },
  };
}

/**
 * Run audits for all pages defined in the config and return a structured summary.
 */
export async function runAuditsForConfig({
  config,
  configPath,
}: {
  readonly config: ApexConfig;
  readonly configPath: string;
}): Promise<RunSummary> {
  const runs: number = config.runs ?? 1;
  const results: PageDeviceSummary[] = [];
  const session: ChromeSession = await createChromeSession(config.chromePort);
  try {
    for (const page of config.pages) {
      for (const device of page.devices) {
        const url: string = buildUrl({ baseUrl: config.baseUrl, path: page.path, query: config.query });
        const summaries: PageDeviceSummary[] = [];
        for (let index = 0; index < runs; index += 1) {
          const summary: PageDeviceSummary = await runSingleAudit({
            url,
            path: page.path,
            label: page.label,
            device,
            port: session.port,
          });
          summaries.push(summary);
        }
        results.push(aggregateSummaries(summaries));
      }
    }
  } finally {
    if (session.close) {
      await session.close();
    }
  }
  return { configPath, results };
}

function buildUrl({ baseUrl, path, query }: { baseUrl: string; path: string; query?: string }): string {
  const cleanBase: string = baseUrl.replace(/\/$/, "");
  const cleanPath: string = path.startsWith("/") ? path : `/${path}`;
  const queryPart: string = query && query.length > 0 ? query : "";
  return `${cleanBase}${cleanPath}${queryPart}`;
}

async function runSingleAudit(params: RunAuditParams): Promise<PageDeviceSummary> {
  const options = {
    port: params.port,
    output: "json" as const,
    logLevel: "error" as const,
    onlyCategories: ["performance", "accessibility", "best-practices", "seo"] as const,
    emulatedFormFactor: params.device,
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
  const lcpMs: number | undefined = typeof lcpAudit?.numericValue === "number" ? lcpAudit.numericValue : undefined;
  const fcpMs: number | undefined = typeof fcpAudit?.numericValue === "number" ? fcpAudit.numericValue : undefined;
  const tbtMs: number | undefined = typeof tbtAudit?.numericValue === "number" ? tbtAudit.numericValue : undefined;
  const cls: number | undefined = typeof clsAudit?.numericValue === "number" ? clsAudit.numericValue : undefined;
  return {
    lcpMs,
    fcpMs,
    tbtMs,
    cls,
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
