import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { launch as launchChrome } from "chrome-launcher";
import type { ApexConfig, ApexDevice } from "./types.js";
import { loadConfig } from "./config.js";
import { CdpClient } from "./cdp-client.js";
import { renderPanel } from "./ui/render-panel.js";
import { renderTable } from "./ui/render-table.js";
import { UiTheme } from "./ui/ui-theme.js";
import { stopSpinner } from "./spinner.js";
import { writeRunnerReports } from "./runner-reporting.js";
import { writeArtifactsNavigation } from "./artifacts-navigation.js";

type ConsoleArgs = {
  readonly configPath: string;
  readonly parallelOverride?: number;
  readonly timeoutMs: number;
  readonly maxEventsPerTarget: number;
  readonly jsonOutput: boolean;
};

type ConsoleTask = {
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
};

type ConsoleTargetResult = {
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
  readonly status: "ok" | "error";
  readonly events: readonly string[];
  readonly runtimeErrorMessage?: string;
};

type ConsoleReport = {
  readonly meta: {
    readonly configPath: string;
    readonly baseUrl: string;
    readonly comboCount: number;
    readonly resolvedParallel: number;
    readonly timeoutMs: number;
    readonly maxEventsPerTarget: number;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly elapsedMs: number;
  };
  readonly results: readonly ConsoleTargetResult[];
};

type ChromeSession = {
  readonly port: number;
  readonly close: () => Promise<void>;
};

type JsonVersionResponse = {
  readonly webSocketDebuggerUrl: string;
};

type TargetInfo = {
  readonly targetId: string;
};

type AttachToTargetResult = {
  readonly sessionId: string;
};

type NavigationResponse = {
  readonly errorText?: string;
};

type TargetSession = { readonly targetId: string; readonly sessionId: string };

type ConsoleEventEnvelope = {
  readonly type?: unknown;
  readonly args?: unknown;
};

type LogEntryEnvelope = {
  readonly entry?: unknown;
};

type LogEntry = {
  readonly level?: unknown;
  readonly text?: unknown;
};

type RunnerEvidence = {
  readonly kind: "file";
  readonly path: string;
};

type RunnerFinding = {
  readonly title: string;
  readonly severity: "info" | "warn" | "error";
  readonly details: readonly string[];
  readonly evidence: readonly RunnerEvidence[];
};

const DEFAULT_NAVIGATION_TIMEOUT_MS: number = 60_000;
const DEFAULT_MAX_PARALLEL: number = 4;
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

const NO_COLOR: boolean = Boolean(process.env.NO_COLOR) || process.env.CI === "true";
const theme: UiTheme = new UiTheme({ noColor: NO_COLOR });

function buildUrl(params: { readonly baseUrl: string; readonly path: string; readonly query?: string }): string {
  const cleanBase: string = params.baseUrl.replace(/\/$/, "");
  const cleanPath: string = params.path.startsWith("/") ? params.path : `/${params.path}`;
  const queryPart: string = params.query && params.query.length > 0 ? params.query : "";
  return `${cleanBase}${cleanPath}${queryPart}`;
}

function parseArgs(argv: readonly string[]): ConsoleArgs {
  let configPath: string | undefined;
  let parallelOverride: number | undefined;
  let timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS;
  let maxEventsPerTarget = 50;
  let jsonOutput = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg: string = argv[i];
    if ((arg === "--config" || arg === "-c") && i + 1 < argv.length) {
      configPath = argv[i + 1];
      i += 1;
    } else if (arg === "--parallel" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(value) || value < 1 || value > 10) {
        throw new Error(`Invalid --parallel value: ${argv[i + 1]}. Expected integer between 1 and 10.`);
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
    } else if (arg === "--max-events" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(value) || value < 1 || value > 500) {
        throw new Error(`Invalid --max-events value: ${argv[i + 1]}. Expected integer between 1 and 500.`);
      }
      maxEventsPerTarget = value;
      i += 1;
    } else if (arg === "--json") {
      jsonOutput = true;
    }
  }
  return {
    configPath: configPath ?? "apex.config.json",
    parallelOverride,
    timeoutMs,
    maxEventsPerTarget,
    jsonOutput,
  };
}

function resolveParallelCount(params: { readonly requested?: number; readonly taskCount: number }): number {
  const requested: number | undefined = params.requested;
  if (requested !== undefined) {
    return Math.max(1, Math.min(DEFAULT_MAX_PARALLEL, Math.min(params.taskCount, requested)));
  }
  return Math.max(1, Math.min(DEFAULT_MAX_PARALLEL, params.taskCount));
}

async function createChromeSession(): Promise<ChromeSession> {
  const userDataDir: string = await mkdtemp(join(tmpdir(), "apex-auditor-console-chrome-"));
  const chrome = await launchChrome({ chromeFlags: [...CHROME_FLAGS, `--user-data-dir=${userDataDir}`] });
  return {
    port: chrome.port,
    close: async () => {
      try {
        await chrome.kill();
      } catch {
      }
      try {
        await rm(userDataDir, { recursive: true, force: true });
      } catch {
        return;
      }
    },
  };
}

async function fetchJsonVersion(port: number): Promise<JsonVersionResponse> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/json/version", method: "GET" }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      response.on("end", () => {
        const raw: string = Buffer.concat(chunks).toString("utf8");
        const parsed: unknown = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object") {
          rejectPromise(new Error("Invalid /json/version response"));
          return;
        }
        const record = parsed as { readonly webSocketDebuggerUrl?: unknown };
        if (typeof record.webSocketDebuggerUrl !== "string" || record.webSocketDebuggerUrl.length === 0) {
          rejectPromise(new Error("Missing webSocketDebuggerUrl in /json/version"));
          return;
        }
        resolvePromise({ webSocketDebuggerUrl: record.webSocketDebuggerUrl });
      });
    });
    request.on("error", (error: unknown) => rejectPromise(error as Error));
    request.end();
  });
}

function buildTasks(config: ApexConfig): readonly ConsoleTask[] {
  const tasks: ConsoleTask[] = [];
  for (const page of config.pages) {
    for (const device of page.devices) {
      const url: string = buildUrl({ baseUrl: config.baseUrl, path: page.path, query: config.query });
      tasks.push({ url, path: page.path, label: page.label, device });
    }
  }
  return tasks;
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
}

async function navigateAndAwaitLoad(client: CdpClient, sessionId: string, url: string, timeoutMs: number): Promise<void> {
  const response: NavigationResponse = await client.send<NavigationResponse>("Page.navigate", { url }, sessionId);
  if (response.errorText) {
    throw new Error(response.errorText);
  }
  await client.waitForEventForSession("Page.loadEventFired", sessionId, timeoutMs);
}

function recordConsoleEvents(params: {
  readonly client: CdpClient;
  readonly sessionId: string;
  readonly maxEvents: number;
  readonly bucket: string[];
}): () => void {
  const push = (value: string): void => {
    if (params.bucket.length >= params.maxEvents) {
      return;
    }
    params.bucket.push(value);
  };

  const offException = params.client.onEvent("Runtime.exceptionThrown", params.sessionId, (payload: unknown) => {
    const text: string = typeof payload === "object" && payload !== null ? JSON.stringify(payload) : String(payload);
    push(`exception: ${text}`);
  });

  const offConsole = params.client.onEvent("Runtime.consoleAPICalled", params.sessionId, (payload: unknown) => {
    const env = payload as ConsoleEventEnvelope;
    const type: string = typeof env.type === "string" ? env.type : "";
    const args: unknown = env.args;
    const text: string = typeof args === "object" && args !== null ? JSON.stringify(args) : String(args);
    if (type === "error" || type === "assert") {
      push(`console.${type}: ${text}`);
    }
  });

  const offLog = params.client.onEvent("Log.entryAdded", params.sessionId, (payload: unknown) => {
    const env = payload as LogEntryEnvelope;
    const entry: LogEntry | undefined = env.entry as LogEntry | undefined;
    const level: string = typeof entry?.level === "string" ? entry.level : "";
    const text: string = typeof entry?.text === "string" ? entry.text : "";
    if (level === "error" && text.length > 0) {
      push(`log.error: ${text}`);
    }
  });

  return () => {
    offException();
    offConsole();
    offLog();
  };
}

async function detachAndClose(client: CdpClient, context: TargetSession, stopLogging: () => void): Promise<void> {
  stopLogging();
  await client.send("Target.closeTarget", { targetId: context.targetId });
  await client.send("Target.detachFromTarget", { sessionId: context.sessionId });
}

async function runWithConcurrency(params: {
  readonly tasks: readonly ConsoleTask[];
  readonly parallel: number;
  readonly runner: (task: ConsoleTask) => Promise<ConsoleTargetResult>;
  readonly signal?: AbortSignal;
}): Promise<readonly ConsoleTargetResult[]> {
  const results: ConsoleTargetResult[] = new Array(params.tasks.length);
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
      const task: ConsoleTask = params.tasks[index];
      results[index] = await params.runner(task);
    }
  };
  const workers: Promise<void>[] = new Array(params.parallel).fill(0).map(async () => worker());
  await Promise.all(workers);
  return results;
}

function buildErrorTable(results: readonly ConsoleTargetResult[]): string {
  const rows = results
    .filter((r) => r.status === "error")
    .slice(0, 20)
    .map((r) => {
      const count: string = theme.red(String(r.events.length));
      return [r.label, r.path, r.device, count] as const;
    });

  if (rows.length === 0) {
    return "";
  }

  return renderTable({ headers: ["Label", "Path", "Dev", "Errors"], rows });
}

export async function runConsoleCli(argv: readonly string[], options?: { readonly signal?: AbortSignal }): Promise<void> {
  stopSpinner();
  const args: ConsoleArgs = parseArgs(argv);
  const startedAtMs: number = Date.now();
  const { configPath, config }: { readonly configPath: string; readonly config: ApexConfig } = await loadConfig({ configPath: args.configPath });

  const tasks: readonly ConsoleTask[] = buildTasks(config);
  const parallel: number = resolveParallelCount({ requested: args.parallelOverride ?? config.parallel, taskCount: tasks.length });

  if (options?.signal?.aborted) {
    throw new Error("Aborted");
  }
  const chrome: ChromeSession = await createChromeSession();
  try {
    const { webSocketDebuggerUrl }: JsonVersionResponse = await fetchJsonVersion(chrome.port);
    const client: CdpClient = new CdpClient(webSocketDebuggerUrl);
    await client.connect();
    try {
      const results: readonly ConsoleTargetResult[] = await runWithConcurrency({
        tasks,
        parallel,
        signal: options?.signal,
        runner: async (task) => {
          if (options?.signal?.aborted) {
            throw new Error("Aborted");
          }
          const bucket: string[] = [];
          try {
            const context: TargetSession = await createTargetSession(client);
            await enableDomains(client, context.sessionId);
            const stopLogging = recordConsoleEvents({ client, sessionId: context.sessionId, maxEvents: args.maxEventsPerTarget, bucket });
            await applyDeviceEmulation(client, task.device, context.sessionId);
            await navigateAndAwaitLoad(client, context.sessionId, task.url, args.timeoutMs);
            await client.send("Runtime.evaluate", { expression: "void 0", awaitPromise: false }, context.sessionId);
            await detachAndClose(client, context, stopLogging);
            const status: "ok" | "error" = bucket.length > 0 ? "error" : "ok";
            return { ...task, status, events: bucket };
          } catch (error: unknown) {
            const message: string = error instanceof Error ? error.message : String(error);
            return { ...task, status: "error", events: bucket, runtimeErrorMessage: message };
          }
        },
      });

      const completedAtMs: number = Date.now();
      const report: ConsoleReport = {
        meta: {
          configPath,
          baseUrl: config.baseUrl,
          comboCount: results.length,
          resolvedParallel: parallel,
          timeoutMs: args.timeoutMs,
          maxEventsPerTarget: args.maxEventsPerTarget,
          startedAt: new Date(startedAtMs).toISOString(),
          completedAt: new Date(completedAtMs).toISOString(),
          elapsedMs: completedAtMs - startedAtMs,
        },
        results,
      };

      const outputDir: string = resolve(".apex-auditor");
      const outputPath: string = resolve(outputDir, "console.json");
      await mkdir(outputDir, { recursive: true });
      await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

      const errorCombos: number = results.filter((r) => r.status === "error").length;
      const eventCount: number = results.reduce((sum, r) => sum + r.events.length, 0);
      const evidence: readonly RunnerEvidence[] = [{ kind: "file", path: ".apex-auditor/console.json" }] as const;
      const findings: RunnerFinding[] = [
        {
          title: "Summary",
          severity: errorCombos > 0 ? "error" : "info",
          details: [`Combos: ${results.length}`, `Error combos: ${errorCombos}`, `Events: ${eventCount}`],
          evidence,
        },
      ];
      const worst: readonly (typeof results)[number][] = [...results]
        .filter((r) => r.status === "error")
        .sort((a, b) => b.events.length - a.events.length)
        .slice(0, 10);
      if (worst.length > 0) {
        findings.push({
          title: "Worst pages (top 10 by error events)",
          severity: "warn",
          details: worst.map((r) => `${r.label} ${r.path} [${r.device}] – ${r.events.length} events`),
          evidence,
        });
      }
      await writeRunnerReports({
        outputDir,
        runner: "console",
        generatedAt: new Date().toISOString(),
        humanTitle: "ApexAuditor Console report",
        humanSummaryLines: [`Combos: ${results.length}`, `Error combos: ${errorCombos}`, `Events: ${eventCount}`],
        artifacts: [{ label: "Console events (JSON)", relativePath: "console.json" }],
        aiMeta: {
          configPath,
          baseUrl: config.baseUrl,
          comboCount: results.length,
          resolvedParallel: parallel,
          timeoutMs: args.timeoutMs,
          maxEventsPerTarget: args.maxEventsPerTarget,
          errorCombos,
          eventCount,
        },
        aiFindings: findings,
      });
      await writeArtifactsNavigation({ outputDir });

      if (args.jsonOutput) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      const lines: readonly string[] = [
        `Config: ${configPath}`,
        `Base URL: ${config.baseUrl}`,
        `Combos: ${results.length}`,
        `Parallel: ${parallel}`,
        `Timeout: ${args.timeoutMs}ms`,
        `Error combos: ${errorCombos}`,
        `Events: ${eventCount}`,
        `Output: .apex-auditor/console.json`,
      ];

      // eslint-disable-next-line no-console
      console.log(renderPanel({ title: theme.bold("Console"), lines }));

      const table: string = buildErrorTable(results);
      if (table.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`\n${theme.bold("Errors (first 20)")}`);
        // eslint-disable-next-line no-console
        console.log(table);
      }
    } finally {
      client.close();
    }
  } finally {
    await chrome.close();
  }
}
