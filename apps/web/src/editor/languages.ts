import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import type { Extension } from "@codemirror/state";

export function languageFor(path: string): Extension {
  const name = path.toLowerCase();
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return javascript({ typescript: true });
    case ".tsx":
      return javascript({ typescript: true, jsx: true });
    case ".js":
    case ".mjs":
    case ".cjs":
      return javascript();
    case ".jsx":
      return javascript({ jsx: true });
    case ".json":
      return json();
    case ".md":
    case ".markdown":
      return markdown();
    default:
      return [];
  }
}

export function languageLabel(path: string): string {
  const name = path.toLowerCase();
  if (/\.(ts|mts|cts)$/.test(name)) return "TypeScript";
  if (name.endsWith(".tsx")) return "TSX";
  if (/\.(js|mjs|cjs)$/.test(name)) return "JavaScript";
  if (name.endsWith(".jsx")) return "JSX";
  if (name.endsWith(".json")) return "JSON";
  if (/\.(md|markdown)$/.test(name)) return "Markdown";
  return "Plain text";
}
