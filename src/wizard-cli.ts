import { access, readFile, readdir, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";
import prompts, { type PromptObject } from "prompts";
import { detectRoutes, type DetectedRoute, type RouteDetectorId } from "./route-detectors.js";
import { discoverRuntimeRoutes } from "./sitemap-discovery.js";
import { pathExists } from "./fs-utils.js";
import { discoverNextProjects, type DiscoveredProject } from "./project-discovery.js";
import type { ApexConfig, ApexDevice, ApexPageConfig } from "./types.js";

interface WizardArgs {
  readonly configPath: string;
}

class WizardAbortError extends Error {
  public readonly reason: "cancelled" | "overwrite_declined";

  public constructor(reason: "cancelled" | "overwrite_declined") {
    super(reason);
    this.reason = reason;
  }
}

interface BaseAnswers {
  readonly baseUrl: string;
  readonly query?: string;
}

type LocalDevServerInfo = {
  readonly host: "localhost" | "127.0.0.1";
  readonly port: number;
};

interface PageAnswers {
  readonly path: string;
  readonly label: string;
  readonly devices: ApexDevice[];
}

interface DetectRoutesAnswer {
  readonly value: boolean;
}

interface ProjectRootAnswer {
  readonly projectRoot: string;
}

interface RouteSelectionAnswer {
  readonly indexes: number[];
}

interface RouteFilterConfirmAnswer {
  readonly value: boolean;
}

interface RouteFilterAnswer {
  readonly include: string;
  readonly exclude: string;
}

interface ProjectProfileAnswer {
  readonly profile: ProjectProfileId;
}

interface DetectorChoiceAnswer {
  readonly detector: RouteDetectorId;
}

interface ProjectSelectionAnswer {
  readonly projectRoot: string;
}

interface MonorepoAppSelectionAnswer {
  readonly root: string;
}

type ProjectProfileId = "next" | "nuxt" | "spa" | "remix" | "sveltekit" | "custom";

type MonorepoCandidate = {
  readonly root: string;
  readonly name: string;
  readonly profile: ProjectProfileId;
};

const PROFILE_TO_DETECTOR: Record<ProjectProfileId, RouteDetectorId | undefined> = {
  next: "next-app",
  nuxt: "nuxt-pages",
  spa: "spa-html",
  remix: "remix-routes",
  sveltekit: "sveltekit-routes",
  custom: undefined,
};

const DEFAULT_BASE_URL = "http://localhost:3000" as const;
const DEFAULT_PROJECT_ROOT = "." as const;
const DEFAULT_PRESELECT_COUNT = 5;
const DEFAULT_ROUTE_CAP = 50;
const DEFAULT_DEVICES: readonly ApexDevice[] = ["mobile", "desktop"] as const;
const PROMPT_OPTIONS = { onCancel: handleCancel } as const;
const profileChoices: readonly { readonly title: string; readonly value: ProjectProfileId }[] = [
  { title: "Next.js", value: "next" },
  { title: "Nuxt (Vue)", value: "nuxt" },
  { title: "Remix", value: "remix" },
  { title: "SvelteKit", value: "sveltekit" },
  { title: "Single Page App (Vite/CRA/etc.)", value: "spa" },
  { title: "Custom/manual", value: "custom" },
] as const;
const overwriteQuestion: PromptObject = {
  type: "confirm",
  name: "value",
  message: "Found existing config. Overwrite?",
  initial: true,
};
const baseQuestions: readonly PromptObject[] = [
  {
    type: "text",
    name: "baseUrl",
    message: "Base URL of the running app",
    initial: DEFAULT_BASE_URL,
    validate: (value: string) => (value.startsWith("http") ? true : "Enter a full http(s) URL."),
  },
  {
    type: "text",
    name: "query",
    message: "Query string appended to every route (optional)",
    initial: "",
  },
];
const pageQuestions: readonly PromptObject[] = [
  {
    type: "text",
    name: "path",
    message: "Page path (must start with /)",
    validate: (value: string) => (value.startsWith("/") ? true : "Path must start with '/'."),
  },
  {
    type: "text",
    name: "label",
    message: "Short label for reports",
  },
  {
    type: "multiselect",
    name: "devices",
    message: "Devices to audit",
    instructions: false,
    min: 1,
    choices: [
      { title: "Mobile", value: "mobile", selected: true },
      { title: "Desktop", value: "desktop", selected: true },
    ],
  },
];
const addFirstPageQuestion: PromptObject = {
  type: "confirm",
  name: "value",
  message: "No pages were auto-detected. Add a page to audit now? (You can always edit apex.config.json later)",
  initial: true,
};
const addMorePagesQuestion: PromptObject = {
  type: "confirm",
  name: "value",
  message: "Add another page to audit? (Optional — you can edit apex.config.json later)",
  initial: false,
};
const projectRootQuestion: PromptObject = {
  type: "text",
  name: "projectRoot",
  message: "Path to your web project root (relative or absolute)",
  initial: DEFAULT_PROJECT_ROOT,
};
const detectorChoiceQuestion: PromptObject = {
  type: "select",
  name: "detector",
  message: "Choose a detector to guide auto-discovery",
  choices: [
    { title: "Next.js", value: "next-app" },
    { title: "Nuxt (pages/)", value: "nuxt-pages" },
    { title: "Remix", value: "remix-routes" },
    { title: "SvelteKit", value: "sveltekit-routes" },
    { title: "SPA Crawl", value: "spa-html" },
    { title: "Static HTML (dist/build/out/public/src)", value: "static-html" },
  ],
};

const routeFilterConfirmQuestion: PromptObject = {
  type: "confirm",
  name: "value",
  message: "Filter detected routes with include/exclude patterns?",
  initial: false,
};

const routeFilterQuestions: readonly PromptObject[] = [
  {
    type: "text",
    name: "include",
    message: "Include patterns (comma-separated, optional)",
    initial: "",
  },
  {
    type: "text",
    name: "exclude",
    message: "Exclude patterns (comma-separated, optional)",
    initial: "",
  },
];

const ROUTE_FILTER_DEFAULT_ON_THRESHOLD: number = 15;

function buildSuggestedExcludePatterns(profile: ProjectProfileId): readonly string[] {
  if (profile === "next") {
    return ["/_next/*", "/api/*"];
  }
  if (profile === "nuxt") {
    return ["/__nuxt/*", "/api/*"];
  }
  if (profile === "sveltekit") {
    return ["/__data.json*", "/api/*"];
  }
  if (profile === "remix") {
    return ["/api/*"];
  }
  return [];
}

function buildRouteFilterQuestions(params: { readonly profile: ProjectProfileId; readonly suggestedExclude: readonly string[] }): readonly PromptObject[] {
  const excludeInitial: string = params.suggestedExclude.join(",");
  return [
    {
      type: "text",
      name: "include",
      message: "Include patterns (comma-separated, optional)",
      initial: "",
    },
    {
      type: "text",
      name: "exclude",
      message: "Exclude patterns (comma-separated, optional)",
      initial: excludeInitial,
    },
  ];
}

function handleCancel(): true {
  console.log("Wizard cancelled. No config written.");
  throw new WizardAbortError("cancelled");
}

async function ask<T extends object>(question: PromptObject | readonly PromptObject[]): Promise<T> {
  const answers = await prompts(question as PromptObject | PromptObject[], PROMPT_OPTIONS);
  return answers as T;
}

async function collectBaseAnswers(): Promise<BaseAnswers> {
  const answers = await ask<BaseAnswers>(baseQuestions);
  return {
    baseUrl: answers.baseUrl,
    query: answers.query,
  };
}

function tryParseLocalDevServer(baseUrl: string): LocalDevServerInfo | undefined {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return undefined;
  }
  const host: string = parsed.hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    return undefined;
  }
  const port: number = parsed.port.length > 0 ? Number(parsed.port) : NaN;
  if (!Number.isFinite(port) || port <= 0) {
    return undefined;
  }
  return { host, port };
}

async function collectBaseAnswersWithSafety(): Promise<BaseAnswers> {
  while (true) {
    const answers: BaseAnswers = await collectBaseAnswers();
    const info: LocalDevServerInfo | undefined = tryParseLocalDevServer(answers.baseUrl);
    if (!info) {
      return answers;
    }
    const confirmed = await ask<{ readonly value: boolean }>({
      type: "confirm",
      name: "value",
      message: `Base URL is ${answers.baseUrl}. Make sure the dev server is running for this project on port ${info.port} to avoid config conflicts when multiple projects are open. Continue?`,
      initial: true,
    });
    if (confirmed.value) {
      return answers;
    }
  }
}

function profileDisplayName(profile: ProjectProfileId): string {
  switch (profile) {
    case "next":
      return "Next.js";
    case "nuxt":
      return "Nuxt";
    case "remix":
      return "Remix";
    case "sveltekit":
      return "SvelteKit";
    case "spa":
      return "Single Page App";
    case "custom":
      return "Custom/manual";
    default: {
      const exhaustive: never = profile;
      return exhaustive;
    }
  }
}

function parseArgs(argv: readonly string[]): WizardArgs {
  let configPath: string | undefined;
  for (let index = 2; index < argv.length; index += 1) {
    const arg: string = argv[index];
    if ((arg === "--config" || arg === "-c") && index + 1 < argv.length) {
      configPath = argv[index + 1];
      index += 1;
    }
  }
  return { configPath: configPath ?? "apex.config.json" };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function buildLabel(routePath: string): string {
  if (routePath === "/") {
    return "home";
  }
  const segments: readonly string[] = routePath.split("/").filter(Boolean);
  const last: string = segments[segments.length - 1] ?? "page";
  return last.replace(/^:/, "");
}

function mergeRoutes(params: { readonly primary: readonly DetectedRoute[]; readonly secondaryPaths: readonly string[] }): readonly DetectedRoute[] {
  const merged: DetectedRoute[] = [...params.primary];
  const seen: Set<string> = new Set(params.primary.map((r) => r.path));
  for (const path of params.secondaryPaths) {
    if (!seen.has(path)) {
      seen.add(path);
      merged.push({ path, label: buildLabel(path), source: "sitemap" });
    }
  }
  return merged;
}

function readDependencies(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }
  const record = raw as Record<string, unknown>;
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      output[key] = value;
    }
  }
  return output;
}

async function detectProjectProfileFromPackageJsonPath(packageJsonPath: string): Promise<ProjectProfileId | undefined> {
  if (!(await pathExists(packageJsonPath))) {
    return undefined;
  }
  let raw: string;
  try {
    await access(packageJsonPath);
    raw = await readFile(packageJsonPath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const obj = parsed as { readonly dependencies?: unknown; readonly devDependencies?: unknown; readonly name?: unknown };
  const deps: Record<string, string> = { ...readDependencies(obj.dependencies), ...readDependencies(obj.devDependencies) };
  const has = (name: string): boolean => Object.prototype.hasOwnProperty.call(deps, name);
  if (has("nuxt")) {
    return "nuxt";
  }
  if (has("@sveltejs/kit")) {
    return "sveltekit";
  }
  if (has("next")) {
    return "next";
  }
  if (has("@remix-run/react") || has("@remix-run/node") || has("@remix-run/dev") || has("@react-router/dev")) {
    return "remix";
  }
  if (has("vite") || has("react-scripts")) {
    return "spa";
  }
  void obj;
  return undefined;
}

async function detectProjectProfileFromPackageJson(repoRoot: string): Promise<ProjectProfileId | undefined> {
  return detectProjectProfileFromPackageJsonPath(join(repoRoot, "package.json"));
}

async function readPackageName(repoRoot: string): Promise<string> {
  const packageJsonPath: string = join(repoRoot, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return repoRoot;
  }
  let raw: string;
  try {
    raw = await readFile(packageJsonPath, "utf8");
  } catch {
    return repoRoot;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const record = parsed as { readonly name?: unknown };
    return typeof record.name === "string" && record.name.length > 0 ? record.name : repoRoot;
  } catch {
    return repoRoot;
  }
}

async function findMonorepoCandidates(repoRoot: string): Promise<readonly MonorepoCandidate[]> {
  const containers: readonly string[] = ["apps", "packages"] as const;
  const candidates: MonorepoCandidate[] = [];
  for (const container of containers) {
    const containerPath: string = join(repoRoot, container);
    if (!(await pathExists(containerPath))) {
      continue;
    }
    let entries: readonly Dirent[] = [];
    try {
      entries = await readdir(containerPath, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const appRoot: string = join(containerPath, entry.name);
      const profile: ProjectProfileId | undefined = await detectProjectProfileFromPackageJson(appRoot);
      if (!profile) {
        continue;
      }
      const name: string = await readPackageName(appRoot);
      candidates.push({ root: appRoot, name, profile });
    }
  }
  return candidates;
}

async function resolveWizardProjectRoot(repoRoot: string): Promise<{ readonly repoRoot: string; readonly detectedProfile: ProjectProfileId | undefined }> {
  const rootProfile: ProjectProfileId | undefined = await detectProjectProfileFromPackageJson(repoRoot);
  if (rootProfile) {
    return { repoRoot, detectedProfile: rootProfile };
  }
  const candidates: readonly MonorepoCandidate[] = await findMonorepoCandidates(repoRoot);
  if (candidates.length === 0) {
    return { repoRoot, detectedProfile: undefined };
  }
  const choices = candidates.map((candidate) => ({
    title: `${candidate.name} (${candidate.root}) - ${profileDisplayName(candidate.profile)}`,
    value: candidate.root,
  }));
  const selected = await ask<MonorepoAppSelectionAnswer>({
    type: "select",
    name: "root",
    message: "Monorepo detected. Which app/package do you want to configure?",
    choices,
  });
  const resolvedRoot: string = selected.root ?? candidates[0]?.root ?? repoRoot;
  const resolvedProfile: ProjectProfileId | undefined = await detectProjectProfileFromPackageJson(resolvedRoot);
  return { repoRoot: resolvedRoot, detectedProfile: resolvedProfile };
}

function buildProfileQuestion(params: {
  readonly detectedProfile: ProjectProfileId | undefined;
}): PromptObject {
  const detected = params.detectedProfile;
  const choices = profileChoices.map((choice) => {
    const title: string = detected === choice.value ? `${choice.title} (detected)` : choice.title;
    return { title, value: choice.value };
  });
  const initial: number | undefined = detected ? Math.max(0, choices.findIndex((choice) => choice.value === detected)) : undefined;
  return {
    type: "select",
    name: "profile",
    message: "Which project type are you configuring?",
    choices,
    ...(typeof initial === "number" ? { initial } : {}),
  };
}

async function ensureWritable(path: string): Promise<void> {
  if (!(await fileExists(path))) {
    return;
  }
  const response = await ask<{ value: boolean }>(overwriteQuestion);
  if (response.value) {
    return;
  }
  console.log("Aborted. Existing config preserved.");
  throw new WizardAbortError("overwrite_declined");
}

function buildBaseConfig(answers: BaseAnswers): Pick<ApexConfig, "baseUrl" | "query" | "runs"> {
  return {
    baseUrl: answers.baseUrl.trim(),
    query: answers.query && answers.query.length > 0 ? answers.query : undefined,
    runs: 1,
  };
}

async function confirmAddPage(hasPages: boolean): Promise<boolean> {
  const question = hasPages ? addMorePagesQuestion : addFirstPageQuestion;
  const response = await ask<{ value: boolean }>(question);
  return response.value;
}

async function collectSinglePage(): Promise<ApexPageConfig> {
  const answers = await ask<PageAnswers>(pageQuestions);
  const label: string = answers.label && answers.label.length > 0 ? answers.label : answers.path;
  return { path: answers.path, label, devices: answers.devices };
}

async function collectPages(initialPages: readonly ApexPageConfig[]): Promise<ApexPageConfig[]> {
  const pages: ApexPageConfig[] = [...initialPages];
  if (pages.length > 0) {
    console.log("Tip: You can add/remove pages later by editing apex.config.json or re-running init.");
    return pages;
  }
  while (true) {
    const shouldAdd = await confirmAddPage(pages.length > 0);
    if (!shouldAdd) {
      if (pages.length === 0) {
        console.log("At least one page is required.");
        continue;
      }
      return pages;
    }
    pages.push(await collectSinglePage());
  }
}

async function maybeDetectPages(params: { readonly profile: ProjectProfileId; readonly baseUrl: string; readonly repoRoot: string }): Promise<ApexPageConfig[]> {
  const preferredDetector = await selectDetector(params.profile);
  const repoRoot: string = params.repoRoot;
  if (!(await pathExists(repoRoot))) {
    console.log(`No project found at ${repoRoot}. Skipping auto-detection.`);
    return [];
  }
  const detectionRoot = await chooseDetectionRoot({ profile: params.profile, repoRoot });
  const filesystemRoutes: readonly DetectedRoute[] = await detectRoutes({ projectRoot: detectionRoot, preferredDetectorId: preferredDetector, limit: DEFAULT_ROUTE_CAP });
  let combined: readonly DetectedRoute[] = filesystemRoutes;
  if (combined.length < DEFAULT_ROUTE_CAP) {
    const remaining: number = DEFAULT_ROUTE_CAP - combined.length;
    try {
      const runtimeRoutes: readonly string[] = await discoverRuntimeRoutes({ baseUrl: params.baseUrl, limit: remaining });
      combined = mergeRoutes({ primary: combined, secondaryPaths: runtimeRoutes });
    } catch {
      combined = filesystemRoutes;
    }
  }
  if (combined.length === 0) {
    console.log("No routes detected. Add pages manually.");
    return [];
  }
  console.log(`Detected ${combined.length} route(s) using auto-discovery.`);
  const suggestedExclude: readonly string[] = buildSuggestedExcludePatterns(params.profile);
  const initialFilter: boolean = combined.length >= ROUTE_FILTER_DEFAULT_ON_THRESHOLD || suggestedExclude.length > 0;
  const confirmQuestion: PromptObject = { ...routeFilterConfirmQuestion, initial: initialFilter };
  const shouldFilter: RouteFilterConfirmAnswer = await ask<RouteFilterConfirmAnswer>(confirmQuestion);
  const filtered: readonly DetectedRoute[] = shouldFilter.value
    ? await filterDetectedRoutes({ routes: combined, profile: params.profile, suggestedExclude })
    : combined;
  if (filtered.length === 0) {
    console.log("No routes remain after filtering. Add pages manually.");
    return [];
  }
  if (filtered.length !== combined.length) {
    console.log(`Filtered routes: ${filtered.length}/${combined.length}.`);
  }
  return selectDetectedRoutes(filtered);
}

async function filterDetectedRoutes(params: { readonly routes: readonly DetectedRoute[]; readonly profile: ProjectProfileId; readonly suggestedExclude: readonly string[] }): Promise<readonly DetectedRoute[]> {
  const questions: readonly PromptObject[] = buildRouteFilterQuestions({ profile: params.profile, suggestedExclude: params.suggestedExclude });
  const answers: RouteFilterAnswer = await ask<RouteFilterAnswer>(questions);
  const includePatterns: readonly string[] = splitPatterns(answers.include);
  const excludePatterns: readonly string[] = splitPatterns(answers.exclude);
  const includeRegexes: readonly RegExp[] = includePatterns.map((pattern) => compileGlob(pattern));
  const excludeRegexes: readonly RegExp[] = excludePatterns.map((pattern) => compileGlob(pattern));
  return params.routes.filter((route) => {
    const included: boolean = includeRegexes.length === 0 ? true : includeRegexes.some((regex) => regex.test(route.path));
    const excluded: boolean = excludeRegexes.some((regex) => regex.test(route.path));
    return included && !excluded;
  });
}

function splitPatterns(raw: string): readonly string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function compileGlob(pattern: string): RegExp {
  const escaped: string = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const wildcarded: string = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${wildcarded}$`);
}

async function chooseDetectionRoot({
  profile,
  repoRoot,
}: {
  readonly profile: ProjectProfileId;
  readonly repoRoot: string;
}): Promise<string> {
  const candidates: readonly MonorepoCandidate[] = await findMonorepoCandidates(repoRoot);
  const matching: readonly MonorepoCandidate[] = candidates.filter((candidate) => candidate.profile === profile);
  if (matching.length === 0) {
    if (profile !== "next") {
      return repoRoot;
    }
    const projects: readonly DiscoveredProject[] = await discoverNextProjects({ repoRoot });
    if (projects.length === 0) {
      return repoRoot;
    }
    if (projects.length === 1) {
      const onlyProject = projects[0] as DiscoveredProject;
      console.log(`Detected Next.js app at ${onlyProject.root}.`);
      return onlyProject.root;
    }
    const choices = projects.map((project) => ({
      title: `${project.name} (${project.root})`,
      value: project.root,
    }));
    const answer = await ask<ProjectSelectionAnswer>({
      type: "select",
      name: "projectRoot",
      message: "Multiple Next.js apps found. Which one do you want to audit?",
      choices,
    });
    return answer.projectRoot ?? repoRoot;
  }
  if (matching.length === 1) {
    const only: MonorepoCandidate = matching[0] as MonorepoCandidate;
    console.log(`Detected ${profileDisplayName(profile)} app at ${only.root}.`);
    return only.root;
  }
  const choices = matching.map((candidate) => ({
    title: `${candidate.name} (${candidate.root}) - ${profileDisplayName(candidate.profile)}`,
    value: candidate.root,
  }));
  const answer = await ask<ProjectSelectionAnswer>({
    type: "select",
    name: "projectRoot",
    message: `Multiple ${profileDisplayName(profile)} apps found. Which one do you want to audit?`,
    choices,
  });
  return answer.projectRoot ?? matching[0]?.root ?? repoRoot;
}

async function selectDetector(profile: ProjectProfileId): Promise<RouteDetectorId | undefined> {
  const preset = PROFILE_TO_DETECTOR[profile];
  if (preset) {
    return preset;
  }
  const choice = await ask<DetectorChoiceAnswer>(detectorChoiceQuestion);
  return choice.detector;
}

async function selectDetectedRoutes(routes: readonly DetectedRoute[]): Promise<ApexPageConfig[]> {
  const response = await ask<RouteSelectionAnswer>(
    {
      type: "multiselect",
      name: "indexes",
      message: "Select routes to include",
      instructions: true,
      hint: "Use Space to toggle, ↑/↓ to move, and Enter to confirm.",
      min: 1,
      choices: buildRouteChoices(routes),
    },
  );
  const indexes = response.indexes ?? [];
  const selected = indexes.map((index) => routes[index]).filter(Boolean);
  return selected.map((route) => ({
    path: route.path,
    label: route.label,
    devices: DEFAULT_DEVICES,
  }));
}

function buildRouteChoices(routes: readonly DetectedRoute[]): { title: string; value: number; selected: boolean }[] {
  return routes.map((route, index) => ({
    title: `${route.path} (${route.source})`,
    value: index,
    selected: index < DEFAULT_PRESELECT_COUNT,
  }));
}

function convertRouteToPage(route: DetectedRoute): ApexPageConfig {
  return {
    path: route.path,
    label: route.label,
    devices: DEFAULT_DEVICES,
  };
}

async function buildConfig(): Promise<ApexConfig> {
  const baseAnswers = await collectBaseAnswersWithSafety();
  const projectRootAnswer = await ask<ProjectRootAnswer>(projectRootQuestion);
  const initialRepoRoot: string = resolve(projectRootAnswer.projectRoot);
  const resolved = await resolveWizardProjectRoot(initialRepoRoot);
  const repoRoot: string = resolved.repoRoot;
  const detectedProfile: ProjectProfileId | undefined = resolved.detectedProfile;
  if (detectedProfile) {
    const detectedAnswer = await ask<{ readonly value: boolean }>({
      type: "confirm",
      name: "value",
      message: `Detected ${profileDisplayName(detectedProfile)} from package.json. Use this?`,
      initial: true,
    });
    if (detectedAnswer.value) {
      console.log("Tip: parallel workers auto-tune from CPU/memory. Override later with --parallel <n> or inspect with --show-parallel.");
      const detectedPages = await maybeDetectPages({ profile: detectedProfile, baseUrl: baseAnswers.baseUrl, repoRoot });
      const pages = await collectPages(detectedPages);
      return {
        baseUrl: baseAnswers.baseUrl,
        query: baseAnswers.query,
        runs: 1,
        pages,
      };
    }
  }
  const profileAnswer = await ask<ProjectProfileAnswer>(buildProfileQuestion({ detectedProfile }));
  console.log("Tip: parallel workers auto-tune from CPU/memory. Override later with --parallel <n> or inspect with --show-parallel.");
  const detectedPages = await maybeDetectPages({ profile: profileAnswer.profile, baseUrl: baseAnswers.baseUrl, repoRoot });
  const pages = await collectPages(detectedPages);
  return {
    baseUrl: baseAnswers.baseUrl,
    query: baseAnswers.query,
    runs: 1,
    pages,
  };
}

export async function runWizardCli(argv: readonly string[]): Promise<void> {
  try {
    const args = parseArgs(argv);
    const absolutePath = resolve(args.configPath);
    await ensureWritable(absolutePath);
    const config = await buildConfig();
    await writeFile(absolutePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    console.log(`Saved ApexAuditor config to ${absolutePath}`);
  } catch (error: unknown) {
    if (error instanceof WizardAbortError) {
      return;
    }
    throw error;
  }
}
