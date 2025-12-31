import type { ApexDevice } from "./types.js";

type MeasureTiming = {
  readonly ttfbMs?: number;
  readonly domContentLoadedMs?: number;
  readonly loadMs?: number;
};

type MeasureVitals = {
  readonly lcpMs?: number;
  readonly cls?: number;
  readonly inpMs?: number;
};

type MeasureLongTasks = {
  readonly count: number;
  readonly totalMs: number;
  readonly maxMs: number;
};

type MeasureNetwork = {
  readonly totalRequests: number;
  readonly totalBytes: number;
  readonly thirdPartyRequests: number;
  readonly thirdPartyBytes: number;
  readonly cacheHitRatio: number;
  readonly lateScriptRequests: number;
};

type MeasureArtifacts = {
  readonly screenshotPath?: string;
  readonly consoleErrors: readonly string[];
};

type MeasurePageDeviceSummary = {
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
  readonly timings: MeasureTiming;
  readonly vitals: MeasureVitals;
  readonly longTasks: MeasureLongTasks;
  readonly scriptingDurationMs?: number;
  readonly network: MeasureNetwork;
  readonly artifacts: MeasureArtifacts;
  readonly runtimeErrorMessage?: string;
};

type MeasureMeta = {
  readonly configPath: string;
  readonly resolvedParallel: number;
  readonly comboCount: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly elapsedMs: number;
  readonly averageComboMs: number;
};

export type MeasureSummary = {
  readonly meta: MeasureMeta;
  readonly results: readonly MeasurePageDeviceSummary[];
};
