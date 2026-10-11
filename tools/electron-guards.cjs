// SPDX-License-Identifier: Apache-2.0
"use strict";

/**
 * Exercises security.js inside a real Electron process.
 *
 * Run through tools/electron-guards.mjs (`npm run audit:guards`), which spawns
 * Electron with this file and reads the JSON report it writes. Driving Electron
 * from Node directly rather than through a browser-automation layer keeps the
 * test honest: what is asserted here is the behaviour of the actual handler
 * registration, in the actual runtime.
 *
 * argv[2] = path to write the JSON report to.
 */
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { app, BrowserWindow, shell } = require("electron");
const { installNavigationGuards, isExternalHttp, isAllowedNavigation } = require("../security");

const reportPath = process.argv[2];
const BUNDLE = pathToFileURL(path.join(__dirname, "..", "out", "index.html")).href;
const results = [];
const navLog = [];
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail: detail || "" });

let finished = false;

const externalOpened = [];
shell.openExternal = async (url) => {
  externalOpened.push(url);
  return undefined;
};

installNavigationGuards({ app, shell, appUrl: BUNDLE });

function finish() {
  // Must be idempotent and unconditional: an earlier version only reported when
  // no check had run yet, so an error part-way through left the process alive
  // with no report and the runner hanging until it was killed.
  if (finished) return;
  finished = true;
  const failed = results.filter((r) => !r.ok);
  try {
    fs.writeFileSync(reportPath, JSON.stringify({ results, externalOpened, navLog, appUrl: BUNDLE }, null, 2), "utf8");
  } catch (err) {
    process.stderr.write("could not write report: " + err.message + "\n");
  }
  app.exit(failed.length ? 1 : 0);
}

async function run() {
  // Pure predicates first — cheap, and they are the parts most likely to be
  // subtly wrong (a regex that lets `file://` through, say).
  check("http is external", isExternalHttp("http://example.com"));
  check("https is external", isExternalHttp("https://example.com/x?y=1"));
  check("file:// is not external", !isExternalHttp("file:///C:/Windows/hosts"));
  check("javascript: is not external", !isExternalHttp("javascript:alert(1)"));
  check("custom scheme is not external", !isExternalHttp("ms-msdt:/id"));
  check("empty is not external", !isExternalHttp(""));
  // The initial load must pass, or the app opens a blank window. This is the
  // exact bug this test was written after finding: during the first navigation
  // getURL() is still "about:blank", so comparing against the current URL
  // refused the app's own bundle.
  check("the app's own bundle is allowed", isAllowedNavigation(BUNDLE, BUNDLE));
  check("bundle with a fragment is allowed", isAllowedNavigation(BUNDLE + "#/results", BUNDLE));
  check("a different url is blocked", !isAllowedNavigation("https://example.com/", BUNDLE));
  check("another file:// is blocked", !isAllowedNavigation("file:///C:/Windows/hosts", BUNDLE));
  check("a file next to the bundle is blocked", !isAllowedNavigation(BUNDLE + ".bak", BUNDLE));
  check("no app url blocks everything", !isAllowedNavigation(BUNDLE, ""));

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const navLog = [];
  win.webContents.on("will-navigate", (event, url) => {
    navLog.push({ url, prevented: event.defaultPrevented });
  });
  check("app url for comparison", Boolean(BUNDLE), BUNDLE);
  // A rejected load must be reported, not left as an unhandled rejection that
  // takes the whole process down before the report is written.
  let loaded = true;
  await win.loadFile(path.join(__dirname, "..", "out", "index.html")).catch((err) => {
    loaded = false;
    check("bundle loads", false, err.message);
  });
  if (loaded) check("bundle loads", true);
  const wc = win.webContents;
  const before = wc.getURL();
  check("bundle loaded", before.startsWith("file://"), before);

  // window.open must be denied and must not create a window.
  const windowsBefore = BrowserWindow.getAllWindows().length;
  const opened = await wc.executeJavaScript('(() => window.open("https://example.com/", "_blank") === null)()');
  check("window.open returns null (denied)", opened);
  check(
    "no window was created",
    BrowserWindow.getAllWindows().length === windowsBefore,
    `${BrowserWindow.getAllWindows().length} windows`
  );

  // A denied window whose URL is http(s) should have been handed to the browser
  // instead of being silently dropped.
  check("http window.open offered to the OS browser", externalOpened.some((u) => u.startsWith("https://")), externalOpened.join(","));

  // A non-http window.open must NOT reach the OS shell.
  externalOpened.length = 0;
  await wc.executeJavaScript('(() => { try { window.open("file:///C:/Windows/System32/drivers/etc/hosts"); } catch (e) {} return true; })()');
  await new Promise((r) => setTimeout(r, 300));
  check("file:// window.open not passed to the OS shell", externalOpened.length === 0, externalOpened.join(","));

  // Navigating away must be blocked.
  await wc.executeJavaScript('(() => { window.location.href = "https://example.com/"; return true; })()');
  await new Promise((r) => setTimeout(r, 1200));
  check("navigation to https is blocked", wc.getURL() === before, wc.getURL());

  await wc.executeJavaScript('(() => { window.location.href = "file:///C:/Windows/System32/drivers/etc/hosts"; return true; })()');
  await new Promise((r) => setTimeout(r, 1200));
  check("navigation to file:// is blocked", wc.getURL() === before, wc.getURL());

  // The two cases above can also be refused by the CSP or by Chromium's own
  // cross-origin rules, which would let this suite pass while the guard did
  // nothing. So navigate to a second local file that exists and shares the
  // origin: nothing but our handler can stop that, and the will-navigate log
  // proves the handler is what stopped it.
  const probe = path.join(__dirname, "..", "out", "_nav-probe.html");
  fs.writeFileSync(probe, "<!doctype html><meta charset=utf-8><title>probe</title>ok", "utf8");
  const probeUrl = pathToFileURL(probe).href;
  navLog.length = 0;
  await wc.executeJavaScript(`(() => { window.location.href = ${JSON.stringify(probeUrl)}; return true; })()`);
  await new Promise((r) => setTimeout(r, 1200));
  check("sibling local file navigation is blocked", wc.getURL() === before, wc.getURL());
  check(
    "our handler is what blocked it",
    navLog.some((n) => n.url === probeUrl && n.prevented),
    JSON.stringify(navLog)
  );
  fs.unlinkSync(probe);

  // Reloading its own document must still work, or the guard is too broad.
  await wc.reload();
  await new Promise((r) => setTimeout(r, 1500));
  check("own document still reloads", wc.getURL().startsWith("file://"), wc.getURL());
}

app.whenReady()
  .then(run)
  .catch((err) => check("harness ran to completion", false, String(err && err.message ? err.message : err)))
  .finally(finish);

// Absolute backstop, independent of how far run() got.
setTimeout(() => {
  check("harness finished within 40s", false, "timed out");
  finish();
}, 40000);
