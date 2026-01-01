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

type LinksArgs = {
  readonly configPath: string;
  readonly sitemapUrl?: string;
  readonly parallelOverride?: number;
  readonly timeoutMs: number;
  readonly maxUrls: number;
  readonly jsonOutput: boolean;
};

type UrlSource = "sitemap" | "config" | "html";

type LinkTarget = {
  readonly url: string;
  readonly source: UrlSource;
  readonly discoveredFromUrl?: string;
};

type LinkCheckResult = {
  readonly url: string;
  readonly statusCode?: number;
  readonly bytes?: number;
  readonly runtimeErrorMessage?: string;
};

type BrokenLink = {
  readonly url: string;
  readonly statusCode?: number;
  readonly runtimeErrorMessage?: string;
};

type LinksReport = {
  readonly meta: {
    readonly configPath: string;
    readonly baseUrl: string;
    readonly sitemapUrl?: string;
    readonly resolvedParallel: number;
    readonly timeoutMs: number;
    readonly maxUrls: number;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly elapsedMs: number;
  };
  readonly discovered: {
    readonly total: number;
    readonly unique: number;
    readonly truncated: boolean;
  };
  readonly results: readonly LinkCheckResult[];
  readonly broken: readonly BrokenLink[];
};

const NO_COLOR: boolean = Boolean(process.env.NO_COLOR) || process.env.CI === "true";
const theme: UiTheme = new UiTheme({ noColor: NO_COLOR });

function resolveParallelCount(params: { readonly requested?: number; readonly taskCount: number }): number {
  const requested: number | undefined = params.requested;
  if (requested !== undefined) {
    return Math.max(1, Math.min(20, Math.min(params.taskCount, requested)));
  }
  return Math.max(1, Math.min(10, params.taskCount));
}

function parseArgs(argv: readonly string[]): LinksArgs {
  let configPath: string | undefined;
  let sitemapUrl: string | undefined;
  let parallelOverride: number | undefined;
  let timeoutMs = 20_000;
  let maxUrls = 200;
  let jsonOutput = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg: string = argv[i];
    if ((arg === "--config" || arg === "-c") && i + 1 < argv.length) {
      configPath = argv[i + 1];
      i += 1;
    } else if (arg === "--sitemap" && i + 1 < argv.length) {
      sitemapUrl = argv[i + 1];
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
    } else if (arg === "--max-urls" && i + 1 < argv.length) {
      const value: number = parseInt(argv[i + 1] ?? "", 10);
      if (!Number.isFinite(value) || value < 1 || value > 5000) {
        throw new Error(`Invalid --max-urls value: ${argv[i + 1]}. Expected integer between 1 and 5000.`);
      }
      maxUrls = value;
      i += 1;
    } else if (arg === "--json") {
      jsonOutput = true;
    }
  }
  return {
    configPath: configPath ?? "apex.config.json",
    sitemapUrl,
    parallelOverride,
    timeoutMs,
    maxUrls,
    jsonOutput,
  };
}

async function fetchText(params: { readonly url: string; readonly timeoutMs: number; readonly accept?: string }): Promise<{ readonly statusCode: number; readonly body: string; readonly headers: Record<string, unknown> }> {
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
        headers: {
          "user-agent": "apex-auditor/links",
          accept: params.accept ?? "text/html,application/xml;q=0.9,*/*;q=0.8",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on("end", () => {
          const raw: string = Buffer.concat(chunks).toString("utf8");
          resolvePromise({ statusCode: res.statusCode ?? 0, body: raw, headers: res.headers as unknown as Record<string, unknown> });
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

async function fetchStatus(params: { readonly url: string; readonly timeoutMs: number }): Promise<{ readonly statusCode: number; readonly bytes: number }> {
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
        headers: { "user-agent": "apex-auditor/links" },
      },
      (res) => {
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.on("end", () => {
          resolvePromise({ statusCode: res.statusCode ?? 0, bytes });
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

function isHtml(headers: Record<string, unknown>): boolean {
  const raw: unknown = headers["content-type"];
  const value: string = typeof raw === "string" ? raw : Array.isArray(raw) && typeof raw[0] === "string" ? raw[0] : "";
  return value.toLowerCase().includes("text/html");
}

function extractSitemapUrls(xml: string): readonly string[] {
  const matches: IterableIterator<RegExpMatchArray> = xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi);
  const urls: string[] = [];
  for (const m of matches) {
    const value: string | undefined = m[1];
    if (!value) {
      continue;
    }
    urls.push(value.trim());
  }
  return urls;
}

function extractHtmlLinks(params: { readonly html: string; readonly baseUrl: string; readonly origin: string }): readonly string[] {
  const urls: string[] = [];
  const push = (raw: string): void => {
    const value: string = raw.trim();
    if (value.length === 0) {
      return;
    }
    if (value.startsWith("mailto:") || value.startsWith("tel:") || value.startsWith("javascript:")) {
      return;
    }
    if (value.startsWith("#")) {
      return;
    }
    try {
      const u: URL = new URL(value, params.baseUrl);
      if (u.origin !== params.origin) {
        return;
      }
      u.hash = "";
      urls.push(u.toString());
    } catch {
      return;
    }
  };

  const hrefMatches: IterableIterator<RegExpMatchArray> = params.html.matchAll(/\shref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi);
  for (const m of hrefMatches) {
    push((m[1] ?? m[2] ?? m[3] ?? "") as string);
  }

  const srcMatches: IterableIterator<RegExpMatchArray> = params.html.matchAll(/\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi);
  for (const m of srcMatches) {
    push((m[1] ?? m[2] ?? m[3] ?? "") as string);
  }

  return urls;
}

async function runWithConcurrency(params: {
  readonly tasks: readonly string[];
  readonly parallel: number;
  readonly runner: (url: string) => Promise<LinkCheckResult>;
  readonly signal?: AbortSignal;
}): Promise<readonly LinkCheckResult[]> {
  const results: LinkCheckResult[] = new Array(params.tasks.length);
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
      const url: string = params.tasks[index];
      results[index] = await params.runner(url);
    }
  };
  const workers: Promise<void>[] = new Array(params.parallel).fill(0).map(async () => worker());
  await Promise.all(workers);
  return results;
}

function buildBrokenTable(broken: readonly BrokenLink[]): string {
  const rows = broken.slice(0, 30).map((b) => {
    const statusText: string = b.runtimeErrorMessage
      ? theme.red("err")
      : b.statusCode && b.statusCode >= 400
        ? theme.red(String(b.statusCode))
        : theme.yellow(String(b.statusCode ?? 0));
    return [statusText, b.url, b.runtimeErrorMessage ?? ""] as const;
  });
  if (rows.length === 0) {
    return "";
  }
  return renderTable({ headers: ["Status", "URL", "Error"], rows });
}

function isConnectionErrorMessage(message: string): boolean {
  return message.includes("ECONNREFUSED") || message.includes("ENOTFOUND") || message.includes("EAI_AGAIN") || message.includes("Timed out");
}

export async function runLinksCli(argv: readonly string[], options?: { readonly signal?: AbortSignal }): Promise<void> {
  stopSpinner();
  const args: LinksArgs = parseArgs(argv);
  const startedAtMs: number = Date.now();
  const { configPath, config }: { readonly configPath: string; readonly config: ApexConfig } = await loadConfig({ configPath: args.configPath });

  const origin: string = new URL(config.baseUrl).origin;
  const defaultSitemapUrl: string = `${origin}/sitemap.xml`;
  const sitemapUrl: string | undefined = args.sitemapUrl ?? defaultSitemapUrl;

  const discovered: LinkTarget[] = [];
  const discoveredSet: Set<string> = new Set();

  const addUrl = (target: LinkTarget): void => {
    if (discoveredSet.has(target.url)) {
      return;
    }
    discoveredSet.add(target.url);
    discovered.push(target);
  };

  let truncated = false;

  const seedFromConfig = (): void => {
    for (const page of config.pages) {
      if (options?.signal?.aborted) {
        throw new Error("Aborted");
      }
      const u: string = new URL(page.path, origin).toString();
      addUrl({ url: u, source: "config" });
      if (discovered.length >= args.maxUrls) {
        truncated = true;
        return;
      }
    }
  };

  try {
    const sitemapRes = await fetchText({ url: sitemapUrl, timeoutMs: args.timeoutMs, accept: "application/xml,text/xml,*/*" });
    if (sitemapRes.statusCode >= 200 && sitemapRes.statusCode < 300) {
      const urls: readonly string[] = extractSitemapUrls(sitemapRes.body);
      for (const url of urls) {
        try {
          const u: URL = new URL(url);
          if (u.origin !== origin) {
            continue;
          }
          addUrl({ url: u.toString(), source: "sitemap" });
          if (discovered.length >= args.maxUrls) {
            truncated = true;
            break;
          }
        } catch {
          continue;
        }
      }
    } else {
      seedFromConfig();
    }
  } catch {
    seedFromConfig();
  }

  const crawlCandidates: readonly string[] = discovered.map((d) => d.url);
  const htmlSamples: readonly string[] = crawlCandidates.slice(0, Math.min(crawlCandidates.length, 50));

  for (const pageUrl of htmlSamples) {
    if (options?.signal?.aborted) {
      throw new Error("Aborted");
    }
    if (discovered.length >= args.maxUrls) {
      truncated = true;
      break;
    }
    try {
      const res = await fetchText({ url: pageUrl, timeoutMs: args.timeoutMs, accept: "text/html" });
      if (res.statusCode < 200 || res.statusCode >= 400) {
        continue;
      }
      if (!isHtml(Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v])))) {
        continue;
      }
      const links: readonly string[] = extractHtmlLinks({ html: res.body, baseUrl: pageUrl, origin });
      for (const link of links) {
        if (options?.signal?.aborted) {
          throw new Error("Aborted");
        }
        addUrl({ url: link, source: "html", discoveredFromUrl: pageUrl });
        if (discovered.length >= args.maxUrls) {
          truncated = true;
          break;
        }
      }
    } catch {
      continue;
    }
  }

  const parallel: number = resolveParallelCount({ requested: args.parallelOverride, taskCount: discovered.length });

  const results: readonly LinkCheckResult[] = await runWithConcurrency({
    tasks: discovered.map((d) => d.url),
    parallel,
    signal: options?.signal,
    runner: async (url) => {
      if (options?.signal?.aborted) {
        throw new Error("Aborted");
      }
      try {
        const r = await fetchStatus({ url, timeoutMs: args.timeoutMs });
        return { url, statusCode: r.statusCode, bytes: r.bytes };
      } catch (error: unknown) {
        const message: string = error instanceof Error ? error.message : String(error);
        return { url, runtimeErrorMessage: message };
      }
    },
  });

  const broken: readonly BrokenLink[] = results
    .filter((r) => Boolean(r.runtimeErrorMessage) || (r.statusCode !== undefined && r.statusCode >= 400))
    .map((r) => ({ url: r.url, statusCode: r.statusCode, runtimeErrorMessage: r.runtimeErrorMessage }));

  const allFailed: boolean = results.length > 0 && results.every((r) => typeof r.runtimeErrorMessage === "string" && r.runtimeErrorMessage.length > 0);
  if (allFailed) {
    const firstMessage: string = (results[0]?.runtimeErrorMessage ?? "") as string;
    if (firstMessage.length > 0 && isConnectionErrorMessage(firstMessage)) {
      const lines: readonly string[] = await buildDevServerGuidanceLines({ projectRoot: resolve(configPath, ".."), baseUrl: config.baseUrl });
      // eslint-disable-next-line no-console
      console.log(renderPanel({ title: theme.bold("Dev server"), lines }));
    }
  }

  const completedAtMs: number = Date.now();
  const report: LinksReport = {
    meta: {
      configPath,
      baseUrl: config.baseUrl,
      sitemapUrl: args.sitemapUrl ? sitemapUrl : undefined,
      resolvedParallel: parallel,
      timeoutMs: args.timeoutMs,
      maxUrls: args.maxUrls,
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      elapsedMs: completedAtMs - startedAtMs,
    },
    discovered: {
      total: discovered.length,
      unique: discoveredSet.size,
      truncated,
    },
    results,
    broken,
  };

  const outputDir: string = resolve(".apex-auditor");
  const outputPath: string = resolve(outputDir, "links.json");
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), "utf8");

  if (args.jsonOutput) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines: readonly string[] = [
    `Config: ${configPath}`,
    `Base URL: ${config.baseUrl}`,
    `Sitemap: ${sitemapUrl}`,
    `Discovered: ${report.discovered.total}${report.discovered.truncated ? " (truncated)" : ""}`,
    `Broken: ${report.broken.length}`,
    `Output: .apex-auditor/links.json`,
  ];

  // eslint-disable-next-line no-console
  console.log(renderPanel({ title: theme.bold("Links"), lines }));

  const table: string = buildBrokenTable(report.broken);
  if (table.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n${theme.bold("Broken (first 30)")}`);
    // eslint-disable-next-line no-console
    console.log(table);
  }
}
