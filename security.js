// SPDX-License-Identifier: Apache-2.0
"use strict";

/**
 * Navigation and window-creation policy for the renderer.
 *
 * The renderer only ever loads the local bundle, and the text it displays is
 * written by an LLM that has been reading the user's repository — i.e. it is
 * influenced by content nobody vetted. Nothing in the app opens a window or
 * navigates away today, but the *default* behaviour is the problem: a
 * `window.open` or a link click creates a new BrowserWindow that inherits this
 * window's webPreferences, preload included. That window would receive the
 * entire `window.api` surface — start a review, rewrite the config, delete
 * sessions, open files.
 *
 * So both paths are denied, and a genuine http(s) link is handed to the real
 * browser instead, with the same scheme check the in-app link uses.
 *
 * Kept separate from main.js so the policy can be exercised on its own: see
 * tools/electron-guards.cjs.
 */

/** Only http(s) leaves the app; file://, javascript: and custom handlers do not. */
function isExternalHttp(url) {
  return /^https?:\/\//i.test(String(url || ""));
}

/**
 * True when a navigation should be permitted.
 *
 * The policy is positive rather than relative: only the app's own document may
 * load. Comparing against the *current* URL instead looked equivalent but was
 * not — during the initial load `getURL()` still reports `about:blank`, so the
 * first navigation was refused and the app opened a blank window. Allowing
 * "whatever we already have" also cannot tell a reload from a same-URL reload
 * of something an attacker swapped in.
 *
 * The fragment is ignored so in-page anchors are not treated as navigations.
 */
function isAllowedNavigation(next, appUrl) {
  if (!appUrl) return false;
  return String(next).split("#")[0] === String(appUrl).split("#")[0];
}

/**
 * @param {object} deps
 * @param {import("electron").App} deps.app
 * @param {import("electron").Shell} deps.shell
 * @param {string} deps.appUrl  The one document the renderer is allowed to be
 *   on — the dev server URL in development, the bundled index.html in
 *   production.
 */
function installNavigationGuards({ app, shell, appUrl }) {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isExternalHttp(url)) shell.openExternal(url);
      return { action: "deny" };
    });

    contents.on("will-navigate", (event, url) => {
      if (isAllowedNavigation(url, appUrl)) return;
      event.preventDefault();
    });

    // Nothing uses <webview>, and an enabled webview is a second, weaker
    // renderer inside the app.
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
}

module.exports = { installNavigationGuards, isExternalHttp, isAllowedNavigation };
