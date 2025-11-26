declare module "lighthouse" {
  export interface LighthouseFlags {
    readonly port?: number;
    readonly output?: "json";
    readonly logLevel?: "silent" | "error" | "info" | "verbose";
    readonly onlyCategories?: readonly string[];
    readonly emulatedFormFactor?: "mobile" | "desktop";
  }

  export interface LighthouseRunnerResult {
    readonly lhr: unknown;
  }

  export default function lighthouse(url: string, options: LighthouseFlags): Promise<LighthouseRunnerResult>;
}
