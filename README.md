# ApexAuditor

ApexAuditor is a small, framework-agnostic Lighthouse runner that gives you **fast, structured insights** across multiple pages and devices.

It is designed to:

- **Run anywhere**: attach to an existing Chrome instance (remote debugging) on Windows, macOS, or Linux.
- **Work with any web stack**: Next.js, Vite, Rails, static sites, etc. – as long as there is an HTTP server.
- **Summarize multiple pages at once**: homepage, blog, auth, search, and more.
- **Output developer-friendly reports**: one Markdown table + JSON, ready to paste into PRs or chat.

> V1 focuses on a solid, single-project core. Route auto-detection and monorepo orchestration will land in later versions.

---

## Quick start (single project)

### 1. Install dependencies

From the `apex-auditor` directory:

```bash
pnpm install
```

### 2. Start your web app

In your application repo (for example, a Next.js app running on port 3000):

```bash
pnpm start
# or: pnpm dev, npm run dev, etc.
```

Make sure the app is reachable at the `baseUrl` you will configure (default example: `http://localhost:3000`).

### 3. Start Chrome with remote debugging

ApexAuditor connects to an existing Chrome instance instead of launching its own. Start Chrome once with a debugging port (example for Windows):

```bash
"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" \
  --remote-debugging-port=9222 \
  --user-data-dir="%LOCALAPPDATA%\\ChromeApex"
```

On macOS or Linux the flags are the same; only the Chrome path changes.

### 4. Configure pages (wizard-friendly)

Run the guided wizard to scaffold `apex.config.json` and optionally auto-discover routes:

```bash
pnpm wizard
```

The wizard asks for the base URL, optional query string, desired Chrome port, run count, and can crawl popular frameworks (Next.js app/pages) to prefill routes before you fine-tune the list. You can still edit the file manually afterwards:

```jsonc
{
  "baseUrl": "http://localhost:3000",
  "query": "?lhci=1",
  "chromePort": 9222,
  "runs": 1,
  "pages": [
    { "path": "/", "label": "home", "devices": ["mobile", "desktop"] },
    { "path": "/blog", "label": "blog", "devices": ["mobile", "desktop"] },
    { "path": "/contact", "label": "contact", "devices": ["mobile"] }
  ]
}
```

> Tip: rerun `pnpm wizard -- --config custom/path.json` to regenerate configs for multiple projects, or pass a different `--project-root` when prompted to detect routes from another app.

- `baseUrl`: root URL of your running app.
- `query` (optional): query string appended to every URL (for example `?lhci=1` to disable analytics).
- `chromePort` (optional): remote debugging port (defaults to `9222`).
- `runs` (optional): how many times to run Lighthouse per page/device (results are averaged).
- `pages`: list of paths and devices to audit.

### 5. Run an audit

```bash
pnpm audit
```

This will:

- Run Lighthouse for every `page × device` defined in `apex.config.json`.
- Write structured results to `.apex-auditor/summary.json`.
- Write a human-readable table to `.apex-auditor/summary.md`.
- Print the same table to the terminal.

Example output:

```text
| Label | Path | Device  | P  | A  | BP | SEO | LCP (s) | FCP (s) | TBT (ms) | CLS   | Top issues |
|-------|------|---------|----|----|----|-----|---------|---------|----------|-------|-----------|
| home  | /    | mobile  | 95 |100 |100 |100  | 2.9     | 0.9     |   160    | 0.002 | render-blocking-resources (140ms); unused-javascript (55KB) |
| home  | /    | desktop |100 |100 |100 |100  | 0.6     | 0.4     |     0    | 0.016 | unused-javascript (55KB) |
```

You can paste this table directly into PRs, tickets, or chat to discuss optimizations.

---

## Configuration reference (V1)

```ts
// apex.config.json (TypeScript shape)
interface ApexPageConfig {
  path: string;          // URL path, must start with "/"
  label: string;         // short label for reports
  devices: ("mobile" | "desktop")[];
}

interface ApexConfig {
  baseUrl: string;       // e.g. "http://localhost:3000"
  query?: string;        // e.g. "?lhci=1"
  chromePort?: number;   // default: 9222
  runs?: number;         // default: 1
  pages: ApexPageConfig[];
}
```

Future versions will add:

- Automatic route discovery (for example, from Next.js `app/` routes or a crawler).
- Workspace-level configs for monorepos.
- CI integration recipes and HTML dashboards.

---

## Code structure (V1)

The codebase is intentionally small and modular:

- `src/types.ts` – shared type definitions for config and results.
- `src/config.ts` – loads and validates `apex.config.json`.
- `src/lighthouse-runner.ts` – runs Lighthouse for each page/device and normalises results.
- `src/cli.ts` – CLI entry point; orchestrates config + runner, writes JSON/Markdown.

All public modules use explicit TypeScript types and are written to be reusable in future integrations (route detectors, monorepo orchestration, CI adapters).

See `ROADMAP.md` for planned features and phases.
