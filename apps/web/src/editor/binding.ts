import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Annotation, Compartment, EditorSelection, EditorState, Prec, type Extension, type TransactionSpec } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import type { User } from "@split-brain/protocol";
import { isNoop, type ChangeOrigin, type ClientCore, type TextOp } from "@split-brain/sync";
import { changeSetToTextOp, diffToTextOp, editEndPosition, LINE_SEPARATOR, textOpToChangeSet } from "../cm-ops.ts";
import { blameField, setBlame, type BlameRange } from "./blame.ts";
import { languageFor, languageLabel } from "./languages.ts";
import { remoteCursorsField, setRemoteCursors } from "./remote-cursors.ts";
import { editorHighlighting, editorTheme } from "./theme.ts";

export const syncOrigin = Annotation.define<ChangeOrigin>();

export type BindingIssueKind = "mismatch" | "apply_failed" | "remote_failed";

export interface DocBindingOptions {
  client: ClientCore;
  docId: string;
  path: string;
  parent: HTMLElement;
  colorOf(user: User): string;
  onIssue(kind: BindingIssueKind, message: string): void;
  onReady?(): void;
  assertSync: boolean;
  lineWrapping?: boolean;
}

const CURSOR_THROTTLE_MS = 100;

export class DocBinding {
  readonly view: EditorView;
  readonly docId: string;
  private readonly client: ClientCore;
  private readonly opts: DocBindingOptions;
  private readonly language = new Compartment();
  private readonly editable = new Compartment();
  private path: string;
  private ready: boolean;
  private locked = false;
  private applyingLocal = false;
  private destroyed = false;
  private readonly unsubscribe: Array<() => void> = [];
  private cursorTimer: ReturnType<typeof setTimeout> | undefined;
  private cursorDirty = false;

  constructor(opts: DocBindingOptions) {
    this.opts = opts;
    this.client = opts.client;
    this.docId = opts.docId;
    this.path = opts.path;
    this.client.open(this.docId);
    this.ready = this.client.isReady(this.docId);
    this.view = new EditorView({
      parent: opts.parent,
      state: EditorState.create({
        doc: this.ready ? this.client.text(this.docId) : "",
        extensions: this.extensions(),
      }),
    });
    this.unsubscribe.push(
      this.client.on("change", (docId, op, origin) => this.onClientChange(docId, op, origin)),
      this.client.on("presence", (docId) => {
        if (docId === this.docId) this.refreshCursors();
      }),
      this.client.on("status", (status) => {
        this.refreshCursors();
        if (status === "online") this.sendCursorSoon();
      }),
    );
    this.refreshCursors();
    if (this.ready) this.verify("open");
  }

  isReady(): boolean {
    return this.ready;
  }

  editorText(): string {
    return this.view.state.sliceDoc();
  }

  setPath(path: string): void {
    if (path === this.path) return;
    const changedLanguage = languageLabel(path) !== languageLabel(this.path);
    this.path = path;
    if (changedLanguage) this.view.dispatch({ effects: this.language.reconfigure(languageFor(path)) });
    this.view.contentDOM.setAttribute("aria-label", `Editor: ${path}`);
  }

  setLocked(locked: boolean): void {
    if (locked === this.locked) return;
    this.locked = locked;
    this.view.dispatch({ effects: this.editable.reconfigure(this.editableExtension()) });
  }

  focus(): void {
    this.view.focus();
  }

  setBlame(ranges: BlameRange[] | null): void {
    if (!this.destroyed) this.view.dispatch({ effects: setBlame.of(ranges) });
  }

  cursorPosition(): { line: number; col: number } {
    const head = this.view.state.selection.main.head;
    const line = this.view.state.doc.lineAt(head);
    return { line: line.number, col: head - line.from + 1 };
  }

  undo(): boolean {
    if (!this.canEdit()) return true;
    try {
      this.client.undo(this.docId);
    } catch (err) {
      this.report("apply_failed", `Undo failed: ${errorText(err)}`);
    }
    return true;
  }

  redo(): boolean {
    if (!this.canEdit()) return true;
    try {
      this.client.redo(this.docId);
    } catch (err) {
      this.report("apply_failed", `Redo failed: ${errorText(err)}`);
    }
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.unsubscribe) off();
    if (this.cursorTimer !== undefined) clearTimeout(this.cursorTimer);
    this.view.destroy();
  }

  private canEdit(): boolean {
    return this.ready && !this.locked && !this.destroyed;
  }

  private editableExtension(): Extension {
    const on = this.ready && !this.locked;
    return [EditorView.editable.of(on), EditorState.readOnly.of(!on)];
  }

  private extensions(): Extension[] {
    return [
      EditorState.lineSeparator.of(LINE_SEPARATOR),
      lineNumbers(),
      foldGutter({ openText: "▾", closedText: "▸" }),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      editorHighlighting,
      editorTheme,
      this.opts.lineWrapping ? EditorView.lineWrapping : [],
      this.language.of(languageFor(this.path)),
      this.editable.of(this.editableExtension()),
      EditorView.contentAttributes.of({ "aria-label": `Editor: ${this.path}`, "data-doc-id": this.docId }),
      remoteCursorsField,
      blameField,
      Prec.highest(
        keymap.of([
          { key: "Mod-z", run: () => this.undo(), preventDefault: true },
          { key: "Mod-Shift-z", run: () => this.redo(), preventDefault: true },
          { key: "Mod-y", run: () => this.redo(), preventDefault: true },
        ]),
      ),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...foldKeymap, indentWithTab]),
      EditorView.domEventHandlers({
        beforeinput: (event) => {
          if (event.inputType === "historyUndo") {
            event.preventDefault();
            this.undo();
            return true;
          }
          if (event.inputType === "historyRedo") {
            event.preventDefault();
            this.redo();
            return true;
          }
          return false;
        },
      }),
      EditorView.updateListener.of((update) => {
        let local = false;
        for (const tr of update.transactions) {
          if (!tr.docChanged || tr.annotation(syncOrigin) !== undefined) continue;
          local = true;
          this.pushLocal(changeSetToTextOp(tr.changes));
        }
        if (local) this.verify("local edit");
        if (update.selectionSet || update.docChanged) this.sendCursorSoon();
      }),
    ];
  }

  private pushLocal(op: TextOp): void {
    if (isNoop(op)) return;
    this.applyingLocal = true;
    try {
      this.client.applyLocal(this.docId, op);
    } catch (err) {
      this.report("apply_failed", `Your edit could not be applied (${errorText(err)}). The editor was reset to the synced text.`);
      queueMicrotask(() => this.resync());
    } finally {
      this.applyingLocal = false;
    }
  }

  private onClientChange(docId: string, op: TextOp, origin: ChangeOrigin): void {
    if (docId !== this.docId || this.destroyed) return;
    if (origin === "local") return;
    if (this.applyingLocal) {
      this.report("remote_failed", `A ${origin} change arrived while a local edit was being applied; resyncing the editor.`);
      queueMicrotask(() => this.resync());
      return;
    }
    const effective = origin === "snapshot" ? diffToTextOp(this.view.state.sliceDoc(), this.client.text(docId)) : op;
    let spec: TransactionSpec;
    try {
      spec = {
        changes: textOpToChangeSet(effective, this.view.state.doc.length),
        annotations: syncOrigin.of(origin),
      };
    } catch (err) {
      this.report("mismatch", `A ${origin} change does not fit the editor (${errorText(err)}). Resyncing.`);
      this.resync();
      return;
    }
    if (origin === "undo" || origin === "redo") {
      const end = editEndPosition(effective);
      if (end !== undefined) spec = { ...spec, selection: EditorSelection.cursor(end), scrollIntoView: true, userEvent: origin };
    }
    this.view.dispatch(spec);
    if (!this.ready && this.client.isReady(this.docId)) {
      this.ready = true;
      this.view.dispatch({ effects: this.editable.reconfigure(this.editableExtension()) });
      this.opts.onReady?.();
      this.sendCursorSoon();
    }
    this.verify(origin === "remote" ? "remote edit" : origin);
    this.refreshCursors();
  }

  private resync(): void {
    if (this.destroyed || !this.client.isReady(this.docId)) return;
    const op = diffToTextOp(this.view.state.sliceDoc(), this.client.text(this.docId));
    if (isNoop(op)) return;
    this.view.dispatch({ changes: textOpToChangeSet(op, this.view.state.doc.length), annotations: syncOrigin.of("snapshot") });
    this.verify("resync");
  }

  private verify(context: string): void {
    if (!this.opts.assertSync || !this.client.isReady(this.docId)) return;
    const editor = this.view.state.sliceDoc();
    const engine = this.client.text(this.docId);
    if (editor === engine) return;
    let at = 0;
    while (at < editor.length && editor.charCodeAt(at) === engine.charCodeAt(at)) at++;
    const message =
      `Editor and sync engine disagree after ${context} (${this.path}): ` +
      `editor has ${editor.length} chars, engine has ${engine.length}, first difference at offset ${at}.`;
    console.error(`[split-brain] ${message}`, { docId: this.docId, editor, engine });
    this.report("mismatch", message);
  }

  private refreshCursors(): void {
    if (this.destroyed) return;
    const cursors = this.client.cursors(this.docId).map((c) => ({
      clientId: c.clientId,
      name: c.user.name,
      color: this.opts.colorOf(c.user),
      anchor: c.anchor,
      head: c.head,
    }));
    this.view.dispatch({ effects: setRemoteCursors.of(cursors) });
  }

  private sendCursorSoon(): void {
    if (this.cursorTimer !== undefined) {
      this.cursorDirty = true;
      return;
    }
    this.sendCursorNow();
    this.cursorTimer = setTimeout(() => this.flushCursor(), CURSOR_THROTTLE_MS);
  }

  private flushCursor(): void {
    this.cursorTimer = undefined;
    if (!this.cursorDirty || this.destroyed) return;
    this.cursorDirty = false;
    this.sendCursorNow();
    this.cursorTimer = setTimeout(() => this.flushCursor(), CURSOR_THROTTLE_MS);
  }

  private sendCursorNow(): void {
    if (!this.ready || this.destroyed) return;
    const { anchor, head } = this.view.state.selection.main;
    this.client.setCursor(this.docId, anchor, head);
  }

  private report(kind: BindingIssueKind, message: string): void {
    this.opts.onIssue(kind, message);
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
