# ApexAuditor

ApexAuditor is a small, framework-agnostic Lighthouse runner that gives you **fast, structured insights** across multiple pages and devices.

It focuses on:

- **Multi-page, multi-device audits**: run Lighthouse across your key flows in one shot.
- **Framework flexibility**: works with any stack that serves HTTP (Next.js, Remix, Vite/React, SvelteKit, Rails, static sites, etc.).
- **Smart route discovery**: auto-detects routes for Next.js (App/Pages), Remix, SvelteKit, and can crawl generic SPAs.
- **Developer-friendly reports**: readable console output, Markdown tables, HTML reports, and JSON summaries for CI.
- **Configurable throttling**: tune CPU/network throttling for accuracy vs speed trade-offs.
- **Parallel execution**: speed up batch testing with multiple Chrome instances.

---

## Example output

Terminal summary:

![Example terminal output 1](./public/example_output_1.png)

![Example terminal output 2](./public/example_output_2.png)

Wizard route selection:

![Wizard screenshot](./public/wizard_1.png)

---

## Installation

Install as a dev dependency (recommended):

```bash
pnpm add -D apex-auditor
# or
npm install --save-dev apex-auditor
```

You can also run it without installing by using your package manager's "dlx"/"npx" style command, for example:

```bash
pnpm dlx apex-auditor@latest wizard
```

---

## Common commands

All commands are available as a CLI named `apex-auditor` once installed.

### Quickstart (auto-detect routes and run a one-off audit)

```bash
apex-auditor quickstart --base-url http://localhost:3000
```

### Wizard (interactive config with route auto-detection)

```bash
apex-auditor wizard
```

The wizard can detect routes for:

- Next.js (App Router / Pages Router)
- Remix
- SvelteKit
- Single Page Apps (Vite/CRA/etc., via HTML crawl)

### Audit (run using an existing config)

```bash
apex-auditor audit --config apex.config.json
```

**CLI flags:**

| Flag | Description |
|------|-------------|
| `--ci` | Enable CI mode with budgets and non-zero exit codes |
| `--no-color` / `--color` | Control ANSI colours in console output |
| `--log-level <level>` | Override Lighthouse log level (`silent`, `error`, `info`, `verbose`) |
| `--throttling <method>` | Throttling method: `simulate` (fast) or `devtools` (accurate) |
| `--cpu-slowdown <n>` | CPU slowdown multiplier (1-20, default: 4) |
| `--parallel <n>` | Number of pages to audit in parallel (1-10) |
| `--warm-up` | Perform warm-up requests before auditing |
| `--open` | Auto-open HTML report in browser after audit |
| `--json` | Output JSON to stdout (for piping) |
| `--show-parallel` | Print the resolved parallel worker count before running |
| `--mobile-only` | Only audit mobile device configurations |
| `--desktop-only` | Only audit desktop device configurations |

---

## Output files

After each audit, results are saved to `.apex-auditor/`:

- `summary.json` – structured JSON results
- `summary.md` – Markdown table plus a structured meta section (parallel, timings, throttling)
- `report.html` – visual HTML report with score circles, metrics, and a meta grid (resolved parallel, elapsed, avg/step)

---

## Configuration

Example `apex.config.json`:

```json
{
  "baseUrl": "http://localhost:3000",
  "runs": 3,
  "throttlingMethod": "devtools",
  "cpuSlowdownMultiplier": 4,
  "parallel": 2,
  "warmUp": true,
  "pages": [
    { "path": "/", "label": "home", "devices": ["mobile", "desktop"] },
    { "path": "/docs", "label": "docs", "devices": ["mobile"] }
  ],
  "budgets": {
    "categories": { "performance": 80, "accessibility": 90 },
    "metrics": { "lcpMs": 2500, "inpMs": 200 }
  }
}
```

---

## Metrics tracked

- **LCP** (Largest Contentful Paint)
- **FCP** (First Contentful Paint)
- **TBT** (Total Blocking Time)
- **CLS** (Cumulative Layout Shift)
- **INP** (Interaction to Next Paint) - Core Web Vital

---

## Further documentation

For detailed guides, configuration options, and CI examples, see the `docs/` directory:

- `docs/getting-started.md` – installation, quickstart, wizard, and audit flows.
- `docs/configuration-and-routes.md` – `apex.config.json` schema and route detection details.
- `docs/cli-and-ci.md` – CLI flags, CI mode, budgets, and example workflows.

---

## License

MIT
