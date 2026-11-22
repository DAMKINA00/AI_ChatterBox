// Remote web page entry. The page is the desktop app's own renderer (DesktopShell) running on the remote
// API adapter; `?classic` keeps the earlier simplified remote page available.
import "./install-api";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { REMOTE_THEME_STORAGE_KEY } from "../../../shared/remote-web";
import "../index.css";

const root = createRoot(document.getElementById("root")!);
const render = (node: ReactNode) => root.render(<StrictMode>{node}</StrictMode>);

if (new URLSearchParams(location.search).has("classic")) {
  void Promise.all([import("./theme"), import("./RemoteApp")]).then(([{ applyTheme }, { RemoteApp }]) => {
    // Before the first render so the page never flashes the wrong theme.
    applyTheme();
    render(<RemoteApp />);
  });
} else {
  // The app's theme (dark unless this browser chose light) before the first paint.
  let light = false;
  try { light = localStorage.getItem(REMOTE_THEME_STORAGE_KEY) === "light"; } catch { /* private mode */ }
  document.documentElement.classList.toggle("dark", !light);
  document.documentElement.style.colorScheme = light ? "light" : "dark";
  void import("./DesktopShell").then(({ DesktopShell }) => render(<DesktopShell />));
}
