export type ThemePref = "system" | "light" | "dark";

const KEY = "ocr-theme-pref";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function readPref(): ThemePref {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function applyPref(pref: ThemePref): "light" | "dark" {
  const resolved = pref === "system" ? (media.matches ? "dark" : "light") : pref;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  return resolved;
}

export function watchSystem(cb: () => void) {
  const handler = () => cb();
  media.addEventListener("change", handler);
  return () => media.removeEventListener("change", handler);
}

export function savePref(pref: ThemePref) {
  localStorage.setItem(KEY, pref);
}
