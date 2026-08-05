import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ActionBar } from "./ActionBar";

// No http-bridge here: the bar never talks to a translation provider, and
// keeping the plugin out of this bundle keeps the window cheap to show.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ActionBar />
  </StrictMode>,
);
