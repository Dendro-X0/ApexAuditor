export type ApexDevice = "mobile" | "desktop";

export interface ApexPageConfig {
  readonly path: string;
  readonly label: string;
  readonly devices: readonly ApexDevice[];
}

export interface ApexConfig {
  readonly baseUrl: string;
  readonly query?: string;
  readonly chromePort?: number;
  readonly runs?: number;
  readonly pages: readonly ApexPageConfig[];
}

export interface MetricValues {
  readonly lcpMs?: number;
  readonly fcpMs?: number;
  readonly tbtMs?: number;
  readonly cls?: number;
}

export interface CategoryScores {
  readonly performance?: number;
  readonly accessibility?: number;
  readonly bestPractices?: number;
  readonly seo?: number;
}

export interface OpportunitySummary {
  readonly id: string;
  readonly title: string;
  readonly estimatedSavingsMs?: number;
  readonly estimatedSavingsBytes?: number;
}

export interface PageDeviceSummary {
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
  readonly scores: CategoryScores;
  readonly metrics: MetricValues;
  readonly opportunities: readonly OpportunitySummary[];
}

export interface RunSummary {
  readonly configPath: string;
  readonly results: readonly PageDeviceSummary[];
}
