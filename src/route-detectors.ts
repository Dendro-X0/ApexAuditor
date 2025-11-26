import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Dirent } from "node:fs";
import { pathExists, readTextFile } from "./fs-utils.js";

export type RouteDetectorId = "next-app" | "next-pages" | "remix-routes" | "spa-html";

export interface DetectRoutesOptions {
  readonly projectRoot: string;
  readonly limit?: number;
  readonly logger?: RouteDetectionLogger;
  readonly preferredDetectorId?: RouteDetectorId;
}

export interface DetectedRoute {
  readonly path: string;
  readonly label: string;
  readonly source: string;
}

export interface RouteDetectionLogger {
  log(entry: RouteDetectionLogEntry): void;
}

export interface RouteDetectionLogEntry {
  readonly detectorId: string;
  readonly message: string;
  readonly context?: RouteDetectionLogContext;
}

export interface RouteDetectionLogContext {
  readonly limit?: number;
  readonly candidateCount?: number;
  readonly selectedCount?: number;
  readonly root?: string;
}

interface InternalDetectOptions extends DetectRoutesOptions {
  readonly limit: number;
}

interface RouteDetector {
  readonly id: RouteDetectorId;
  canDetect(options: DetectRoutesOptions): Promise<boolean>;
  detect(options: InternalDetectOptions): Promise<DetectedRoute[]>;
}

const PAGE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const;
const DEFAULT_LIMIT = 25;
const SOURCE_NEXT_APP: RouteDetectorId = "next-app";
const SOURCE_NEXT_PAGES: RouteDetectorId = "next-pages";
const SOURCE_REMIX: RouteDetectorId = "remix-routes";
const SOURCE_SPA: RouteDetectorId = "spa-html";
const ROUTE_DETECTORS: readonly RouteDetector[] = [
  createNextAppDetector(),
  createNextPagesDetector(),
  createRemixRoutesDetector(),
  createSpaHtmlDetector(),
];

export async function detectRoutes(options: DetectRoutesOptions): Promise<DetectedRoute[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const orderedDetectors = orderDetectors(options.preferredDetectorId);
  for (const detector of orderedDetectors) {
    const detectorOptions: InternalDetectOptions = { ...options, limit };
    if (!(await detector.canDetect(detectorOptions))) {
      logDetection(options, detector.id, "skipped");
      continue;
    }
    const routes = await detector.detect(detectorOptions);
    if (routes.length === 0) {
      logDetection(options, detector.id, "no-routes", { limit });
      continue;
    }
    const selected = takeTopRoutes(routes, limit);
    logDetection(options, detector.id, "routes-found", {
      limit,
      candidateCount: routes.length,
      selectedCount: selected.length,
      root: detectorOptions.projectRoot,
    });
    return selected;
  }
  logDetection(options, "none", "no-detectors", { limit });
  return [];
}

function createNextAppDetector(): RouteDetector {
  return {
    id: SOURCE_NEXT_APP,
    canDetect: async (options) => pathExists(join(options.projectRoot, "app")),
    detect: async (options) => detectAppRoutes(join(options.projectRoot, "app"), options.limit),
  };
}

function createNextPagesDetector(): RouteDetector {
  return {
    id: SOURCE_NEXT_PAGES,
    canDetect: async (options) => pathExists(join(options.projectRoot, "pages")),
    detect: async (options) => detectPagesRoutes(join(options.projectRoot, "pages"), options.limit),
  };
}

function createRemixRoutesDetector(): RouteDetector {
  return {
    id: SOURCE_REMIX,
    canDetect: async (options) => pathExists(join(options.projectRoot, "app", "routes")),
    detect: async (options) => detectRemixRoutes(join(options.projectRoot, "app", "routes"), options.limit),
  };
}

function createSpaHtmlDetector(): RouteDetector {
  return {
    id: SOURCE_SPA,
    canDetect: async (options) => Boolean(await findSpaHtml(options.projectRoot)),
    detect: async (options) => detectSpaRoutes(options.projectRoot, options.limit),
  };
}

async function detectAppRoutes(appRoot: string, limit: number): Promise<DetectedRoute[]> {
  const files = await collectRouteFiles(appRoot, limit, isAppPageFile);
  return files.map((file) => buildRoute(file, appRoot, formatAppRoutePath, SOURCE_NEXT_APP));
}

async function detectPagesRoutes(pagesRoot: string, limit: number): Promise<DetectedRoute[]> {
  const files = await collectRouteFiles(pagesRoot, limit, isPagesFileAllowed);
  return files.map((file) => buildRoute(file, pagesRoot, formatPagesRoutePath, SOURCE_NEXT_PAGES));
}

async function detectRemixRoutes(routesRoot: string, limit: number): Promise<DetectedRoute[]> {
  const files = await collectRouteFiles(routesRoot, limit, isRemixRouteFile);
  return files.map((file) => buildRoute(file, routesRoot, formatRemixRoutePath, SOURCE_REMIX));
}

async function detectSpaRoutes(projectRoot: string, limit: number): Promise<DetectedRoute[]> {
  const htmlPath = await findSpaHtml(projectRoot);
  if (!htmlPath) {
    return [];
  }
  const html = await readTextFile(htmlPath);
  const routes = extractRoutesFromHtml(html).slice(0, limit);
  return routes.map((routePath) => ({ path: routePath, label: buildLabel(routePath), source: SOURCE_SPA }));
}

async function collectRouteFiles(
  root: string,
  limit: number,
  matcher: (entry: Dirent, relativePath: string) => boolean,
): Promise<string[]> {
  const stack: string[] = [root];
  const files: string[] = [];
  while (stack.length > 0 && files.length < limit) {
    const current = stack.pop() as string;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      const relativePath = relative(root, entryPath);
      if (entry.isDirectory()) {
        if (shouldRecurseDirectory(relativePath)) {
          stack.push(entryPath);
        }
      } else if (matcher(entry, relativePath)) {
        files.push(entryPath);
      }
      if (files.length >= limit) {
        break;
      }
    }
  }
  return files;
}

function shouldRecurseDirectory(relativePath: string): boolean {
  const posixPath = normalisePath(relativePath);
  if (posixPath.startsWith("api/")) {
    return false;
  }
  return true;
}

function isAppPageFile(entry: Dirent, relativePath: string): boolean {
  if (!entry.isFile()) {
    return false;
  }
  const posixPath = normalisePath(relativePath);
  if (!hasAllowedExtension(posixPath)) {
    return false;
  }
  return posixPath.includes("/page.") || posixPath.startsWith("page.");
}

function isPagesFileAllowed(entry: Dirent, relativePath: string): boolean {
  if (!entry.isFile()) {
    return false;
  }
  const posixPath = normalisePath(relativePath);
  if (!hasAllowedExtension(posixPath)) {
    return false;
  }
  if (posixPath.startsWith("api/")) {
    return false;
  }
  if (posixPath.startsWith("_")) {
    return false;
  }
  return true;
}

function isRemixRouteFile(entry: Dirent, relativePath: string): boolean {
  if (!entry.isFile()) {
    return false;
  }
  if (!hasAllowedExtension(relativePath)) {
    return false;
  }
  const posixPath = normalisePath(relativePath);
  if (posixPath.includes(".server")) {
    return false;
  }
  return !posixPath.split("/").some((segment) => segment.startsWith("__"));
}

function hasAllowedExtension(path: string): boolean {
  return PAGE_EXTENSIONS.some((extension) => path.endsWith(extension));
}

function buildRoute(
  filePath: string,
  root: string,
  formatter: (relativePath: string) => string,
  source: string,
): DetectedRoute {
  const relativePath = normalisePath(relative(root, filePath));
  const routePath = formatter(relativePath);
  return {
    path: routePath,
    label: buildLabel(routePath),
    source,
  };
}

function formatAppRoutePath(relativePath: string): string {
  const posixPath = relativePath.replace(/\\/g, "/");
  const withoutFile = posixPath.replace(/\/?page\.[^/]+$/, "");
  const cleaned = withoutFile.replace(/\([^/]+\)/g, "").replace(/^\/+/, "");
  return cleaned.length === 0 ? "/" : normaliseRoute(cleaned);
}

function formatPagesRoutePath(relativePath: string): string {
  const cleanPath = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  if (cleanPath === "index") {
    return "/";
  }
  if (cleanPath.endsWith("/index")) {
    return normaliseRoute(cleanPath.slice(0, -6));
  }
  return normaliseRoute(cleanPath);
}

function formatRemixRoutePath(relativePath: string): string {
  const cleanPath = relativePath.replace(/\\/g, "/").replace(/\.[^/.]+$/, "");
  const tokens = cleanPath
    .split("/")
    .flatMap((segment) => segment.split("."))
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const parts = tokens
    .map((segment) => (segment.startsWith("_") ? segment.slice(1) : segment))
    .map((segment) => {
      if (segment === "index") {
        return "";
      }
      if (segment === "$") {
        return ":param";
      }
      if (segment.startsWith("$")) {
        return `:${segment.slice(1)}`;
      }
      if (segment.includes("$")) {
        return segment
          .split("$")
          .filter((piece) => piece.length > 0)
          .map((piece, index) => (index === 0 ? piece : `:${piece}`))
          .join("/");
      }
      return segment.replace(/\$([a-zA-Z0-9]+)/g, ":$1").replace(/\$/g, "");
    })
    .filter((segment) => segment.length > 0);
  return parts.length === 0 ? "/" : normaliseRoute(parts.join("/"));
}

function normaliseRoute(path: string): string {
  const trimmed = path.replace(/^\/+/, "");
  if (trimmed.length === 0) {
    return "/";
  }
  return `/${trimmed}`.replace(/\/+/g, "/");
}

function buildLabel(routePath: string): string {
  if (routePath === "/") {
    return "home";
  }
  const segments = routePath.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1] ?? "page";
  return lastSegment.replace(/\[\[(.+?)\]\]/g, "$1").replace(/^:/, "");
}

function normalisePath(path: string): string {
  return path.split(sep).join("/");
}

function takeTopRoutes(routes: readonly DetectedRoute[], limit: number): DetectedRoute[] {
  return routes.slice(0, limit);
}

function orderDetectors(preferredId?: RouteDetectorId): readonly RouteDetector[] {
  if (!preferredId) {
    return ROUTE_DETECTORS;
  }
  const preferred = ROUTE_DETECTORS.find((detector) => detector.id === preferredId);
  if (!preferred) {
    return ROUTE_DETECTORS;
  }
  const others = ROUTE_DETECTORS.filter((detector) => detector.id !== preferredId);
  return [preferred, ...others];
}

function logDetection(
  options: DetectRoutesOptions,
  detectorId: string,
  message: string,
  context?: RouteDetectionLogContext,
): void {
  if (!options.logger) {
    return;
  }
  options.logger.log({
    detectorId,
    message,
    context: {
      root: context?.root ?? options.projectRoot,
      limit: context?.limit,
      candidateCount: context?.candidateCount,
      selectedCount: context?.selectedCount,
    },
  });
}

async function findSpaHtml(projectRoot: string): Promise<string | undefined> {
  const candidates = [
    "dist/index.html",
    "build/index.html",
    "public/index.html",
    "index.html",
  ];
  for (const candidate of candidates) {
    const absolute = join(projectRoot, candidate);
    if (await pathExists(absolute)) {
      return absolute;
    }
  }
  return undefined;
}

function extractRoutesFromHtml(html: string): string[] {
  const routes: string[] = [];
  const seen = new Set<string>();
  const hrefPattern = /href\s*=\s*"(\/[^"]*)"/gi;
  const dataRoutePattern = /data-route\s*=\s*"(\/[^"]*)"/gi;
  const addRoute = (raw: string) => {
    const base = raw.split(/[?#]/)[0];
    if (!base || base.length === 0) {
      return;
    }
    const normalized = normaliseRoute(base);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      routes.push(normalized);
    }
  };
  let match: RegExpExecArray | null;
  while ((match = hrefPattern.exec(html)) !== null) {
    addRoute(match[1]);
  }
  while ((match = dataRoutePattern.exec(html)) !== null) {
    addRoute(match[1]);
  }
  return routes;
}
