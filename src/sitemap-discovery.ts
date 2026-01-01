import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

type SitemapDiscoveryOptions = {
  readonly baseUrl: string;
  readonly limit: number;
};

type RobotsResult = {
  readonly sitemaps: readonly string[];
};

type HttpResponse = {
  readonly statusCode: number;
  readonly body: string;
};

function normaliseRoute(path: string): string {
  const trimmed: string = path.replace(/^\/+/, "");
  if (trimmed.length === 0) {
    return "/";
  }
  return `/${trimmed}`.replace(/\/+/g, "/");
}

function parseRobotsTxt(text: string): RobotsResult {
  const lines: readonly string[] = text.split(/\r?\n/);
  const sitemaps: string[] = [];
  for (const raw of lines) {
    const line: string = raw.trim();
    if (line.length === 0) {
      continue;
    }
    const lower: string = line.toLowerCase();
    if (!lower.startsWith("sitemap:")) {
      continue;
    }
    const url: string = line.slice("sitemap:".length).trim();
    if (url.length > 0) {
      sitemaps.push(url);
    }
  }
  return { sitemaps };
}

function parseSitemapXml(xml: string): readonly string[] {
  const urls: string[] = [];
  const pattern: RegExp = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    const value: string = match[1] ?? "";
    if (value.length > 0) {
      urls.push(value);
    }
  }
  return urls;
}

function resolveRoutesFromUrls(params: { readonly baseUrl: string; readonly urls: readonly string[]; readonly limit: number }): readonly string[] {
  const base: URL = new URL(params.baseUrl);
  const routes: string[] = [];
  const seen: Set<string> = new Set();
  for (const raw of params.urls) {
    if (routes.length >= params.limit) {
      break;
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    const isSameOrigin: boolean = parsed.origin === base.origin;
    if (!isSameOrigin) {
      continue;
    }
    const route: string = normaliseRoute(parsed.pathname);
    if (!seen.has(route)) {
      seen.add(route);
      routes.push(route);
    }
  }
  return routes;
}

async function fetchText(url: string): Promise<HttpResponse> {
  const parsed: URL = new URL(url);
  const requester = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  return await new Promise<HttpResponse>((resolvePromise, rejectPromise) => {
    const req = requester(
      {
        hostname: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: { "User-Agent": "ApexAuditor" },
      },
      (res) => {
        const statusCode: number = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body: string = Buffer.concat(chunks).toString("utf8");
          resolvePromise({ statusCode, body });
        });
      },
    );
    req.on("error", (error: Error) => rejectPromise(error));
    req.end();
  });
}

export async function discoverRuntimeRoutes(options: SitemapDiscoveryOptions): Promise<readonly string[]> {
  const limit: number = Math.max(1, options.limit);
  const base: URL = new URL(options.baseUrl);
  const robotsUrl: string = new URL("/robots.txt", base).toString();
  let sitemaps: readonly string[] = [];
  try {
    const robots = await fetchText(robotsUrl);
    if (robots.statusCode >= 200 && robots.statusCode < 400) {
      sitemaps = parseRobotsTxt(robots.body).sitemaps;
    }
  } catch {
    sitemaps = [];
  }
  const defaultSitemapUrl: string = new URL("/sitemap.xml", base).toString();
  const candidateSitemaps: readonly string[] = sitemaps.length > 0 ? sitemaps : [defaultSitemapUrl];
  const discovered: string[] = [];
  const seen: Set<string> = new Set();
  for (const sitemapUrl of candidateSitemaps) {
    if (discovered.length >= limit) {
      break;
    }
    let response: HttpResponse;
    try {
      response = await fetchText(sitemapUrl);
    } catch {
      continue;
    }
    if (!(response.statusCode >= 200 && response.statusCode < 400)) {
      continue;
    }
    const locs: readonly string[] = parseSitemapXml(response.body);
    const routes: readonly string[] = resolveRoutesFromUrls({ baseUrl: options.baseUrl, urls: locs, limit });
    for (const route of routes) {
      if (discovered.length >= limit) {
        break;
      }
      if (!seen.has(route)) {
        seen.add(route);
        discovered.push(route);
      }
    }
  }
  return discovered;
}
