import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RemoteApp } from "./RemoteApp";
import { applyTheme } from "./theme";
import "../index.css";

// Before the first render so the page never flashes the wrong theme.
applyTheme();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RemoteApp />
  </StrictMode>,
);
