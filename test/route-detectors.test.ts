import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { detectRoutes, type RouteDetectionLogEntry, type RouteDetectionLogger } from "../src/route-detectors.js";

const fixturesPath = (name: string): string => resolve("test/fixtures", name);

function createLogger(): { logger: RouteDetectionLogger; entries: RouteDetectionLogEntry[] } {
  const entries: RouteDetectionLogEntry[] = [];
  return {
    entries,
    logger: {
      log(entry: RouteDetectionLogEntry) {
        entries.push(entry);
      },
    },
  };
}

describe("detectRoutes", () => {
  it("detects routes from a Next.js app directory", async () => {
    const { logger, entries } = createLogger();
    const routes = await detectRoutes({ projectRoot: fixturesPath("next-app"), logger });
    const paths = routes.map((route) => route.path).sort();
    expect(paths).toEqual(["/", "/blog"]);
    expect(entries.at(-1)?.detectorId).toBe("next-app");
  });

  it("detects routes from a Next.js pages directory", async () => {
    const { logger, entries } = createLogger();
    const routes = await detectRoutes({ projectRoot: fixturesPath("next-pages"), logger });
    const paths = routes.map((route) => route.path).sort();
    expect(paths).toEqual(["/", "/blog"]);
    expect(entries.at(-1)?.detectorId).toBe("next-pages");
  });

  it("detects Remix file-system routes", async () => {
    const { logger, entries } = createLogger();
    const routes = await detectRoutes({ projectRoot: fixturesPath("remix"), logger });
    const paths = routes.map((route) => route.path).sort();
    expect(paths).toEqual(["/", "/blog/:slug"]);
    expect(entries.at(-1)?.detectorId).toBe("remix-routes");
  });

  it("falls back to SPA HTML crawling when no framework is detected", async () => {
    const { logger, entries } = createLogger();
    const routes = await detectRoutes({ projectRoot: fixturesPath("spa"), logger });
    const paths = routes.map((route) => route.path).sort();
    expect(paths).toEqual(["/", "/about", "/blog", "/pricing"]);
    expect(entries.at(-1)?.detectorId).toBe("spa-html");
  });
});
