import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--ed-text)",
    backgroundColor: "var(--ed-bg)",
    fontSize: "13.5px",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.65",
  },
  ".cm-content": { padding: "18px 0 40vh", caretColor: "var(--ed-caret)" },
  ".cm-line": { padding: "0 18px 0 10px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ed-caret)", borderLeftWidth: "2px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--ed-selection) !important",
  },
  ".cm-activeLine": { backgroundColor: "var(--ed-active-line)" },
  ".cm-gutters": {
    backgroundColor: "var(--ed-bg)",
    color: "var(--ed-gutter)",
    border: "none",
    paddingLeft: "6px",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ed-gutter-active)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 10px", minWidth: "34px" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--ed-gutter)", padding: "0 4px" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--ed-bracket)",
    outline: "1px solid var(--ed-bracket-border)",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--ed-match)" },
  ".cm-searchMatch": { backgroundColor: "var(--ed-search)", outline: "1px solid var(--ed-search-border)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--ed-search-selected)" },
  ".cm-panels": { backgroundColor: "var(--panel-2)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel input, .cm-panel button": { fontFamily: "inherit" },
  ".cm-tooltip": { backgroundColor: "var(--elev)", border: "1px solid var(--border-strong)", color: "var(--text)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--panel-2)", border: "1px solid var(--border)", color: "var(--text-dim)" },
  ".cm-specialChar": { color: "var(--syn-invalid)" },
});

const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword], color: "var(--syn-keyword)" },
  { tag: [t.operatorKeyword, t.operator, t.derefOperator], color: "var(--syn-op)" },
  { tag: [t.string, t.special(t.string), t.inserted], color: "var(--syn-string)" },
  { tag: [t.regexp, t.escape], color: "var(--syn-regexp)" },
  { tag: [t.number, t.integer, t.float], color: "var(--syn-number)" },
  { tag: [t.bool, t.null, t.atom, t.self, t.special(t.variableName)], color: "var(--syn-atom)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName))], color: "var(--syn-fn)" },
  { tag: [t.typeName, t.className, t.namespace, t.annotation, t.modifier], color: "var(--syn-type)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-prop)" },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName)], color: "var(--syn-def)" },
  { tag: [t.variableName, t.name, t.labelName], color: "var(--syn-name)" },
  { tag: [t.constant(t.name), t.standard(t.name)], color: "var(--syn-number)" },
  { tag: [t.punctuation, t.separator, t.bracket], color: "var(--syn-punct)" },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3], color: "var(--syn-heading)", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "var(--syn-link)", textDecoration: "underline" },
  { tag: [t.monospace], color: "var(--syn-string)" },
  { tag: [t.quote], color: "var(--syn-comment)" },
  { tag: [t.processingInstruction, t.contentSeparator], color: "var(--syn-punct)" },
  { tag: t.invalid, color: "var(--syn-invalid)" },
]);

export const editorHighlighting = syntaxHighlighting(highlightStyle);
