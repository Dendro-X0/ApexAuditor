import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./fs-utils.js";
import { UiTheme } from "./ui/ui-theme.js";

type PackageManagerId = "pnpm" | "yarn" | "npm" | "bun" | "deno" | "unknown";

type PackageJsonScripts = {
  readonly dev?: unknown;
  readonly start?: unknown;
  readonly build?: unknown;
};

type PackageJson = {
  readonly scripts?: PackageJsonScripts;
};

type Suggestions = {
  readonly packageManager: PackageManagerId;
  readonly suggestedDevCommands: readonly string[];
  readonly suggestedProdCommands: readonly string[];
};

async function readPackageJsonScripts(projectRoot: string): Promise<PackageJsonScripts> {
  const packageJsonPath: string = join(projectRoot, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return {};
  }
  try {
    const raw: string = await readFile(packageJsonPath, "utf8");
    const parsed: unknown = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as PackageJson;
    const scripts: PackageJsonScripts | undefined = record.scripts;
    if (!scripts || typeof scripts !== "object") {
      return {};
    }
    return scripts;
  } catch {
    return {};
  }
}

async function detectPackageManager(projectRoot: string): Promise<PackageManagerId> {
  const pnpmLockPath: string = join(projectRoot, "pnpm-lock.yaml");
  if (await pathExists(pnpmLockPath)) {
    return "pnpm";
  }
  const yarnLockPath: string = join(projectRoot, "yarn.lock");
  if (await pathExists(yarnLockPath)) {
    return "yarn";
  }
  const npmLockPath: string = join(projectRoot, "package-lock.json");
  if (await pathExists(npmLockPath)) {
    return "npm";
  }
  const bunLockPath: string = join(projectRoot, "bun.lockb");
  if (await pathExists(bunLockPath)) {
    return "bun";
  }
  const bunLockTextPath: string = join(projectRoot, "bun.lock");
  if (await pathExists(bunLockTextPath)) {
    return "bun";
  }
  const denoConfigPath: string = join(projectRoot, "deno.json");
  if (await pathExists(denoConfigPath)) {
    return "deno";
  }
  const denoConfigCPath: string = join(projectRoot, "deno.jsonc");
  if (await pathExists(denoConfigCPath)) {
    return "deno";
  }
  const packageJsonPath: string = join(projectRoot, "package.json");
  if (await pathExists(packageJsonPath)) {
    return "npm";
  }
  return "unknown";
}

function buildRunCommand(pm: PackageManagerId, script: string): string {
  if (pm === "pnpm") {
    return `pnpm ${script}`;
  }
  if (pm === "yarn") {
    return `yarn ${script}`;
  }
  if (pm === "bun") {
    return `bun run ${script}`;
  }
  if (pm === "deno") {
    return `deno task ${script}`;
  }
  if (pm === "npm") {
    return `npm run ${script}`;
  }
  return `${script}`;
}

function uniqueNonEmpty(values: readonly string[]): readonly string[] {
  const seen: Set<string> = new Set();
  const out: string[] = [];
  for (const value of values) {
    const trimmed: string = value.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

async function buildSuggestions(projectRoot: string): Promise<Suggestions> {
  const packageManager: PackageManagerId = await detectPackageManager(projectRoot);
  const scripts: PackageJsonScripts = await readPackageJsonScripts(projectRoot);
  const hasDev: boolean = typeof scripts.dev === "string";
  const hasStart: boolean = typeof scripts.start === "string";
  const hasBuild: boolean = typeof scripts.build === "string";
  const fallbackDev: string = buildRunCommand(packageManager, "dev");
  const fallbackStart: string = buildRunCommand(packageManager, "start");
  const fallbackBuild: string = buildRunCommand(packageManager, "build");
  const devCommands: string[] = [hasDev ? buildRunCommand(packageManager, "dev") : fallbackDev];
  const prodCommands: string[] = [];
  if (hasBuild && hasStart) {
    prodCommands.push(`${fallbackBuild} && ${fallbackStart}`);
  } else if (hasStart) {
    prodCommands.push(fallbackStart);
  } else if (hasBuild) {
    prodCommands.push(fallbackBuild);
  }
  return {
    packageManager,
    suggestedDevCommands: uniqueNonEmpty(devCommands),
    suggestedProdCommands: uniqueNonEmpty(prodCommands),
  };
}

export async function buildDevServerGuidanceLines(params: {
  readonly projectRoot: string;
  readonly baseUrl: string;
}): Promise<readonly string[]> {
  const noColor: boolean = Boolean(process.env.NO_COLOR) || process.env.CI === "true";
  const theme: UiTheme = new UiTheme({ noColor });
  const parsedUrl: URL = new URL(params.baseUrl);
  const portText: string = parsedUrl.port.length > 0 ? parsedUrl.port : parsedUrl.protocol === "https:" ? "443" : "80";
  const suggestions: Suggestions = await buildSuggestions(params.projectRoot);
  const lines: string[] = [];
  lines.push(`Target baseUrl is ${params.baseUrl} (port ${portText}).`);
  lines.push("Start your dev server before running audits, and make sure it listens on the same port.");
  if (suggestions.packageManager !== "unknown") {
    lines.push(`Detected package manager: ${suggestions.packageManager}.`);
  }
  if (suggestions.suggestedDevCommands.length > 0) {
    lines.push("Suggested dev command:");
    for (const cmd of suggestions.suggestedDevCommands) {
      lines.push(`  ${theme.cyan(cmd)}`);
    }
  }
  if (suggestions.suggestedProdCommands.length > 0) {
    lines.push("Suggested production-like command (recommended for stable Lighthouse results):");
    for (const cmd of suggestions.suggestedProdCommands) {
      lines.push(`  ${theme.cyan(cmd)}`);
    }
  }
  lines.push("If the port is different, update apex.config.json: baseUrl.");
  return lines;
}
