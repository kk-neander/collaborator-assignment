import { join } from "node:path";
import ts from "typescript";
import { REPO_ROOT } from "./scenario.ts";

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2023,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  strict: true,
  noEmit: true,
  allowImportingTsExtensions: true,
  skipLibCheck: true,
  types: ["node"],
  typeRoots: [join(REPO_ROOT, "node_modules/@types")],
};

export function typeErrors(files: Map<string, string>): string[] {
  const root = "/workspace";
  const byPath = new Map<string, string>();
  const sources: string[] = [];
  for (const [path, text] of files) {
    if (path.endsWith(".ts") && !path.endsWith(".test.ts")) sources.push(`${root}/${path}`);
    if (path.endsWith(".ts") || path === "package.json") byPath.set(`${root}/${path}`, text);
  }
  const dirs = new Set<string>();
  for (const f of byPath.keys()) for (let d = f.slice(0, f.lastIndexOf("/")); d; d = d.slice(0, d.lastIndexOf("/"))) dirs.add(d);
  const host = ts.createCompilerHost(OPTIONS);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (f) => byPath.get(f) ?? readFile(f);
  host.fileExists = (f) => byPath.has(f) || fileExists(f);
  host.getSourceFile = (f, lang, onError, create) => {
    const text = byPath.get(f);
    return text !== undefined ? ts.createSourceFile(f, text, lang) : getSourceFile(f, lang, onError, create);
  };
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (d) => dirs.has(d) || (directoryExists ? directoryExists(d) : false);
  const realpath = host.realpath?.bind(host);
  host.realpath = (p) => (p.startsWith(root) ? p : realpath ? realpath(p) : p);
  host.getCurrentDirectory = () => root;
  const program = ts.createProgram(sources, OPTIONS, host);
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && byPath.has(d.file.fileName))
    .map((d) => {
      const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
      return `${d.file!.fileName.slice(root.length + 1)}:${line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
    });
}
