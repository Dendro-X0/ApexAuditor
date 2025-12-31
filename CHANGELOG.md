# Changelog

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
