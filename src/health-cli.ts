import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { resolve } from "node:path";
import type { ApexConfig } from "./types.js";
import { loadConfig } from "./config.js";
import { buildDevServerGuidanceLines } from "./dev-server-guidance.js";
import { renderPanel } from "./ui/render-panel.js";
import { renderTable } from "./ui/render-table.js";
import { UiTheme } from "./ui/ui-theme.js";
import { stopSpinner } from "./spinner.js";

type HealthArgs = {
  readonly configPath: string;
  readonly parallelOverride?: number;
  readonly timeoutMs: number;
  readonly jsonOutput: boolean;
};

type HealthResult = {
  readonly label: string;
  readonly path: string;
  readonly url: string;
  readonly statusCode?: number;
  readonly ttfbMs?: number;
  readonly totalMs?: number;
  readonly bytes?: number;
  readonly runtimeErrorMessage?: string;
};

type HealthReport = {
  readonly meta: {
    readonly configPath: string;
    readonly baseUrl: string;
    readonly comboCount: number;
    readonly resolvedParallel: number;
    readonly timeoutMs: number;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly elapsedMs: number;
  };
  readonly results: readonly HealthResult[];
};

const NO_COLOR: boolean = Boolean(process.env.NO_COLOR) || process.env.CI === "true";
const theme: UiTheme = new UiTheme({ noColor: NO_COLOR });

function buildUrl(params: { readonly baseUrl: string; readonly path: string; readonly query?: string }): string {
  const cleanBase: string = params.baseUrl.replace(/\/$/, "");
  const cleanPath: string = params.path.startsWith("/") ? params.path : `/${params.path}`;
  const queryPart: string = params.query && params.query.length > 0 ? params.query : "";
  return `${cleanBase}${cleanPath}${queryPart}`;
}

function formatMs(value: number | undefined): string {
  if (value === undefined) {
    return "-";
  }
  return `${Math.round(value)}ms`;
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) {
    return "-";
  }
  const kb: number = value / 1024;
  if (kb < 1024) {
    return `${Math.round(kb)}KB`;
  }
  const mb: number = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

function resolveParallelCount(params: { readonly requested?: number; readonly taskCount: number }): number {
  const requested: number | undefined = params.requested;
  if (requested !== undefined) {
    return Math.max(1, Math.min(20, Math.min(params.taskCount, requested)));
  }
  return Math.max(1, Math.min(10, params.taskCount));
}

function parseArgs(argv: readonly string[]): HealthArgs {
  let configPath: string | undefined;
  let parallelOverride: number | undefined;
  let timeoutMs = 20_000;
  let jsonOutput = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg: string = argv[i];
    if ((arg === "--config" || arg === "-c") && i + 1 < argv.length) {
      configPath = argv[i + 1];
      i += 1;
    } else if (arg === "--parallel" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(value) || value < 1 || value > 50) {
        throw new Error(`Invalid --parallel value: ${argv[i + 1]}. Expected integer between 1 and 50.`);
      }
      parallelOverride = value;
      i += 1;
    } else if (arg === "--timeout-ms" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid --timeout-ms value: ${argv[i + 1]}. Expected positive integer.`);
      }
      timeoutMs = value;
      i += 1;
    } else if (arg === "--json") {
      jsonOutput = true;
    }
  }
  return {
    configPath: configPath ?? "apex.config.json",
    parallelOverride,
    timeoutMs,
    jsonOutput,
  };
}

async function runHttpHealthCheck(params: { readonly url: string; readonly timeoutMs: number }): Promise<{ readonly statusCode: number; readonly ttfbMs: number; readonly totalMs: number; readonly bytes: number }> {
  const startedAtMs: number = Date.now();
  return await new Promise((resolvePromise, rejectPromise) => {
    const u: URL = new URL(params.url);
    const requester = u.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requester(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port.length > 0 ? parseInt(u.port, 10) : undefined,
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: { "user-agent": "apex-auditor/health" },
      },
      (res) => {
        const ttfbMs: number = Date.now() - startedAtMs;
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.on("end", () => {
          const totalMs: number = Date.now() - startedAtMs;
          resolvePromise({ statusCode: res.statusCode ?? 0, ttfbMs, totalMs, bytes });
        });
      },
    );

    req.on("error", (err: unknown) => {
      rejectPromise(err);
    });

    req.setTimeout(params.timeoutMs, () => {
      req.destroy(new Error(`Timed out after ${params.timeoutMs}ms`));
    });

    req.end();
  });
}

async function runWithConcurrency(params: {
  readonly tasks: readonly HealthResult[];
  readonly parallel: number;
  readonly runner: (task: HealthResult) => Promise<HealthResult>;
  readonly signal?: AbortSignal;
}): Promise<readonly HealthResult[]> {
  const results: HealthResult[] = new Array(params.tasks.length);
  const nextIndex = { value: 0 };
  const worker = async (): Promise<void> => {
    while (true) {
      if (params.signal?.aborted) {
        throw new Error("Aborted");
      }
      const index: number = nextIndex.value;
      if (index >= params.tasks.length) {
        return;
      }
      nextIndex.value += 1;
      const task: HealthResult = params.tasks[index];
      results[index] = await params.runner(task);
    }
  };
  const workers: Promise<void>[] = new Array(params.parallel).fill(0).map(async () => worker());
  await Promise.all(workers);
  return results;
}

function buildResultsTable(results: readonly HealthResult[]): string {
  const rows = results.map((r) => {
    const status: string = r.runtimeErrorMessage
      ? theme.red("err")
      : r.statusCode && r.statusCode >= 200 && r.statusCode < 300
        ? theme.green(String(r.statusCode))
        : theme.yellow(String(r.statusCode ?? 0));
    return [r.label, r.path, status, formatMs(r.ttfbMs), formatMs(r.totalMs), formatBytes(r.bytes)] as const;
  });

  if (rows.length === 0) {
    return "";
  }

  return renderTable({ headers: ["Label", "Path", "Status", "TTFB", "Total", "Bytes"], rows });
}

function buildSlowestTable(results: readonly HealthResult[]): string {
  const rows = results
    .filter((r) => typeof r.totalMs === "number")
    .sort((a, b) => (b.totalMs ?? 0) - (a.totalMs ?? 0))
    .slice(0, 10)
    .map((r) => [r.label, r.path, formatMs(r.totalMs), formatMs(r.ttfbMs), formatBytes(r.bytes)] as const);

  if (rows.length === 0) {
    return "";
  }

  return renderTable({ headers: ["Label", "Path", "Total", "TTFB", "Bytes"], rows });
}

function isConnectionErrorMessage(message: string): boolean {
  return message.includes("ECONNREFUSED") || message.includes("ENOTFOUND") || message.includes("EAI_AGAIN") || message.includes("Timed out");
}

export async function runHealthCli(argv: readonly string[], options?: { readonly signal?: AbortSignal }): Promise<void> {
  stopSpinner();
  const args: HealthArgs = parseArgs(argv);
  const startedAtMs: number = Date.now();
  const { configPath, config }: { readonly configPath: string; readonly config: ApexConfig } = await loadConfig({ configPath: args.configPath });

  const targets: readonly HealthResult[] = config.pages.map((p) => {
    const url: string = buildUrl({ baseUrl: config.baseUrl, path: p.path, query: config.query });
    return { label: p.label, path: p.path, url };
  });

  const parallel: number = resolveParallelCount({ requested: args.parallelOverride, taskCount: targets.length });

  const results: readonly HealthResult[] = await runWithConcurrency({
    tasks: targets,
    parallel,
    signal: options?.signal,
    runner: async (t) => {
      if (options?.signal?.aborted) {
        throw new Error("Aborted");
      }
      try {
        const r = await runHttpHealthCheck({ url: t.url, timeoutMs: args.timeoutMs });
        return { ...t, statusCode: r.statusCode, ttfbMs: r.ttfbMs, totalMs: r.totalMs, bytes: r.bytes };
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        return { ...t, runtimeErrorMessage: message };
      }
    },
  });

  const completedAtMs: number = Date.now();
  const report: HealthReport = {
    meta: {
      configPath,
      baseUrl: config.baseUrl,
      comboCount: results.length,
      resolvedParallel: parallel,
      timeoutMs: args.timeoutMs,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      elapsedMs: completedAtMs - startedAtMs,
    },
    results,
  };

  const outputDir: string = resolve(".apex-auditor");
  const outputPath: string = resolve(outputDir, "health.json");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  if (args.jsonOutput) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const errorCount: number = results.filter((r) => Boolean(r.runtimeErrorMessage)).length;
  const okCount: number = results.filter((r) => (r.statusCode ?? 0) >= 200 && (r.statusCode ?? 0) < 300).length;

  if (errorCount === results.length) {
    const messages: readonly string[] = results
      .map((r) => r.runtimeErrorMessage)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    const first: string = messages[0] ?? "";
    if (first.length > 0 && isConnectionErrorMessage(first)) {
      const lines: readonly string[] = await buildDevServerGuidanceLines({ projectRoot: resolve(configPath, ".."), baseUrl: config.baseUrl });
      // eslint-disable-next-line no-console
      console.log(renderPanel({ title: theme.bold("Dev server"), lines }));
    }
  }

  const lines: readonly string[] = [
    `Config: ${configPath}`,
    `Base URL: ${config.baseUrl}`,
    `Targets: ${results.length}`,
    `Parallel: ${parallel}`,
    `Timeout: ${args.timeoutMs}ms`,
    `OK: ${okCount}`,
    `Errors: ${errorCount}`,
    `Output: .apex-auditor/health.json`,
  ];

  // eslint-disable-next-line no-console
  console.log(renderPanel({ title: theme.bold("Health"), lines }));

  const table: string = buildResultsTable(results);
  if (table.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n${theme.bold("Results")}`);
    // eslint-disable-next-line no-console
    console.log(table);
  }

  const slow: string = buildSlowestTable(results);
  if (slow.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n${theme.bold("Slowest (top 10)")}`);
    // eslint-disable-next-line no-console
    console.log(slow);
  }
}
