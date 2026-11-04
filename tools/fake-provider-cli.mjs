// Run the pinned `ocr` CLI against the fake provider, in a throwaway repo.
//
// `tools/fake-provider.mjs` answers requests; this file makes the requests
// happen. It is the seam between "the protocol double speaks the right shapes"
// (pure, `tools/fake-provider-smoke.mjs` part one) and "a real run of the real
// binary finishes and publishes a finding" (part two) — and, since round 133,
// the same fixture is what an Electron harness boots the GUI over
// (`tools/e2e-fake-provider.cjs`), which is why the repo and the HOME can also be
// *handed in* instead of created: an Electron process has to point HOME at a
// throwaway directory **before** it loads `ocr-service.js`, so the profile those
// two share is the harness's to create.
//
// Everything it touches is temporary and off to the side:
//
//   * a `mkdtemp` repository with `main` (a.go) and `feature` (b.go) plus an
//     uncommitted line, so all four GUI scopes have something to name;
//   * a `mkdtemp` HOME, because the CLI keeps its config in
//     `~/.opencodereview/config.json` — pointing HOME at a throwaway directory is
//     what keeps a real developer's saved provider and Key out of the test, and
//     what makes `ocr config set` below safe to run;
//   * the provider bound to loopback, so nothing leaves the machine and no token
//     is spent.
//
// The provider entry is written with the CLI's own `config set` rather than by
// writing `config.json` by hand: the file's shape is upstream's, and a fixture
// that guessed it would keep passing after upstream changed it.
"use strict";

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startFakeProvider } from "./fake-provider.mjs";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const CLI = path.join(ROOT, "node_modules", "@alibaba-group", "open-code-review", "bin", "ocr.js");

/** The provider name this fixture writes into the config. Not a built-in name,
 * so `config set provider` routes it into `custom_providers` — which is the
 * branch under test in `audit:config`, not a shortcut around it. */
export const PROVIDER_NAME = "fake-provider";

const git = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd }, (err, stdout, stderr) =>
      err ? reject(new Error(`git ${args.join(" ")}: ${stderr || stdout}`)) : resolve(String(stdout).trim())
    );
  });

/**
 * The repository every scope of the fixture can name.
 *
 * `main` holds `a.go`, `feature` adds `b.go`, and the checkout is left on
 * `feature` with one uncommitted line in `a.go` — so `workspace` has exactly one
 * reviewable change, `range main…feature` has exactly one, and neither is empty
 * by accident. No remote: the workspace scope does not need one, and a fixture
 * with a fake remote would be asserting something about clones.
 */
export async function seedRepo(dir) {
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "fake@example.com"]);
  await git(dir, ["config", "user.name", "Fake Provider"]);
  await git(dir, ["checkout", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(dir, "a.go"), "package main\n\nfunc main() {}\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "initial"]);
  await git(dir, ["checkout", "-q", "-b", "feature"]);
  fs.writeFileSync(path.join(dir, "b.go"), "package main\n\nfunc helper() int { return 1 }\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", "add helper"]);
  // An uncommitted line, so the `workspace` scope has a change to report too.
  fs.appendFileSync(path.join(dir, "a.go"), "\n// trailing\n");
  return dir;
}

/**
 * Boot the fixture: provider + repository + configured HOME.
 *
 * `providerOptions` is passed straight to `startFakeProvider` (`usage`,
 * `findingsPerFile`, `refuse`), which is how the three endings are produced.
 *
 * `dir` / `home` hand in directories the caller already owns — the Electron
 * harness needs its own HOME (see the header) and reuses one repository for a
 * second run against a differently-configured provider. A handed-in directory is
 * never deleted here: it is not this fixture's to remove, and in the harness's
 * case the app may still be writing into it.
 */
export async function startFixture({ providerOptions = {}, timeoutMs = 180000, dir: givenDir, home: givenHome } = {}) {
  if (!fs.existsSync(CLI)) {
    throw new Error(
      `没有找到 ocr 启动器：${path.relative(ROOT, CLI)}。源码运行时先执行 npm install（audit:provider 不该在没有 CLI 的树上静默变绿）。`
    );
  }

  const ownsDir = !givenDir;
  const ownsHome = !givenHome;
  const dir = givenDir || fs.mkdtempSync(path.join(os.tmpdir(), "ocr-fake-repo-"));
  const home = givenHome || fs.mkdtempSync(path.join(os.tmpdir(), "ocr-fake-home-"));
  const provider = await startFakeProvider(providerOptions);

  // `process.execPath` is whatever is running this file. Under plain Node that is
  // `node`; under `tools/e2e-fake-provider.cjs` it is the Electron binary, which
  // without this would try to open a window on the CLI's script and abort in the
  // SUID sandbox ("the SUID sandbox helper binary ... is not configured
  // correctly"). `ELECTRON_RUN_AS_NODE` is the switch that makes that same binary
  // behave as plain Node, so the CLI below runs the same way in both harnesses.
  const env = { ...process.env, HOME: home, USERPROFILE: home, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) };

  const run = (args, options = {}) =>
    new Promise((resolve) => {
      const started = Date.now();
      execFile(
        process.execPath,
        [CLI, ...args],
        { cwd: dir, env, timeout: options.timeoutMs || timeoutMs, maxBuffer: 32 * 1024 * 1024 },
        (err, stdout, stderr) =>
          resolve({
            code: err ? (err.code ?? 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
            ms: Date.now() - started,
            args,
          })
      );
    });

  const close = async () => {
    await provider.close();
    for (const target of [ownsDir ? dir : null, ownsHome ? home : null].filter(Boolean)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  };

  try {
    if (ownsDir) await seedRepo(dir);

    for (const [key, value] of [
      ["provider", PROVIDER_NAME],
      ["model", "fake-model"],
      [`custom_providers.${PROVIDER_NAME}.url`, provider.url],
      [`custom_providers.${PROVIDER_NAME}.protocol`, "openai"],
      [`custom_providers.${PROVIDER_NAME}.api_key`, "sk-fake-provider"],
      [`custom_providers.${PROVIDER_NAME}.model`, "fake-model"],
    ]) {
      const result = await run(["config", "set", key, value]);
      if (result.code !== 0) {
        throw new Error(`ocr config set ${key} 失败（${result.code}）：${(result.stderr || result.stdout).slice(0, 400)}`);
      }
    }
  } catch (err) {
    await close();
    throw err;
  }

  return {
    dir,
    home,
    provider,
    env,
    /** Run the CLI as the harness would; never throws on a non-zero exit. */
    run,
    /** Run the CLI with `--format json` and parse the report it printed.
     * A run that printed no JSON is reported as `{ json: null }` rather than
     * throwing, so the caller can say which run and which exit code. */
    async runJson(args, options = {}) {
      const result = await run(args, options);
      let json = null;
      try {
        json = JSON.parse(result.stdout);
      } catch {
        json = null;
      }
      return { ...result, json };
    },
    /** The review shape every scope uses: `--audience agent` keeps the run's
     * progress off the report, so stdout stays parseable. */
    review: (extra = []) => ["review", "--from", "main", "--to", "feature", "--audience", "agent", "--format", "json", ...extra],
    close,
  };
}
