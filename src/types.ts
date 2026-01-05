export type ApexDevice = "mobile" | "desktop";

export type ApexPageScope = "public" | "requires-auth";

/**
 * Throttling method for Lighthouse audits.
 * - "simulate": Fast, uses simulation (default). May produce lower scores than DevTools.
 * - "devtools": More accurate, matches Chrome DevTools results but slower.
 */
export type ApexThrottlingMethod = "simulate" | "devtools";

export interface ApexPageConfig {
  readonly path: string;
  readonly label: string;
  readonly devices: readonly ApexDevice[];
  readonly scope?: ApexPageScope;
}

export interface CategoryBudgetThresholds {
  readonly performance?: number;
  readonly accessibility?: number;
  readonly bestPractices?: number;
  readonly seo?: number;
}

export interface MetricBudgetThresholds {
  readonly lcpMs?: number;
  readonly fcpMs?: number;
  readonly tbtMs?: number;
  readonly cls?: number;
  readonly inpMs?: number;
}

export interface ApexBudgets {
  readonly categories?: CategoryBudgetThresholds;
  readonly metrics?: MetricBudgetThresholds;
}

export interface ApexConfig {
  readonly baseUrl: string;
  readonly query?: string;
  readonly buildId?: string;
  readonly chromePort?: number;
  readonly runs?: number;
  readonly auditTimeoutMs?: number;
  readonly gitIgnoreApexAuditorDir?: boolean;
  readonly logLevel?: "silent" | "error" | "info" | "verbose";
  /**
   * Throttling method for performance simulation.
   * - "simulate" (default): Fast but may produce lower scores than browser DevTools.
   * - "devtools": More accurate, matches Chrome DevTools results.
   */
  readonly throttlingMethod?: ApexThrottlingMethod;
  /**
   * CPU slowdown multiplier. Default is 4 (simulates mid-tier mobile device).
   * Lower values (1-2) for weaker host machines, higher (6-10) for powerful desktops.
   * Use Lighthouse's benchmark calculator to find optimal value for your machine.
   */
  readonly cpuSlowdownMultiplier?: number;
  /**
   * Number of pages to audit in parallel. Default is 1 (sequential).
   * Higher values speed up batch testing but may reduce accuracy due to resource contention.
   * Auto-default: up to 4 based on CPU/memory. Recommended: 2-4 for speed, 1 for most accurate results.
   */
  readonly parallel?: number;
  /**
   * Whether to perform a warm-up request before auditing.
   * Helps avoid cold start penalties on the first audit.
   */
  readonly warmUp?: boolean;
  readonly incremental?: boolean;
  readonly pages: readonly ApexPageConfig[];
  readonly budgets?: ApexBudgets;
}

export interface MetricValues {
  readonly lcpMs?: number;
  readonly fcpMs?: number;
  readonly tbtMs?: number;
  readonly cls?: number;
  readonly inpMs?: number;
}

export interface CategoryScores {
  readonly performance?: number;
  readonly accessibility?: number;
  readonly bestPractices?: number;
  readonly seo?: number;
}

export type ApexCategory = "performance" | "accessibility" | "best-practices" | "seo";

export interface OpportunitySummary {
  readonly id: string;
  readonly title: string;
  readonly estimatedSavingsMs?: number;
  readonly estimatedSavingsBytes?: number;
}

export interface NumericStats {
  readonly n: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly median: number;
  readonly p75: number;
  readonly stddev: number;
}

export interface ComboRunStats {
  readonly scores: {
    readonly performance?: NumericStats;
    readonly accessibility?: NumericStats;
    readonly bestPractices?: NumericStats;
    readonly seo?: NumericStats;
  };
  readonly metrics: {
    readonly lcpMs?: NumericStats;
    readonly fcpMs?: NumericStats;
    readonly tbtMs?: NumericStats;
    readonly cls?: NumericStats;
    readonly inpMs?: NumericStats;
  };
}

export interface PageDeviceSummary {
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
  readonly pageScope?: ApexPageScope;
  readonly scores: CategoryScores;
  readonly metrics: MetricValues;
  readonly opportunities: readonly OpportunitySummary[];
  readonly runStats?: ComboRunStats;
  readonly runtimeErrorCode?: string;
  readonly runtimeErrorMessage?: string;
}

export interface RunMeta {
  readonly configPath: string;
  readonly buildId?: string;
  readonly incremental: boolean;
  readonly resolvedParallel: number;
  readonly totalSteps: number;
  readonly comboCount: number;
  readonly executedCombos: number;
  readonly cachedCombos: number;
  readonly runsPerCombo: number;
  readonly executedSteps: number;
  readonly cachedSteps: number;
  readonly warmUp: boolean;
  readonly throttlingMethod: ApexThrottlingMethod;
  readonly cpuSlowdownMultiplier: number;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly elapsedMs: number;
  readonly averageStepMs: number;
}

export interface RunSummary {
  readonly meta: RunMeta;
  readonly results: readonly PageDeviceSummary[];
}
