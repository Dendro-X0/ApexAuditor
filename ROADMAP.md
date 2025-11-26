# ApexAuditor Roadmap

This roadmap is intentionally focused. The goal is to deliver a **small but solid V1 core**, then layer smarter automation and integrations on top.

---

## Phase 1 – V1 Core (current focus)

**Goal:** Reliable, framework-agnostic Lighthouse summaries for a single project.

- **Execution model**
  - Attach to an already-running Chrome via `--remote-debugging-port`.
  - Avoid OS-specific Chrome launchers and temp directory issues.
- **Config**
  - `apex.config.json` with:
    - `baseUrl`, `query`, `chromePort`, `runs`.
    - Explicit `pages` with `path`, `label`, `devices` (mobile/desktop).
- **Engine**
  - Run Lighthouse for each `page × device`.
  - Support multiple runs per target and average scores/metrics.
- **Outputs**
  - `.apex-auditor/summary.json` – structured per-page, per-device results.
  - `.apex-auditor/summary.md` – Markdown table with:
    - Scores: Performance, Accessibility, Best Practices, SEO.
    - Metrics: LCP, FCP, TBT, CLS.
    - Top opportunity audits with estimated savings.
  - Same Markdown table printed to stdout.
- **DX**
  - Single `pnpm audit` command from the `apex-auditor` root.
  - Clear README with copy-paste commands for common OSes.

> Once V1 is stable and used on a few real projects, we move to route automation.

---

## Phase 2 – Route Detection & DX Helpers

**Goal:** Reduce manual config by discovering likely pages automatically while keeping explicit control.

- **Project detection**
  - Detect Next.js apps (presence of `next.config.*`, `app/` or `pages/`).
  - Fallback to a generic SPA/static-site detector when no framework is recognised.
- **Route discovery**
  - For Next.js `app/` routing: scan `app/**/page.{tsx,jsx,js}` and infer routes.
  - For `pages/` routing: scan `pages/**` similarly.
  - Generic fallback: light crawler starting from `/`, following internal links to a configurable depth and limit.
- **CLI enhancements**
  - `apex init` – generate an initial `apex.config.json` based on detected routes.
  - `apex routes` – list detected routes and indicate which will be audited.
- **Config overrides**
  - Allow include/exclude lists to fine-tune which routes are actually tested.

---

## Phase 3 – Monorepo Orchestration

**Goal:** Run ApexAuditor across multiple applications in a workspace.

- **Workspace config** (example `apex.workspaces.json`):

  ```jsonc
  {
    "projects": [
      {
        "name": "blogkit",
        "root": "StarterKit/next-blogkit",
        "start": "pnpm start",
        "baseUrl": "http://localhost:3000",
        "config": "apex.config.json"
      },
      {
        "name": "marketing-site",
        "root": "apps/marketing",
        "start": "pnpm dev",
        "baseUrl": "http://localhost:4000"
      }
    ]
  }
  ```

- **CLI**
  - `apex audit` from the workspace root:
    - Starts each project sequentially.
    - Runs audits using that project config or auto-detected routes.
    - Aggregates results with a `project` field.

---

## Phase 4 – CI Integration & Rich Reporting

**Goal:** Make ApexAuditor easy to run in CI and pleasant to inspect over time.

- **CI recipes**
  - GitHub Actions workflow examples (Linux runners) using `pnpm audit`.
  - Generic CI docs (GitLab CI, CircleCI, etc.).
- **Thresholds and gating**
  - Optional min-score thresholds per category (e.g. fail if mobile Performance < 90).
- **HTML reports / dashboard**
  - Convert `summary.json` into a richer HTML report with:
    - Per-page drill-down.
    - Cross-page hotspots (e.g. "unused-javascript" affecting N pages).
    - Trend graphs if previous summaries are available.

---

## Phase 5 – Advanced Features (ideas)

These are not commitments yet, but directions to explore once the core is proven useful on multiple large projects.

- **Changed-pages mode** – audit only routes likely affected by a given git diff.
- **Custom scoring rules** – per-team weighting of metrics or audits.
- **Plugin system** – allow projects to add their own derived metrics or annotations on top of Lighthouse data.

---

## Design principles

- **Small core, modular extensions** – keep the engine simple, move framework-specific behaviour into detectors.
- **Explicit over implicit** – auto-detection should suggest, not silently hide, what is being tested.
- **DX first** – a single command and a single Markdown table should be enough to start a performance conversation.
- **Cross-platform** – avoid assumptions about OS, shells, or browsers beyond standard Chrome flags.
