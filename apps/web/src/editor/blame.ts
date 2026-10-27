import { StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { translucent } from "./remote-cursors.ts";

export interface BlameRange {
  from: number;
  to: number;
  color: string;
  author: string;
}

export const setBlame = StateEffect.define<BlameRange[] | null>();

export const blameField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setBlame)) continue;
      if (!effect.value) {
        next = Decoration.none;
        continue;
      }
      const length = tr.state.doc.length;
      const ranges: Range<Decoration>[] = [];
      for (const r of effect.value) {
        const from = Math.max(0, Math.min(r.from, length));
        const to = Math.max(0, Math.min(r.to, length));
        if (from >= to) continue;
        ranges.push(
          Decoration.mark({
            class: "cm-blame",
            attributes: { style: `background-color: ${translucent(r.color, 0.2)}; box-shadow: inset 0 -2px 0 ${translucent(r.color, 0.65)}`, title: r.author },
          }).range(from, to),
        );
      }
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
