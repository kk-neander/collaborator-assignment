import { useEffect, useState } from "react";

export type Theme = "dark" | "light";

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function savedTheme(): Theme | null {
  try {
    const v = localStorage.getItem("sb:theme");
    return v === "dark" || v === "light" ? v : null;
  } catch {
    return null;
  }
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => savedTheme() ?? systemTheme());
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!mq) return;
    const onChange = () => {
      if (!savedTheme()) setTheme(systemTheme());
    };
    mq.addEventListener("change", onChange);
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sb:theme") setTheme(savedTheme() ?? systemTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      mq.removeEventListener("change", onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem("sb:theme", next);
    } catch {
    }
    setTheme(next);
  };
  return [theme, toggle];
}
