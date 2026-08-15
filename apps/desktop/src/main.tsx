import "./http-bridge";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { TranslateWindow } from "./TranslateWindow";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TranslateWindow />
  </StrictMode>,
);
