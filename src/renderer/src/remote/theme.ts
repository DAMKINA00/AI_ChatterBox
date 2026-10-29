// D6: the page's own light/dark theme, stored per browser (never synced with the desktop app).
import { useEffect, useState } from "react";
import { REMOTE_THEME_STORAGE_KEY } from "../../../shared/remote-web";
import { isDark, readTheme, type ThemeChoice } from "./logic";

const media = () => window.matchMedia("(prefers-color-scheme: dark)");
const stored = (): ThemeChoice => { try { return readTheme(localStorage.getItem(REMOTE_THEME_STORAGE_KEY)); } catch { return "system"; } };

export function applyTheme(choice: ThemeChoice = stored()) {
  const dark = isDark(choice, media().matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState(stored);
  useEffect(() => {
    applyTheme(choice);
    if (choice !== "system") return;
    const m = media();
    const follow = () => applyTheme("system");
    m.addEventListener("change", follow);
    return () => m.removeEventListener("change", follow);
  }, [choice]);
  const set = (next: ThemeChoice) => {
    try { if (next === "system") localStorage.removeItem(REMOTE_THEME_STORAGE_KEY); else localStorage.setItem(REMOTE_THEME_STORAGE_KEY, next); } catch { /* private mode */ }
    setChoice(next);
  };
  return [choice, set];
}
