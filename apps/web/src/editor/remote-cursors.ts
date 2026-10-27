import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export interface RemoteCursorView {
  clientId: string;
  name: string;
  color: string;
  anchor: number;
  head: number;
}

export const setRemoteCursors = StateEffect.define<RemoteCursorView[]>();

class CaretWidget extends WidgetType {
  readonly name: string;
  readonly color: string;
  readonly clientId: string;

  constructor(name: string, color: string, clientId: string) {
    super();
    this.name = name;
    this.color = color;
    this.clientId = clientId;
  }

  override eq(other: CaretWidget): boolean {
    return other.name === this.name && other.color === this.color && other.clientId === this.clientId;
  }

  toDOM(): HTMLElement {
    const caret = document.createElement("span");
    caret.className = "cm-remote-caret";
    caret.style.borderColor = this.color;
    caret.setAttribute("aria-hidden", "true");
    caret.dataset.clientId = this.clientId;
    const label = document.createElement("span");
    label.className = "cm-remote-label";
    label.style.backgroundColor = this.color;
    label.textContent = this.name;
    caret.appendChild(label);
    return caret;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export function translucent(color: string, alpha: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
  let hex = m[1]!;
  if (hex.length === 3) hex = hex.replace(/./g, (c) => c + c);
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function build(cursors: RemoteCursorView[], length: number): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const c of cursors) {
    const head = Math.max(0, Math.min(c.head, length));
    const anchor = Math.max(0, Math.min(c.anchor, length));
    const from = Math.min(head, anchor);
    const to = Math.max(head, anchor);
    if (from < to) {
      ranges.push(
        Decoration.mark({
          class: "cm-remote-selection",
          attributes: { style: `background-color: ${translucent(c.color, 0.28)}` },
        }).range(from, to),
      );
    }
    ranges.push(Decoration.widget({ widget: new CaretWidget(c.name, c.color, c.clientId), side: 1 }).range(head));
  }
  return Decoration.set(ranges, true);
}

export const remoteCursorsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setRemoteCursors)) next = build(effect.value, tr.state.doc.length);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
