import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Demo } from "./demo/Demo.tsx";
import { takeTokenFromUrl } from "./env.ts";
import { Ide } from "./ide/Ide.tsx";
import { Landing } from "./landing/Landing.tsx";
import { ToastProvider } from "./ui/toasts.tsx";
import "./styles.css";

function App() {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/demo") return <Demo />;
  const token = takeTokenFromUrl();
  return token ? <Ide token={token} /> : <Landing />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
