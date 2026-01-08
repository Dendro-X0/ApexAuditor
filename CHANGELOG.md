# Changelog

## 0.4.2 - 2026-01-07

### Added
- Outputs: `red-issues.md` and `red-issues.json` (human-first ranked list of red issues across the suite).
- Distribution: portable ZIP now includes registry-free installer scripts (`release-assets/install.ps1`, `release-assets/install.sh`).
- CLI: `signaler upgrade` to self-update from GitHub Releases portable zip.

### Changed
- CLI: `signaler` is the primary command name; `apex-auditor` remains as a compatibility alias.

## 0.4.0 - 2026-01-05

### Added
- Config: `pages[].scope` (`public` | `requires-auth`) so auth-protected routes can be audited without polluting global suite scoring.
- Outputs: `issues.json.offenders` aggregates repeated offenders (e.g. unused JS files) and links each offender back to exact combos with artifact paths and JSON pointers.
- Outputs: `pwa.json` PWA-focused checks (HTTPS, service worker, offline signals) with per-route evidence pointers into `diagnostics-lite`.

### Changed
- Reporting now treats `requires-auth` routes as scoped observations (they still appear per-combo but do not change global totals).
- Workflow guidance (docs, reports, navigation) prioritizes fast iteration, rerunning worst/failing combos first, and only recommends `--stable` when parallel workers flake.

## 0.3.9 - 2026-01-03

### Added
- Outputs: `ai-fix.json` consolidated AI-first packet that aggregates per-combo fixes (scores, opportunities, key diagnostics hints, artifact links) and cross-route repeated offenders (e.g. top unused JS files, redirect chains).
- Outputs: `ai-fix.min.json` compact packet for token-efficient AI workflows.
- Outputs: `ai-ledger.json` one-run AI index (normalized issues + offenders + fix plan) with evidence pointers into `issues.json` and `lighthouse-artifacts/diagnostics-lite/`, plus per-combo `regressions`/`improvements` when a previous `.apex-auditor/summary.json` exists.
- Audit: restored optional multi-run support via `runs` in `apex.config.json`, emitting per-combo `runStats` (median/p75/stddev) to make Lighthouse variance visible.
- Audit: speed and artifact controls: `--ai-min-combos <n>`, `--no-ai-fix`, `--no-export`, and `--focus-worst <n>`.

### Changed
- Audit aggregation: when `runs > 1`, reported scores/metrics use median aggregation and include `runStats` for spread.
- Overview: includes a direct link to `ai-fix.json` in the Key files section.
- Overview: hides AI/export links when `--no-ai-fix` / `--no-export` is used.

## 0.3.8 - 2026-01-02

### Added
- Audit: `--diagnostics` captures DevTools-like Lighthouse tables + screenshots.
- Audit: `--lhr` additionally captures full Lighthouse result JSON per combo.
- Audit: `--flags` prints resolved audit flags/options and exits.
- Outputs: new AI-friendly artifacts: `summary-lite.json`, `issues.json`, and per-combo `diagnostics-lite/`.
- Outputs: optional gzip copies for large JSON artifacts (`*.json.gz`).
- Outputs: `triage.md` report optimized for fixing red issues first, linking to per-combo artifacts.
- Shell: `clear-screenshots` to remove `.apex-auditor/screenshots/`.
- Shell: `open-triage`, `open-screenshots`, `open-diagnostics`, `open-lhr`, `open-artifacts`.
- Config: `gitIgnoreApexAuditorDir` option to automatically add `.apex-auditor/` to `.gitignore`.

### Changed
- Route auto-detection: filters out unresolved dynamic routes (e.g. `[slug]`) to avoid inaccurate audits.
- Audit end-of-run output: prints clear artifact paths and counts.

### Fixed
- Shell: prevented prompt/input glitches after long-running commands (improved guided help + ready state handling).

## 0.3.7 - 2026-01-02

### Added
- Shell: `pages`/`routes` to print configured pages.
- Shell: `add-page`/`rm-page` to edit `apex.config.json` pages interactively.

### Changed
- Shell: improved stability so the process remains in a ready state after completing `init` and `audit`.
- Init wizard: smarter route filtering defaults for large route sets, with framework-specific suggested excludes.
- Audit: restored a running spinner animation during Lighthouse runs.
- Audit: large runs show a one-line TTY hint suggesting `--plan` and `--stable`.
- Lighthouse runner: improved stability for large projects and improved speed/accuracy.

### Fixed
- Shell: fixed cases where the process could exit after completing the init wizard or an audit run.

## 0.3.6 - 2026-01-01

### Added
- Init wizard: static HTML route discovery from `dist/`, `build/`, `out/`, `public/`, and `src/`.
- Init wizard: optional include/exclude pattern filtering for auto-detected routes.

### Changed
- Init wizard: route selection no longer blocks manual additions when auto-discovery finds routes.
- Init wizard: monorepo root selection improved for Nuxt/Remix/SvelteKit route discovery.

### Added
- Init wizard: detects project stack from `package.json` (Next.js, Nuxt, Remix/React Router, SvelteKit, SPA) and offers to use it.
- Init wizard: monorepo support by scanning `apps/*` and `packages/*` and prompting which app/package to configure.
- Nuxt route detection: filesystem route discovery from `pages/` with support for dynamic segments (Nuxt 2 `_id`, Nuxt 3 `[id]`).
- Hybrid route discovery: filesystem routes first, then top-up from `robots.txt`/`sitemap.xml` (default cap: 50).

### Changed
- Init wizard: confirmation prompts default to **Yes** on Enter (e.g. overwrite).
- Init wizard: Next.js options are now a single "Next.js" choice.

### Fixed
- Shell stability: cancelling the init wizard no longer crashes with `ERR_USE_AFTER_CLOSE`.

## 0.3.4 - 2026-01-01

### Added
- Measure output upgraded: terminal summary now includes a compact "slowest combos" table for fast analysis without opening JSON.
- New audit commands:
  - `bundle`: scans build outputs and writes `.apex-auditor/bundle-audit.json`.
  - `health`: fast HTTP checks for configured routes and writes `.apex-auditor/health.json`.
  - `links`: broken links audit (sitemap + HTML link extraction) and writes `.apex-auditor/links.json`.
  - `headers`: security headers audit and writes `.apex-auditor/headers.json`.
  - `console`: console errors + runtime exceptions audit and writes `.apex-auditor/console.json`.

### Changed
- Measure screenshots are now opt-in via `--screenshots` (default off) to keep runs fast.
- Audit accessibility pass is now opt-in via `--accessibility-pass` (default off).
- Shell `help` output reorganized into "Audit commands" and "Other commands" sections.

### Fixed
- Shell input handling: prevented leftover confirmation keystrokes from leaking into the ready prompt after audit runs.
- ETA stability: improved audit and measure ETA estimates under parallel runs.
- Spinner cleanup: ensured the spinner line is cleared before printing final results for bundle/health.

## 0.3.2 - 2025-12-31

### Added
- Export output redesigned: structured section layout with clean dividers, numbered suggested commands in a copy/paste block, and non-nested tables for regressions and deep audit targets.
- Inline score deltas and regressions-only filtering in summary/export views to spotlight changes between runs.
- Persistent shell-ready flow after `audit`/`measure` completes, with friendly prompts for missing configs and a new `init` command to launch the wizard.
- Shell UX improvements: Esc cancels long-running commands and returns to prompt; `audit` shows runtime page progress with page counts and ETA.
- Always-on accessibility sweep (axe-core) after audits with saved artifacts and a "top issues" summary.

### Changed
- Removed all background shading from CLI tables; kept colorized text only for a cleaner, legible terminal experience.
- Simplified wizard flow: automatic route detection and skipping manual page prompts when detections succeed.
- Audit progress spinner is now blue and starts after warm-up completes.

### Fixed
- Lighthouse runner throttling adjusted to avoid double throttling in devtools mode; added jittered backoff and transient error retries for stability.

## 0.3.1 - 2025-12-29

### Added
- Diff view in CLI: new **Changes** section compares the current run to the previous `.apex-auditor/summary.json` (avg score deltas, top regressions/improvements, added/removed combos).
- Auto buildId resolution for incremental mode: detects Next.js `.next/BUILD_ID` or git HEAD (no shell), and warns if unresolved instead of silently running incremental.
- Presets: `--quick` (runs=1 fast feedback) and `--accurate` (devtools throttling, warm-up, runs=3, parallel=2) with single-preset enforcement alongside existing `--fast`.

### Documentation
- CLI help and README describe `--quick`, `--accurate`, and the auto buildId behavior for incremental caching.

## 0.3.0 - 2025-12-29

### Added
- Auto-tuned parallel default that respects CPU/memory and falls back to 1 when attaching to an external Chrome instance.
- ETA-aware progress output in the CLI for audit runs.
- `--show-parallel` flag to print the resolved parallel worker count before execution.
- Structured meta in outputs: Markdown now includes a meta table; HTML report now shows a meta grid (parallel, throttling, timings, etc.).
- Console output now prints run meta (parallel, warm-up, throttling, CPU slowdown, combos, timings).

### Documentation
- README documents `--show-parallel` and the enriched Markdown/HTML outputs.
- Wizard copy notes auto-parallel defaults and how to override/inspect them.

### Tests
- `pnpm test` (vitest) passing.
