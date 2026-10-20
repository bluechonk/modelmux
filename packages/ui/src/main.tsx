/**
 * 控制台入口：引入全局样式并把根组件挂到 `#root`。
 */

import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) throw new Error("Root element not found");
createRoot(container).render(<App />);
