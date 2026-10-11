import { useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const KEY = "ocr-theme-pref";
const media = window.matchMedia("(prefers-color-scheme: dark)");

/**
 * The theme lives here rather than in a component because more than one place
 * needs it, and a preference that only one of them can see is how the toast
 * layer ended up pinned to `theme="system"` while the user had explicitly
 * chosen light on a dark desktop — the app's error surface disagreeing with
 * the rest of the app about what theme it was in.
 *
 * Module scope, not an effect: applying the stored preference before the first
 * paint is what stops the window flashing the wrong theme on launch.
 */
let pref: ThemePref = readPref();
let resolved: ResolvedTheme = applyPref(pref);

const subscribers = new Set<() => void>();
const emit = () => subscribers.forEach((fn) => fn());

function subscribe(fn: () => void) {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export const getThemePref = () => pref;
export const getResolvedTheme = () => resolved;

export function setThemePref(next: ThemePref) {
  pref = next;
  localStorage.setItem(KEY, next);
  resolved = applyPref(next);
  emit();
}

// Follow the OS only while the preference is "system"; an explicit choice wins.
// This used to be a per-component listener, which meant a background window with
// no nav rail mounted stopped tracking the system.
media.addEventListener("change", () => {
  if (pref !== "system") return;
  resolved = applyPref(pref);
  emit();
});

export const useThemePref = () => useSyncExternalStore(subscribe, getThemePref);
export const useResolvedTheme = () => useSyncExternalStore(subscribe, getResolvedTheme);

export function readPref(): ThemePref {
  const stored = localStorage.getItem(KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function applyPref(next: ThemePref): ResolvedTheme {
  const value = next === "system" ? (media.matches ? "dark" : "light") : next;
  document.documentElement.dataset.theme = value;
  document.documentElement.classList.toggle("dark", value === "dark");
  return value;
}
