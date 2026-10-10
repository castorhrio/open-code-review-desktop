# Open Code Review Desktop

An **unofficial Windows desktop GUI** for [`alibaba/open-code-review`](https://github.com/alibaba/open-code-review) (`ocr`) — Alibaba's AI code review CLI, 45k+ stars.

The review engine is the official, **unmodified** `ocr` binary. This project only wraps it: it builds the command line, streams progress, parses the JSON output, and gives you a GUI for scoping, cost control, findings triage, and session history. No review logic is reimplemented here.

**中文文档见下方，安装与开发细节在 [`使用说明.md`](使用说明.md)。**

---

## Status

`v0.1.0` — usable, verified against `ocr v1.12.13`.

What has been verified end-to-end (against the real CLI, without spending tokens):

- all four review scopes, `--preview` for workspace / range / commit / scan
- the per-mode flag whitelist (`ocr scan` rejects `--effort`, `--no-filter` and `--background-file`; sending them would abort the whole run)
- failure output handling, session listing / loading / HTML export / deletion, `ocr rules check`, `ocr llm providers` parsing
- packaged app boots and reaches the bundled binary

What has **not** yet been exercised: a real LLM review run (it needs your API key and spends money). The results view was validated with payloads shaped exactly like the CLI's real output, but please run one small review before trusting the happy path in production.

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
| **Local config stays local** | everything is written through `ocr config set` into `~/.opencodereview/config.json`; the app keeps no separate copy of your key and talks only to the endpoint you configure |

## Install

**Option A — installer (recommended).** Download `ocr-desktop-<version>-setup.exe` from [Releases](../../releases) and run it. Per-user install, no administrator rights. Because it is unsigned, SmartScreen may warn — choose *More info → Run anyway*.

**Option B — portable.** Run `ocr-desktop-<version>-portable.exe` directly, no installation.

**Option C — from source.**

```bash
npm install      # downloads the native ocr binary (~55 MB)
npm run dev      # Vite HMR + Electron
npm start        # build the UI, then run it
npm run dist     # build the Windows installer into release/
```

## First run

1. Pick a repository in the top bar (must be a git repo root; Git ≥ 2.41 on `PATH`).
2. In **Settings**, choose a provider, enter the API key and model name, then **Save** and **Test connection**.
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

## Not affiliated

Not an official Alibaba project, and not endorsed by it. `ocr` and its binary are covered by their own Apache-2.0 license; see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

---

# 中文说明

这是 [`alibaba/open-code-review`](https://github.com/alibaba/open-code-review)（`ocr`）的非官方 Windows 桌面界面。审查引擎是**未修改的官方 CLI**，本项目只负责：拼装命令行、流式读取进度、解析 JSON、并把范围确认 / 成本控制 / 问题分级 / 历史续跑做成可见的操作。

## 版本状态

`v0.1.0`。已用真实 CLI 零成本验证：四种范围、预览、按模式的参数白名单（`ocr scan` 会拒绝 `--effort`、`--no-filter`、`--background-file`，误传会让整单失败）、失败输出处理、会话列表/载入/导出/删除、`rules check`、`llm providers` 解析、安装包启动并调用到内置二进制。

**尚未验证的**：真实调用 LLM 的审查（需要你的 Key 并产生费用）。结果页是按真实输出结构校验过的，但请先跑一次小范围审查再依赖它。

## 为什么需要图形界面

CLI 很强，但一切都发生在终端里：读几十条行级意见、区分"审完了"和"被预算截断了"、续跑一次中断的审查，都要靠人记住 flag 和 session id。这里把这些变成看得见、且不容易做错的操作。

## 主要能力

- **四种范围**：工作区改动 / 分支对比（merge-base）/ 单个提交 / 全量扫描
- **先预览再花钱**：列出将进入审查的文件，并说明每个被排除文件的原因（二进制、凭据路径、暂不支持类型等）
- **成本护栏**：`--max-tokens-budget` 与 `--timeout` 是一等输入项，不是隐藏参数
- **诚实的运行状态**：完成 / 部分完成 / 失败 / 有警告 徽章，并列出**没有审完**的文件与原因，被截断的运行绝不会显示成"干净通过"
- **续跑**：中断、取消或部分失败的运行可基于官方会话续跑，已审过的文件不重复计费
- **会话历史**：查看、载入、续跑、导出离线 HTML 报告、删除
- **代码定位准确**：审查目标是某个 ref 时，代码面板用 `git show` 读取该 ref 下的内容，而不是你的工作副本
- **筛选与操作**：严重级/类别/关键词筛选，`↑` `↓` 或 `j` `k` 切换，复制建议代码，导出 JSON
- **首次引导**：三步引导、输入分支时实时校验、把 CLI 英文报错翻译成可行动的中文提示
- **Key 不出本机**：配置只通过 `ocr config set` 写入官方 `~/.opencodereview/config.json`，本程序不另存副本，也只连接你配置的端点

## 已知限制

- 仅 Windows x64 构建并验证过；需要 PATH 上有 Git。
- 安装包**未做代码签名**，首次运行会有 SmartScreen 提示。
- `ocr` 未提供模型目录接口，模型名仍需手填。
- 开发实例与安装版共用同一份用户数据，**单实例锁会让后启动的窗口静默退出**。
- 界面截图稍后补充到 `docs/`。

安装、开发与打包细节见 [`使用说明.md`](使用说明.md)。
