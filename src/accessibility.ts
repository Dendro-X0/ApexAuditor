import { request as httpRequest } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { launch as launchChrome } from "chrome-launcher";
import type { ApexConfig, ApexDevice } from "./types.js";
import { createAxeScript } from "./axe-script.js";
import { CdpClient } from "./cdp-client.js";
import { buildUrl } from "./url.js";
import type { AxeResult, AxeSummary, AxeViolation } from "./accessibility-types.js";

type ChromeSession = {
  readonly port: number;
  readonly close: () => Promise<void>;
};

type JsonVersionResponse = {
  readonly webSocketDebuggerUrl: string;
};

type TargetSession = {
  readonly targetId: string;
  readonly sessionId: string;
};

type NavigationResponse = {
  readonly errorText?: string;
};

const DEFAULT_PARALLEL: number = 2;
const DEFAULT_TIMEOUT_MS: number = 30_000;
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

async function launchChromeSession(): Promise<ChromeSession> {
  const chrome = await launchChrome({
    chromeFlags: [...CHROME_FLAGS],
    logLevel: "silent",
  });
  const close = async (): Promise<void> => {
    try {
      await chrome.kill();
    } catch {
      /* noop */
    }
  };
  return { port: chrome.port, close };
}

async function fetchJsonVersion(port: number): Promise<JsonVersionResponse> {
  return await new Promise<JsonVersionResponse>((resolveVersion, rejectVersion) => {
    const req = httpRequest({ host: "localhost", port, path: "/json/version", method: "GET" }, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk.toString();
      });
      res.on("end", () => {
        try {
          const parsed: JsonVersionResponse = JSON.parse(data);
          resolveVersion(parsed);
        } catch (error: unknown) {
          rejectVersion(error instanceof Error ? error : new Error("Failed to parse json/version"));
        }
      });
    });
    req.on("error", (error) => rejectVersion(error));
    req.end();
  });
}

async function createTargetSession(client: CdpClient): Promise<TargetSession> {
  const created = await client.send<{ readonly targetId: string }>("Target.createTarget", { url: "about:blank" });
  const attached = await client.send<{ readonly sessionId: string }>("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  return { targetId: created.targetId, sessionId: attached.sessionId };
}

async function applyDevice(client: CdpClient, sessionId: string, device: ApexDevice): Promise<void> {
  if (device === "mobile") {
    await client.send("Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 2, mobile: true }, sessionId);
    await client.send(
      "Emulation.setUserAgentOverride",
      {
        userAgent: "Mozilla/5.0 (Linux; Android 12; Pixel 6 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Mobile Safari/537.36",
      },
      sessionId,
    );
    return;
  }
  await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
}

async function runAxeForPage(params: {
  readonly baseUrl: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
  readonly query?: string;
  readonly timeoutMs: number;
  readonly artifactsDir: string;
  readonly client: CdpClient;
}): Promise<AxeResult> {
  const { baseUrl, path, label, device, query, timeoutMs, artifactsDir, client } = params;
  const url: string = buildUrl({ baseUrl, path, query });
  const axeScript: string = createAxeScript();
  let runtimeErrorMessage: string | undefined;
  const session: TargetSession = await createTargetSession(client);
  try {
    await applyDevice(client, session.sessionId, device);
    await client.send("Page.enable", {}, session.sessionId);
    await client.send("Runtime.enable", {}, session.sessionId);
    const navResponse = await client.send<NavigationResponse>("Page.navigate", { url }, session.sessionId);
    if (navResponse.errorText) {
      throw new Error(navResponse.errorText);
    }
    await client.waitForEventForSession("Page.loadEventFired", session.sessionId, timeoutMs);
    await client.send("Runtime.evaluate", { expression: axeScript, awaitPromise: false }, session.sessionId);
    const evaluation = await client.send<{ readonly result?: { readonly value?: unknown } }>(
      "Runtime.evaluate",
      {
        expression:
          "(() => { return (globalThis.__axeCore && globalThis.__axeCore.run) ? globalThis.__axeCore.run() : { violations: [] }; })()",
        awaitPromise: true,
        returnByValue: true,
      },
      session.sessionId,
    );
    const value: unknown = evaluation.result?.value;
    const violations: readonly AxeViolation[] =
      value && typeof value === "object" && Array.isArray((value as { readonly violations?: unknown }).violations)
        ? ((value as { readonly violations: unknown }).violations as AxeViolation[])
        : [];
    const baseName: string = path.replace(/\//g, "_").replace(/^_/, "") || "page";
    const artifactPath: string = resolve(artifactsDir, `${baseName}_${device}_axe.json`);
    await writeFile(artifactPath, JSON.stringify({ url, violations }, null, 2), "utf8");
    return { url, path, label, device, violations };
  } catch (error: unknown) {
    runtimeErrorMessage = error instanceof Error ? error.message : String(error);
    return { url, path, label, device, violations: [], runtimeErrorMessage };
  } finally {
    try {
      await client.send("Target.closeTarget", { targetId: session.targetId });
    } catch {
      /* noop */
    }
  }
}

export async function runAccessibilityAudit(params: {
  readonly config: ApexConfig;
  readonly configPath: string;
  readonly parallelOverride?: number;
  readonly timeoutMs?: number;
  readonly artifactsDir: string;
}): Promise<AxeSummary> {
  const { config, configPath, parallelOverride, timeoutMs, artifactsDir } = params;
  await mkdir(artifactsDir, { recursive: true });
  const tasks = config.pages.flatMap((page) => page.devices.map((device) => ({ ...page, device })));
  const startedAt: string = new Date().toISOString();
  const comboCount: number = tasks.length;
  const resolvedParallel: number = Math.max(1, Math.min(parallelOverride ?? DEFAULT_PARALLEL, 4));
  const timeout: number = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const chrome: ChromeSession = await launchChromeSession();
  try {
    const version: JsonVersionResponse = await fetchJsonVersion(chrome.port);
    const client: CdpClient = new CdpClient(version.webSocketDebuggerUrl);
    await client.connect();
    const results: AxeResult[] = [];
    for (let i = 0; i < tasks.length; i += resolvedParallel) {
      const slice = tasks.slice(i, i + resolvedParallel);
      const batchResults = await Promise.all(
        slice.map((task) =>
          runAxeForPage({
            baseUrl: config.baseUrl,
            path: task.path,
            label: task.label,
            device: task.device,
            query: config.query,
            timeoutMs: timeout,
            artifactsDir,
            client,
          }),
        ),
      );
      results.push(...batchResults);
    }
    const completedAt: string = new Date().toISOString();
    const elapsedMs: number = Date.parse(completedAt) - Date.parse(startedAt);
    return {
      meta: { configPath, comboCount, startedAt, completedAt, elapsedMs },
      results,
    };
  } finally {
    await chrome.close();
  }
}
