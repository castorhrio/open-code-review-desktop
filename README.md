**English** | [简体中文](README.zh-CN.md)

# Open Code Review Desktop

An **unofficial cross-platform desktop GUI** for [`alibaba/open-code-review`](https://github.com/alibaba/open-code-review) (`ocr`) — Alibaba's AI code review CLI, 45k+ stars. Ships for **Windows, macOS and Linux**.

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

**Option A — Windows installer (recommended).** Download the `*-setup.exe` for the release you want from [Releases](../../releases) and run it. The wizard lets you pick the install directory, shows the install path when it finishes, offers to launch the app, and creates desktop + Start-menu shortcuts **plus a Start-menu "卸载 / Uninstall" entry**. Per-user install by default, no administrator rights. Because it is unsigned, SmartScreen may warn — choose *More info → Run anyway*.

**Option B — Windows portable.** Run the `*-portable.exe` directly, no installation. It extracts to a temp dir each run, writes nothing to the registry, and has no uninstaller — just delete the exe.

**Option C — macOS.** Open the `*-mac-<arch>.dmg` and drag the app to *Applications* (`x64` for Intel, `arm64` for Apple Silicon). The build is **unsigned**, so the first launch needs *System Settings → Privacy & Security → Open Anyway*, or right-click → *Open*.

**Option D — Linux.** `chmod +x` the `*-linux-<arch>.AppImage` and run it, or install the `.deb` (`sudo apt install ./…deb`).

> Uninstalling never removes `~/.opencodereview/` (your API key and session history live there), so a reinstall keeps working. On Windows you can uninstall from the Start menu, from *Settings → About & Uninstall* inside the app, or from *Settings → Apps*.

> The v0.1.0 assets were renamed in place to `open-code-review-desktop-0.1.0-*.exe` after this project was renamed from `ocr-desktop`; the bytes are unchanged (verified by SHA-256), but the pre-rename download URLs now return 404.

**Option E — from source.**

```bash
npm install              # downloads the native ocr binary for THIS platform (~55 MB)
npm run dev              # Vite HMR + Electron
npm start                # build the UI, then run it
npm run dist             # Windows installer + portable into release/
npm run fetch:binaries   # pull the other platforms' binaries (needed to cross-build)
npm run dist:mac         # macOS dmg + zip      (build on macOS)
npm run dist:linux       # Linux AppImage + deb (build on Linux/WSL)
```

## First run

1. Pick a repository in the top bar (must be a git repo root; Git ≥ 2.41 on `PATH`).
2. In **Settings**, choose a provider, enter the API key and model name and hit **Test connection** — it checks the values in the form, nothing needs to be saved first; saving runs it again automatically. Several providers can stay configured at once: *Save only* stores one without taking over, and *Set as current* switches later.
3. Back in **Review**, click **Preview file list** (free), check the scope, then start the review.

## Architecture

```
src/                     React 19 + TypeScript + Tailwind v4 + Radix UI (built by Vite into out/)
src/components/ui/       Primitives: button, form, overlay, and layout.tsx — the layout/design spec
src/styles.css           Design tokens: surfaces, ink ramp, 4-step type ramp, layout measures
main.js                  Electron main process, IPC handlers, window state
security.js              Navigation / window-creation policy for the renderer
ocr-service.js           The wrapper contract: flag whitelist per mode, output parsing, sessions
git-service.js           Repository metadata, ref resolution, reading a file at a given ref
preload.js               Typed contextBridge surface
build/installer.nsh      NSIS customisation: welcome/finish copy, details panel, progress-bar mode, Start-menu uninstall entry
build/after-pack.cjs     Prunes the ocr binaries that don't match the target platform/arch
build/fetch-binaries.cjs Downloads the ocr binary for platforms npm didn't install
tools/                   The checks described under "Verifying changes"
```

Two constraints worth knowing before you touch the build:

- **`asar` must stay `false`.** With asar enabled, `resolveNativeBinary()` returns an `app.asar\…` path, `fs.existsSync()` lies (Electron patches only `fs`), and `spawn()` fails with `ENOENT` — every review silently breaks.
- The UI bundle goes to **`out/`**, not `dist/`, and is loaded with `base: './'` so it works over `file://`.
- **`build.files` is an allowlist.** A new main-process module is silently omitted unless it is added there, and the failure only shows up in a packaged build — `npm run dev` never notices. `npm run audit:packaging` walks the require graph and fails if anything is missing.

### What `build/installer.nsh` works around

electron-builder's assisted-installer template hides the install log and lets the progress bar snap backwards. Both are handled from the custom include, and both depend on *where* each macro gets expanded — so read the comments in that file before reordering anything. `makensis` runs with `-WX`, i.e. any warning fails the build. Everything below was verified by actually running the built installer and reading the frames pixel by pixel, not by reading the templates.

- **Blank details panel.** `templates/nsis/common.nsh` hard-codes `ShowInstDetails nevershow` and `installSection.nsh` runs `SetDetailsPrint none`. `customHeader` is expanded *after* `common.nsh`, so its `ShowInstDetails show` wins. The panel's content comes from the instfiles **SHOW** callback (`ocrInstFilesShow`), which MUI2 invokes *after* it has fetched the listbox handle — so `DetailPrint` there lands in a real control and the four lines stay visible for the whole install. That is the only hook that works: `SetDetailsPrint none` runs again when the section starts, and the `nsis7z` unpack blocks the script, so anything printed later either never lands or is on screen for a single frame. `customInstall` still prints the result lines for the log.
- **Progress bar jumping backwards.** NSIS counts only the bytes written by `File` instructions — here just the embedded `app-64.7z` (96,335,334 B ≈ 94,077 KB) — while the template sizes the section by the *unpacked* app (354,236 KB). Measured on the built installer: the bar climbs to **~37%** in about a second, then `nsis7z.dll` takes the bar over and restarts it from **0%**, which is what users reported.
  **`SectionSetSize` cannot fix this** — three configurations were tried and the bar's scale never moved: inflating ×10 from an aborted page between the directory and instfiles pages, inflating ×10 from `preInit` (inside `.onInit`, right after the template's own `setInstallSectionSpaceRequired`), and shrinking ÷4 after extraction. `SectionGetSize` returned the new values every time, so the writes landed; the progress scale simply does not read them. The pre-extract segment is also unavoidable in principle: while the archive is embedded with `File`, NSIS counts it, and the plugin that unpacks it always starts from zero.
  So the include stops trying to *calibrate* the bar and instead **switches it to marquee (indeterminate) mode as soon as the instfiles page is shown**, using the same control lookup MUI2 uses (`FindWindow "#32770"` under `$HWNDPARENT`, then `GetDlgItem … 1004`). The plugin's `PBM_SETPOS` calls are ignored in marquee mode, so no percentage is ever displayed and there is nothing left to jump backwards. If a system's comctl32 rejects the style bit, the bar simply behaves as it did before — no worse.
  Turning marquee *off* at the end of extraction was tried and dropped: clearing `PBS_MARQUEE` races the plugin's own `SendMessage` traffic and made the bar flicker between the two modes. The finish page follows immediately anyway, so how the bar ends is invisible.

### Cross-platform binaries

`@alibaba-group/open-code-review` ships its native binary through `optionalDependencies`, and npm installs **only the host platform's** copy. To package for another OS, run `npm run fetch:binaries` first — it downloads the missing binaries from the official GitHub release and verifies each `sha256`. All six then live under `node_modules/@alibaba-group/ocr-*`, and `build/after-pack.cjs` strips the ones a given build cannot run before the installer is produced (otherwise every package would carry ~270 MB of dead binaries).

## UI layout & design spec

The UI once drifted, one reasonable-looking change at a time, into three different content widths, five different card recipes, ad-hoc margins (`mb-4` next to `mt-4` next to `mb-2.5`) and ten font sizes between 10 and 14px. The fix was not a restyle — it was to give the decisions an owner. **`src/components/ui/layout.tsx` is that owner**; read its header comment before adding a screen.

- **One measure per page.** `Page` / `PageBody` centre `--page-max` (1080px). Full-bleed forms are the specific failure mode: at 1920px they stretch an input to ~900px and pull every label hundreds of pixels away from its control. Results is the one deliberate exception — a master-detail view legitimately uses the whole window.
- **The one full-width screen is container-responsive, not viewport-responsive.** Results is a `@container`, and its column count follows the width it actually has: three columns only above 1240px, where `minmax(620px, …)` can be honoured for the code pane. Below that the code stops being a column and becomes a second row of the detail column (the finding and the code then split the height 46/54 and scroll independently). Measured on the built UI, the three-pane grid was 337px of code at the 1000px window floor and 568px at 1440px while a line of the fixture needs 629px — so on a 1280px laptop most lines of the thing the user came to read were cut off, and *nothing overflowed*, which is exactly why the layout assertions in `audit:ui` check column count and code width rather than just "does anything clip".
- **Rhythm from the parent, not from margins.** `PageBody` is a `gap-6` stack, so `Section` and `Card` carry no vertical margins at all. Spacing uses Tailwind's 4px steps only: 4 icon↔text, 8 control↔control, 12 label↔control, 16 page gutter / card padding / field↔field, 24 section↔section.
- **Container-responsive forms.** `FieldGrid` is `repeat(auto-fit, minmax(var(--field-min), 1fr))` — two columns when the measure allows, one when it does not, without viewport breakpoints. Wide children use `col-span-full`, never `col-span-2`, which would create an implicit track and overflow once the grid collapses.
- **Four type steps, defined in `styles.css`.** `text-meta` 11px (hints, paths, timestamps, badges), `text-body` 12px (secondary prose, table cells), `text-strong` 13px (primary text, control values, section titles), `text-stat` 20px (figures). Arbitrary `text-[12.5px]` values are what produced the original ten-step ramp.
- **One card recipe.** `Card` with `tone` and an optional header row. Do not hand-roll `rounded-md border border-line bg-surface`.
- **Unbounded text needs a bound.** Anything fed by a branch name, model id, provider name or path can arrive as one long unbreakable token. A flex/grid child defaults to `min-width: auto`, which refuses to shrink below its min-content width, so such a value pushes its container wide and something upstream clips it — the top bar once stretched to 2673px inside a 1440px window. Give the shrinking child `min-w-0` and `truncate`, cap the box (`max-w-[…]`), and put the full value in a `title`. In a `table-layout:auto` table the cell needs the cap too, or the column sizes to content.
- **Two accent roles.** `--accent` is for text, borders and focus rings; `--accent-solid` is the fill behind light ink (primary buttons, checked controls). White on the bright accent is only 3.7:1 in dark mode, so a single token cannot serve both.
- **The toast is a first-class surface, not a notification.** It is the only place a failure is ever reported — CLI errors, rejected refs, `cannot open <path>` — and it had drifted in three ways at once: it was pinned to `theme="system"` while the app had its own preference (a light app on a dark desktop styled its errors dark), `body`'s `user-select: none` made the error text uncopyable, and the CLI's multi-line `caused by:` / `hint:` structure was collapsed into one run-on sentence. All three are asserted in `audit:ui` against a deliberately failing fixture (`?toast=1`) rather than left to inspection. The theme preference itself now lives in `src/lib/theme.ts` with a `useSyncExternalStore` subscription instead of inside `NavRail`, so the toast layer and the app cannot disagree.
- **The ink ramp is measured, not eyeballed.** `--ink` / `--muted` / `--faint` land at 16.9 / 6.8 / 4.7:1 on canvas in light and 15.9 / 7.8 / 5.6:1 in dark. Keep the three steps apart, and re-measure if you add a surface.

### Verifying changes

Everything is checked by rendering the real bundle against a stubbed IPC bridge in headless Edge — no Electron, no desktop — plus one check that drives the actual Electron process, because some behaviour only exists there.

```
npm run audit           # typecheck + all five checks below
npm run audit:packaging # every runtime module is in the build.files allowlist
npm run audit:service   # the real CLI: arg building and output parsing, all 4 modes
npm run audit:ui        # 31 states x 3 window sizes x 2 themes
npm run audit:contrast  # WCAG AA for every text/background pair
npm run audit:guards    # navigation + window-open policy, in real Electron
```

All of them exit non-zero on findings, so they work as a gate rather than a log, and each states what it inspected — a check that reports "0 problems" without saying what it looked at manufactures confidence rather than providing it, so they refuse to pass vacuously.

**`audit:service`** covers the layer that is the app's whole job: turning a spec into CLI arguments and turning the CLI's output back into something the UI can render. It runs the real binary against a throwaway git repo, using `--preview` so no API key or network is needed. It asserts all four modes parse into the expected shape and find files, that mode-specific flags do not leak into another mode (the CLI would reject the run), that a bad ref fails with an error rather than an empty preview the UI would render as "nothing to review", and that a non-repo directory is reported as such.

**`audit:ui`** asserts the declared measure cap, document overflow, and content that is clipped without an ellipsis. It prints `FAIL` with the offending element. It also asserts the results screen's *responsive contract* rather than only its absence of overflow: at 1440px there must be three panes and the code pane must clear the widest code line in the fixture; at 1000x660 there must be two panes with the code stacked and still at least one full line wide. A layout that silently clips the code satisfies "nothing overflows", so that is the check that matters. It renders three fixture sets, selected by query string:

| Query | What it exercises |
| --- | --- |
| *(none)* | Normal payloads — the everyday look of every screen |
| `?sessions=many` | 65 sessions, so the history panel's paging and count are real |
| `?stress=1` | 100+ char unbreakable tokens in every slot that holds arbitrary text |

The stress set is the one that earns its keep. Any slot fed by a branch name, model id, provider name or filesystem path can receive a string with no break opportunity, and a flex/grid child missing `min-w-0` will push its container wide instead of shrinking — after which something upstream clips it and the damage is invisible in normal use. It found the top bar stretching to 2673px inside a 1440px window, a select overflowing by 93px, and a settings table pushing 193px past its card.

**`audit:guards`** runs the app in real Electron and asserts that `window.open` is denied (and never reaches the OS shell for a non-http scheme), that navigation off the app's own document is blocked, and that the app's own bundle still loads and reloads. It also asserts that *our handler* is what blocked a navigation, rather than the CSP or Chromium's own rules — otherwise the suite could pass while the guard did nothing.

It needs the Electron binary, and on a machine with no GPU or a restrictive sandbox it retries once with `--no-sandbox`, saying so. Override with `PW_ELECTRON_ARGS`.

`audit:ui` and `audit:contrast` drive the system Edge/Chrome rather than a downloaded Chromium, so Playwright is deliberately **not** a project dependency — installing it would pull a browser toolchain the app never uses. Resolve it via `PLAYWRIGHT_MODULE=<path>`, a local `npm i -D playwright`, or `NODE_PATH`; the harness reports which paths it searched when it cannot find one.

Run these before and after any layout, token, or main-process change. Several real defects were only visible this way: a settings page that ran at two widths at once, a grid track that overflowed its container by 57px, a preview panel unreachable below 1536px, 234 text instances below AA contrast, and a navigation guard that blocked the app's own startup and would have shipped a blank window.

## Known limitations

- Git must be on `PATH`. Windows packages are built and verified on Windows x64; macOS dmg builds must run on macOS and Linux AppImage/deb builds on Linux (or WSL/Docker), because each target needs its own host tooling.
- **Auto-update applies to the NSIS setup build only.** The portable exe re-extracts to a temp dir each run and has no install root to replace, so it links to the releases page instead. macOS/Linux builds are unsigned against a generic update feed, so treat in-app updates as Windows-installed-build-only for now.
- Releases must ship `latest.yml` (plus `latest-mac.yml` / `latest-linux.yml` for those platforms) and the `*-setup.exe.blockmap` next to the binaries; without them the updater cannot see a version at all.
- Installers are **unsigned**, so SmartScreen (Windows) and Gatekeeper (macOS) will warn on first launch.
- The CLI exposes no model catalogue, so the model name is still typed by hand — a rejected name makes the vendor turn its accepted names into clickable buttons (see [alibaba/open-code-review#1694](https://github.com/alibaba/open-code-review/issues/1694)).
- The dev instance and the installed app share one user-data directory, so the **single-instance lock makes whichever starts second exit silently**.

## Not affiliated

Not an official Alibaba project, and not endorsed by it. `ocr` and its binary are covered by their own Apache-2.0 license; see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Build and usage details for contributors: [`使用说明.md`](使用说明.md) (中文).
