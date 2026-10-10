**English** | [简体中文](README.zh-CN.md)

# Open Code Review Desktop

An **unofficial Windows desktop GUI** for [`alibaba/open-code-review`](https://github.com/alibaba/open-code-review) (`ocr`) — Alibaba's AI code review CLI, 45k+ stars.

The review engine is the official, **unmodified** `ocr` binary. This project only wraps it: it builds the command line, streams progress, parses the JSON output, and gives you a GUI for scoping, cost control, findings triage, and session history. No review logic is reimplemented here.

---

## Status

`v0.1.9` (latest) — usable, verified against `ocr v1.12.13`.

Verified end-to-end against the real CLI, without spending tokens:

- all four review scopes, and `--preview` for workspace / range / commit / scan
- the per-mode flag whitelist (`ocr scan` rejects `--effort`, `--no-filter` and `--background-file`; sending them would abort the whole run)
- keeping several providers configured, switching the active one, and the per-run override (`--provider` / `--model` reach only that one command line, never the global config)
- testing the connection from the form values (the CLI runs in an empty temp HOME, so nothing is written), the model names a rejected request lists becoming one-click fixes, and the automatic re-test after saving
- failure output handling, session listing / loading / HTML export / deletion, `ocr rules check`, `ocr llm providers` parsing
- the packaged app boots and reaches the bundled binary
- the run log streams the CLI's own progress lines live (`full-scan: N file(s) discovered`, `estimated cost: …`, `scan dispatch: …`, `Session: …`, per-file exclusions and failures) while keeping the failure payload out of it
- a completed whole-file scan against a live provider: 1 file, 4 findings, 103K tokens, 3m36s — the results page renders that payload
- live progress during a run (files discovered, completed tool calls, comments so far, the CLI's own cost estimate), with per-tool-call chatter counted rather than streamed; large scans are gated behind an explicit size/cost confirmation
- `ocr llm test` against a live provider, including the tool-call round trip

**Not** yet exercised in-app: the `project_summary` block on a finished scan (the CLI only puts it in the run payload, never in `session show --json`, so it cannot be checked by reopening an old session). A real review's findings themselves do render — a completed scan's 4 comments were loaded from its session and shown in the results list.

## Why a GUI

The CLI is excellent but you live in a terminal: reading 40 line-level findings, telling "partial" apart from "clean", and re-running an interrupted review all require remembering flags and session ids. This wrapper makes those things visible and hard to get wrong.

## Features

| | |
| --- | --- |
| **Four scopes** | workspace changes · branch range (merge-base) · single commit · full-file scan |
| **Zero-cost preview first** | list the files that will be reviewed, with the *reason* each file was excluded (binary, secret path, unsupported type…), before any token is spent |
| **Cost guardrails** | `--max-tokens-budget` and `--timeout` are first-class inputs, not hidden flags |
| **Honest run status** | `complete / partial / failed / completed_with_errors` badges, plus the exact list of files that were **not** reviewed and why — a truncated run never looks like a clean one |
| **Resume** | interrupted, cancelled or partially failed runs can be resumed via official sessions; already-reviewed files are not billed twice |
| **Session history** | browse, load, resume, export a self-contained HTML report, delete |
| **Accurate code context** | when a review targets a ref, the code pane reads that file *at that ref* (`git show`), not your working copy |
| **Triage** | severity / category / text filters, `↑` `↓` or `j` `k` navigation, copy suggestion code, export JSON |
| **First-run guidance** | a three-step guide, ref validation as you type, and Chinese hints translated from raw CLI errors |
| **Many providers, per-run switching** | keep several providers configured at once; *Set as current* decides the default, and the review page can override provider and model for a single run (same as `--provider` / `--model`) without rewriting your config |
| **Test before you save** | *Test connection* checks the values currently in the form — nothing is written, and saving then runs the check automatically. When a vendor rejects the model name, the names it accepts become clickable buttons that fill the field. |
| **In-app updates** | The installed build checks the published release on launch, downloads in the background, verifies the SHA-512 checksum and restarts on your word — no returning to the browser |
| **Local config stays local** | everything is written through `ocr config set` into `~/.opencodereview/config.json`; the app keeps no separate copy of your key and talks only to the endpoint you configure |

## Install

**Option A — installer (recommended).** Download the `*-setup.exe` for the release you want from [Releases](../../releases) and run it. Per-user install, no administrator rights. Because it is unsigned, SmartScreen may warn — choose *More info → Run anyway*.

**Option B — portable.** Run the `*-portable.exe` directly, no installation.

> The v0.1.0 assets were renamed in place to `open-code-review-desktop-0.1.0-*.exe` after this project was renamed from `ocr-desktop`; the bytes are unchanged (verified by SHA-256), but the pre-rename download URLs now return 404.

**Option C — from source.**

```bash
npm install      # downloads the native ocr binary (~55 MB)
npm run dev      # Vite HMR + Electron
npm start        # build the UI, then run it
npm run dist     # build the Windows installer into release/
```

## First run

1. Pick a repository in the top bar (must be a git repo root; Git ≥ 2.41 on `PATH`).
2. In **Settings**, choose a provider, enter the API key and model name and hit **Test connection** — it checks the values in the form, nothing needs to be saved first; saving runs it again automatically. Several providers can stay configured at once: *Save only* stores one without taking over, and *Set as current* switches later.
3. Back in **Review**, click **Preview file list** (free), check the scope, then start the review.

## Architecture

```
src/                     React 19 + TypeScript + Tailwind v4 + Radix UI (built by Vite into out/)
main.js                  Electron main process, IPC handlers, window state
ocr-service.js           The wrapper contract: flag whitelist per mode, output parsing, sessions
git-service.js           Repository metadata, ref resolution, reading a file at a given ref
preload.js               Typed contextBridge surface
```

Two constraints worth knowing before you touch the build:

- **`asar` must stay `false`.** With asar enabled, `resolveNativeBinary()` returns an `app.asar\…` path, `fs.existsSync()` lies (Electron patches only `fs`), and `spawn()` fails with `ENOENT` — every review silently breaks.
- The UI bundle goes to **`out/`**, not `dist/`, and is loaded with `base: './'` so it works over `file://`.

## Known limitations

- Built and verified on Windows x64 only; Git must be on `PATH`.
- **Auto-update applies to the NSIS setup build only.** The portable exe re-extracts to a temp dir each run and has no install root to replace, so it links to the releases page instead.
- Releases must ship `latest.yml` and `*-setup.exe.blockmap` next to the binaries; without them the updater cannot see a version at all.
- Installers are **unsigned**, so SmartScreen will warn on first launch.
- The CLI exposes no model catalogue, so the model name is still typed by hand — a rejected name makes the vendor turn its accepted names into clickable buttons (see [alibaba/open-code-review#1694](https://github.com/alibaba/open-code-review/issues/1694)).
- The dev instance and the installed app share one user-data directory, so the **single-instance lock makes whichever starts second exit silently**.

## Not affiliated

Not an official Alibaba project, and not endorsed by it. `ocr` and its binary are covered by their own Apache-2.0 license; see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Build and usage details for contributors: [`使用说明.md`](使用说明.md) (中文).
