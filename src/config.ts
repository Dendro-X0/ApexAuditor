import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ApexConfig } from "./types.js";

/**
 * Load and minimally validate the ApexAuditor configuration file.
 */
export async function loadConfig({ configPath }: { configPath: string }): Promise<{
  readonly configPath: string;
  readonly config: ApexConfig;
}> {
  const absolutePath: string = resolve(configPath);
  const raw: string = await readFile(absolutePath, "utf8");
  const parsed: unknown = JSON.parse(raw) as unknown;
  const config: ApexConfig = normaliseConfig(parsed, absolutePath);
  return { configPath: absolutePath, config };
}

function normaliseConfig(input: unknown, absolutePath: string): ApexConfig {
  if (!input || typeof input !== "object") {
    throw new Error(`Invalid config at ${absolutePath}: expected object`);
  }
  const maybeConfig = input as {
    readonly baseUrl?: unknown;
    readonly query?: unknown;
    readonly chromePort?: unknown;
    readonly runs?: unknown;
    readonly pages?: unknown;
  };
  if (typeof maybeConfig.baseUrl !== "string" || maybeConfig.baseUrl.length === 0) {
    throw new Error(`Invalid config at ${absolutePath}: baseUrl must be a non-empty string`);
  }
  const pagesInput: unknown = maybeConfig.pages;
  if (!Array.isArray(pagesInput) || pagesInput.length === 0) {
    throw new Error(`Invalid config at ${absolutePath}: pages must be a non-empty array`);
  }
  const pages = pagesInput.map((page, index) => normalisePage(page, index, absolutePath));
  const baseUrl: string = maybeConfig.baseUrl.replace(/\/$/, "");
  const query: string | undefined = typeof maybeConfig.query === "string" ? maybeConfig.query : undefined;
  const chromePort: number | undefined = typeof maybeConfig.chromePort === "number" ? maybeConfig.chromePort : undefined;
  const runs: number | undefined = typeof maybeConfig.runs === "number" && maybeConfig.runs > 0 ? maybeConfig.runs : undefined;
  return {
    baseUrl,
    query,
    chromePort,
    runs,
    pages,
  };
}

function normalisePage(page: unknown, index: number, absolutePath: string) {
  if (!page || typeof page !== "object") {
    throw new Error(`Invalid page at index ${index} in ${absolutePath}: expected object`);
  }
  const maybePage = page as {
    readonly path?: unknown;
    readonly label?: unknown;
    readonly devices?: unknown;
  };
  if (typeof maybePage.path !== "string" || !maybePage.path.startsWith("/")) {
    throw new Error(`Invalid page at index ${index} in ${absolutePath}: path must start with '/'`);
  }
  const label: string = typeof maybePage.label === "string" && maybePage.label.length > 0
    ? maybePage.label
    : maybePage.path;
  const devicesInput: unknown = maybePage.devices;
  const devices: ("mobile" | "desktop")[] = Array.isArray(devicesInput) && devicesInput.length > 0
    ? devicesInput.map((d, deviceIndex) => {
        if (d !== "mobile" && d !== "desktop") {
          throw new Error(`Invalid device at pages[${index}].devices[${deviceIndex}] in ${absolutePath}`);
        }
        return d;
      })
    : ["mobile"];
  return {
    path: maybePage.path,
    label,
    devices,
  } as const;
}
