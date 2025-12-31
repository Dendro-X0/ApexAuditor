import type { ApexDevice } from "./types.js";

export type AxeViolation = {
  readonly id: string;
  readonly impact?: string;
  readonly description?: string;
  readonly help?: string;
  readonly helpUrl?: string;
  readonly nodes: readonly { readonly html?: string; readonly target?: readonly string[] }[];
};

export type AxeResult = {
  readonly url: string;
  readonly path: string;
  readonly label: string;
  readonly device: ApexDevice;
  readonly violations: readonly AxeViolation[];
  readonly runtimeErrorMessage?: string;
};

export type AxeSummary = {
  readonly meta: {
    readonly configPath: string;
    readonly comboCount: number;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly elapsedMs: number;
  };
  readonly results: readonly AxeResult[];
};
