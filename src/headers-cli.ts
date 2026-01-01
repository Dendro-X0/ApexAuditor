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

type HeadersArgs = {
  readonly configPath: string;
  readonly parallelOverride?: number;
  readonly timeoutMs: number;
  readonly jsonOutput: boolean;
};

type SecurityHeaderKey =
  | "content-security-policy"
  | "strict-transport-security"
  | "x-content-type-options"
  | "x-frame-options"
  | "referrer-policy"
  | "permissions-policy"
  | "cross-origin-opener-policy"
  | "cross-origin-resource-policy"
  | "cross-origin-embedder-policy";

type HeaderCheckResult = {
  readonly label: string;
  readonly path: string;
  readonly url: string;
  readonly statusCode?: number;
  readonly missing: readonly SecurityHeaderKey[];
  readonly present: readonly SecurityHeaderKey[];
  readonly runtimeErrorMessage?: string;
};

type HeadersReport = {
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
  readonly results: readonly HeaderCheckResult[];
};

const NO_COLOR: boolean = Boolean(process.env.NO_COLOR) || process.env.CI === "true";
const theme: UiTheme = new UiTheme({ noColor: NO_COLOR });

const MAX_MISSING_HEADERS_DISPLAY: number = 5;

function buildUrl(params: { readonly baseUrl: string; readonly path: string; readonly query?: string }): string {
  const cleanBase: string = params.baseUrl.replace(/\/$/, "");
  const cleanPath: string = params.path.startsWith("/") ? params.path : `/${params.path}`;
  const queryPart: string = params.query && params.query.length > 0 ? params.query : "";
  return `${cleanBase}${cleanPath}${queryPart}`;
}

function resolveParallelCount(params: { readonly requested?: number; readonly taskCount: number }): number {
  const requested: number | undefined = params.requested;
  if (requested !== undefined) {
    return Math.max(1, Math.min(20, Math.min(params.taskCount, requested)));
  }
  return Math.max(1, Math.min(10, params.taskCount));
}

function parseArgs(argv: readonly string[]): HeadersArgs {
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

function getRequiredHeaders(params: { readonly url: string }): readonly SecurityHeaderKey[] {
  const protocol: string = new URL(params.url).protocol;
  const base: readonly SecurityHeaderKey[] = [
    "content-security-policy",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "permissions-policy",
    "cross-origin-opener-policy",
    "cross-origin-resource-policy",
    "cross-origin-embedder-policy",
  ] as const;
  if (protocol === "https:") {
    return ["strict-transport-security", ...base] as const;
  }
  return base;
}

function getHeaderValue(headers: Record<string, unknown>, key: string): string | undefined {
  const raw: unknown = headers[key];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw) && typeof raw[0] === "string") {
    return raw[0];
  }
  return undefined;
}

function buildMissingHeadersDisplay(missing: readonly SecurityHeaderKey[]): readonly string[] {
  const clipped: readonly SecurityHeaderKey[] = missing.slice(0, MAX_MISSING_HEADERS_DISPLAY);
  const suffix: string = missing.length > clipped.length ? `(+${missing.length - clipped.length} more)` : "";
  const lines: string[] = clipped.map((k) => k);
  if (suffix.length > 0) {
    lines.push(suffix);
  }
  return lines;
}

function buildMissingHeadersCell(missing: readonly SecurityHeaderKey[]): string {
  if (missing.length === 0) {
    return "";
  }
  const clipped: readonly SecurityHeaderKey[] = missing.slice(0, 2);
  const suffix: string = missing.length > clipped.length ? ` (+${missing.length - clipped.length})` : "";
  return `${clipped.join(", ")}${suffix}`;
}

function buildMissingDetailsPanel(results: readonly HeaderCheckResult[]): string {
  const withMissing: readonly HeaderCheckResult[] = results.filter((r) => r.missing.length > 0 || Boolean(r.runtimeErrorMessage));
  const limited: readonly HeaderCheckResult[] = withMissing.slice(0, 10);
  const lines: string[] = [];
  for (const r of limited) {
    lines.push(`${r.label} ${r.path} [${r.statusCode ?? 0}]`);
    if (r.runtimeErrorMessage) {
      lines.push(`  err: ${r.runtimeErrorMessage}`);
      continue;
    }
    const missingLines: readonly string[] = buildMissingHeadersDisplay(r.missing);
    for (const m of missingLines) {
      lines.push(`  - ${m}`);
    }
  }
  if (lines.length === 0) {
    return "";
  }
  if (withMissing.length > limited.length) {
    lines.push(`...and ${withMissing.length - limited.length} more`);
  }
  return renderPanel({ title: theme.bold("Missing headers"), lines });
}

function isConnectionErrorMessage(message: string): boolean {
  return message.includes("ECONNREFUSED") || message.includes("ENOTFOUND") || message.includes("EAI_AGAIN") || message.includes("Timed out");
}

async function fetchHeaders(params: { readonly url: string; readonly timeoutMs: number }): Promise<{ readonly statusCode: number; readonly headers: Record<string, unknown> }> {
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
        headers: { "user-agent": "apex-auditor/headers" },
      },
      (res) => {
        res.on("data", () => undefined);
        res.on("end", () => {
          resolvePromise({ statusCode: res.statusCode ?? 0, headers: res.headers as unknown as Record<string, unknown> });
        });
      },
    );
    req.on("error", (err: unknown) => rejectPromise(err));
    req.setTimeout(params.timeoutMs, () => {
      req.destroy(new Error(`Timed out after ${params.timeoutMs}ms`));
    });
    req.end();
  });
}

async function runWithConcurrency(params: {
  readonly tasks: readonly HeaderCheckResult[];
  readonly parallel: number;
  readonly runner: (task: HeaderCheckResult) => Promise<HeaderCheckResult>;
  readonly signal?: AbortSignal;
}): Promise<readonly HeaderCheckResult[]> {
  const results: HeaderCheckResult[] = new Array(params.tasks.length);
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
      const task: HeaderCheckResult = params.tasks[index];
      results[index] = await params.runner(task);
    }
  };
  const workers: Promise<void>[] = new Array(params.parallel).fill(0).map(async () => worker());
  await Promise.all(workers);
  return results;
}

function buildResultsTable(results: readonly HeaderCheckResult[]): string {
  const rows: (readonly string[])[] = [];
  for (const r of results) {
    const missingCount: number = r.missing.length;
    const statusText: string = r.runtimeErrorMessage
      ? theme.red("err")
      : r.statusCode && r.statusCode >= 200 && r.statusCode < 400
        ? theme.green(String(r.statusCode))
        : theme.yellow(String(r.statusCode ?? 0));
    const missingText: string = missingCount === 0 ? theme.green("ok") : theme.yellow(String(missingCount));
    const missingCell: string = buildMissingHeadersCell(r.missing);
    rows.push([r.label, r.path, statusText, missingText, missingCell] as const);
  }
  if (rows.length === 0) {
    return "";
  }
  return renderTable({ headers: ["Label", "Path", "Status", "Missing", "Missing headers"], rows });
}

export async function runHeadersCli(argv: readonly string[], options?: { readonly signal?: AbortSignal }): Promise<void> {
  stopSpinner();
  const args: HeadersArgs = parseArgs(argv);
  const startedAtMs: number = Date.now();
  const { configPath, config }: { readonly configPath: string; readonly config: ApexConfig } = await loadConfig({ configPath: args.configPath });

  const targets: readonly HeaderCheckResult[] = config.pages.map((p) => {
    const url: string = buildUrl({ baseUrl: config.baseUrl, path: p.path, query: config.query });
    return { label: p.label, path: p.path, url, missing: [], present: [] };
  });

  const parallel: number = resolveParallelCount({ requested: args.parallelOverride, taskCount: targets.length });

  const results: readonly HeaderCheckResult[] = await runWithConcurrency({
    tasks: targets,
    parallel,
    signal: options?.signal,
    runner: async (t) => {
      if (options?.signal?.aborted) {
        throw new Error("Aborted");
      }
      try {
        const res = await fetchHeaders({ url: t.url, timeoutMs: args.timeoutMs });
        const required: readonly SecurityHeaderKey[] = getRequiredHeaders({ url: t.url });
        const present: SecurityHeaderKey[] = [];
        const missing: SecurityHeaderKey[] = [];
        const lowerHeaders: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          lowerHeaders[k.toLowerCase()] = v;
        }
        for (const key of required) {
          const value: string | undefined = getHeaderValue(lowerHeaders, key);
          if (value && value.trim().length > 0) {
            present.push(key);
          } else {
            missing.push(key);
          }
        }
        return { ...t, statusCode: res.statusCode, present, missing };
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        const required: readonly SecurityHeaderKey[] = getRequiredHeaders({ url: t.url });
        return { ...t, runtimeErrorMessage: message, present: [], missing: [...required] };
      }
    },
  });

  const completedAtMs: number = Date.now();
  const report: HeadersReport = {
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
  const outputPath: string = resolve(outputDir, "headers.json");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  if (args.jsonOutput) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const failCount: number = results.filter((r) => r.missing.length > 0 || Boolean(r.runtimeErrorMessage)).length;

  const allFailed: boolean = results.length > 0 && results.every((r) => typeof r.runtimeErrorMessage === "string" && r.runtimeErrorMessage.length > 0);
  if (allFailed) {
    const firstMessage: string = (results[0]?.runtimeErrorMessage ?? "") as string;
    if (firstMessage.length > 0 && isConnectionErrorMessage(firstMessage)) {
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
    `Fail: ${failCount}`,
    `Output: .apex-auditor/headers.json`,
  ];

  // eslint-disable-next-line no-console
  console.log(renderPanel({ title: theme.bold("Headers"), lines }));

  const table: string = buildResultsTable(results);
  if (table.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n${theme.bold("Results")}`);
    // eslint-disable-next-line no-console
    console.log(table);
  }
  const details: string = buildMissingDetailsPanel(results);
  if (details.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n${theme.bold("Details")}`);
    // eslint-disable-next-line no-console
    console.log(details);
  }
}
