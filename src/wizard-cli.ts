import { access, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import prompts, { type PromptObject } from "prompts";
import { detectRoutes, type DetectedRoute, type RouteDetectorId } from "./route-detectors.js";
import { pathExists } from "./fs-utils.js";
import type { ApexConfig, ApexDevice, ApexPageConfig } from "./types.js";

interface WizardArgs {
  readonly configPath: string;
}

interface BaseAnswers {
  readonly baseUrl: string;
  readonly query?: string;
  readonly runs?: number;
}

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

interface ProjectProfileAnswer {
  readonly profile: ProjectProfileId;
}

interface DetectorChoiceAnswer {
  readonly detector: RouteDetectorId;
}

type ProjectProfileId = "next-app" | "next-pages" | "spa" | "remix" | "custom";

const PROFILE_TO_DETECTOR: Record<ProjectProfileId, RouteDetectorId | undefined> = {
  "next-app": "next-app",
  "next-pages": "next-pages",
  spa: "spa-html",
  remix: "remix-routes",
  custom: undefined,
};

const DEFAULT_BASE_URL = "http://localhost:3000" as const;
const DEFAULT_RUNS = 1;
const DEFAULT_PROJECT_ROOT = "." as const;
const DEFAULT_PRESELECT_COUNT = 5;
const DEFAULT_DEVICES: readonly ApexDevice[] = ["mobile", "desktop"] as const;
const PROMPT_OPTIONS = { onCancel: handleCancel } as const;
const profileQuestion: PromptObject = {
  type: "select",
  name: "profile",
  message: "Which project type are you configuring?",
  choices: [
    { title: "Next.js (App Router)", value: "next-app" },
    { title: "Next.js (Pages Router)", value: "next-pages" },
    { title: "Remix", value: "remix" },
    { title: "Single Page App (Vite/CRA/etc.)", value: "spa" },
    { title: "Custom/manual", value: "custom" },
  ],
};
const overwriteQuestion: PromptObject = {
  type: "confirm",
  name: "value",
  message: "Found existing config. Overwrite?",
  initial: false,
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
  {
    type: "number",
    name: "runs",
    message: "Number of Lighthouse runs per page/device",
    initial: DEFAULT_RUNS,
    min: 1,
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
  message: "Add your first page to audit?",
  initial: true,
};
const addMorePagesQuestion: PromptObject = {
  type: "confirm",
  name: "value",
  message: "Add another page to audit?",
  initial: false,
};
const detectRoutesQuestion: PromptObject = {
  type: "confirm",
  name: "value",
  message: "Attempt to auto-detect routes from your project?",
  initial: true,
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
    { title: "Next.js (App Router)", value: "next-app" },
    { title: "Next.js (Pages Router)", value: "next-pages" },
    { title: "Remix", value: "remix-routes" },
    { title: "SPA Crawl", value: "spa-html" },
  ],
};

function handleCancel(): true {
  console.log("Wizard cancelled. No config written.");
  process.exit(1);
  return true;
}

async function ask<T extends object>(question: PromptObject | readonly PromptObject[]): Promise<T> {
  const answers = await prompts(question as PromptObject | PromptObject[], PROMPT_OPTIONS);
  return answers as T;
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

async function ensureWritable(path: string): Promise<void> {
  if (!(await fileExists(path))) {
    return;
  }
  const response = await ask<{ value: boolean }>(overwriteQuestion);
  if (response.value) {
    return;
  }
  console.log("Aborted. Existing config preserved.");
  process.exit(0);
}

async function collectBaseAnswers(): Promise<BaseAnswers> {
  const answers = await ask<BaseAnswers>(baseQuestions);
  return {
    baseUrl: answers.baseUrl.trim(),
    query: answers.query && answers.query.length > 0 ? answers.query : undefined,
    runs: answers.runs,
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

async function maybeDetectPages(profile: ProjectProfileId): Promise<ApexPageConfig[]> {
  const shouldDetect = await ask<DetectRoutesAnswer>(detectRoutesQuestion);
  if (!shouldDetect.value) {
    return [];
  }
  const preferredDetector = await selectDetector(profile);
  const projectRootAnswer = await ask<ProjectRootAnswer>(projectRootQuestion);
  const absoluteRoot = resolve(projectRootAnswer.projectRoot);
  if (!(await pathExists(absoluteRoot))) {
    console.log(`No project found at ${absoluteRoot}. Skipping auto-detection.`);
    return [];
  }
  const routes = await detectRoutes({ projectRoot: absoluteRoot, preferredDetectorId: preferredDetector });
  if (routes.length === 0) {
    console.log("No routes detected. Add pages manually.");
    return [];
  }
  return selectDetectedRoutes(routes);
}

async function selectDetector(profile: ProjectProfileId): Promise<RouteDetectorId | undefined> {
  const preset = PROFILE_TO_DETECTOR[profile];
  if (preset) {
    return preset;
  }
  const choice = await ask<DetectorChoiceAnswer>(detectorChoiceQuestion);
  return choice.detector;
}

async function selectDetectedRoutes(routes: DetectedRoute[]): Promise<ApexPageConfig[]> {
  const response = await ask<RouteSelectionAnswer>(
    {
      type: "multiselect",
      name: "indexes",
      message: "Select routes to include",
      instructions: false,
      min: 1,
      choices: buildRouteChoices(routes),
    },
  );
  const indexes = response.indexes ?? [];
  if (indexes.length === 0) {
    console.log("No routes selected. Add pages manually.");
    return [];
  }
  return indexes.map((index: number) => convertRouteToPage(routes[index]));
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
  const profileAnswer = await ask<ProjectProfileAnswer>(profileQuestion);
  const baseAnswers = await collectBaseAnswers();
  const detectedPages = await maybeDetectPages(profileAnswer.profile);
  const pages = await collectPages(detectedPages);
  return {
    baseUrl: baseAnswers.baseUrl,
    query: baseAnswers.query,
    runs: baseAnswers.runs,
    pages,
  };
}

export async function runWizardCli(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const absolutePath = resolve(args.configPath);
  await ensureWritable(absolutePath);
  const config = await buildConfig();
  await writeFile(absolutePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  console.log(`Saved ApexAuditor config to ${absolutePath}`);
}
