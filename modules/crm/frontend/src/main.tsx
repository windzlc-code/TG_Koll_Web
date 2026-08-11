import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = document.getElementById("crm-root");
if (!root) throw new Error("CRM root element is missing");

createRoot(root).render(<StrictMode><App /></StrictMode>);
