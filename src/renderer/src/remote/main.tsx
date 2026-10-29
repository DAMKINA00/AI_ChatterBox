import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RemoteApp } from "./RemoteApp";
import "../index.css";

document.documentElement.classList.toggle("dark", !window.matchMedia("(prefers-color-scheme: light)").matches);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RemoteApp />
  </StrictMode>,
);
