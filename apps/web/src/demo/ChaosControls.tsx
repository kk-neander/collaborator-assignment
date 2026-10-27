import { useState } from "react";
import { applyChaosPreset, patchChaosUser, resetChaos, type ChaosState, type ChaosUser, type ChaosUserPatch } from "../api.ts";
import { useTick } from "../ui/hooks.ts";
import { IconClock, IconPlug, IconReload, IconScissors, IconSnail } from "../ui/icons.tsx";
import { useToast } from "../ui/toasts.tsx";

const PARTITION_MS = 10_000;
const LATENCY_STEP_MS = 800;
const SKEW_MS = 5_000;

function useChaosAction(onDone: () => void) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      onDone();
    } catch (err) {
      toast({ tone: "error", title: `Chaos: ${label} failed`, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

export function UserChaos({ userId, name, state, onChanged }: { userId: string; name: string; state: ChaosUser | undefined; onChanged(): void }) {
  useTick(500);
  const { busy, run } = useChaosAction(onChanged);
  const latency = state?.latencyMs ?? 0;
  const skew = state?.skewMs ?? 0;
  const cutLeft = state ? Math.max(0, state.partitionedUntil - Date.now()) : 0;
  const patch = (label: string, body: ChaosUserPatch) => run(label, () => patchChaosUser(userId, body));

  return (
    <div className="chaos-user" aria-label={`Network chaos for ${name}`}>
      <button
        className={`chaos-btn${cutLeft > 0 ? " chaos-on chaos-danger" : ""}`}
        disabled={busy}
        onClick={() => void patch("partition", { partitionMs: PARTITION_MS })}
        title={`Cut ${name} off from the relay for 10 s (messages are held, not lost)`}
      >
        <IconScissors /> {cutLeft > 0 ? `cut ${Math.ceil(cutLeft / 1000)}s` : "Partition 10s"}
      </button>
      <span className={`chaos-btn-group${latency > 0 ? " chaos-on" : ""}`}>
        <button className="chaos-btn" disabled={busy} onClick={() => void patch("latency", { latencyMs: latency + LATENCY_STEP_MS })} title={`Add ${LATENCY_STEP_MS} ms latency for ${name}`}>
          <IconSnail /> {latency > 0 ? `${latency} ms` : "+800 ms"}
        </button>
        {latency > 0 && (
          <button className="chaos-btn chaos-clear" disabled={busy} onClick={() => void patch("latency", { latencyMs: 0, jitterMs: 0 })} aria-label="Clear latency" title="Clear latency">
            ×
          </button>
        )}
      </span>
      <button className="chaos-btn" disabled={busy} onClick={() => void patch("drop", { drop: true })} title={`Drop ${name}'s WebSocket (it reconnects)`}>
        <IconPlug /> Drop
      </button>
      <span className={`chaos-btn-group${skew !== 0 ? " chaos-on" : ""}`} title={`Skew ${name}'s clock`}>
        <IconClock className="chaos-group-icon" />
        <button className={`chaos-btn${skew === -SKEW_MS ? " chaos-active" : ""}`} disabled={busy} onClick={() => void patch("clock skew", { skewMs: skew === -SKEW_MS ? 0 : -SKEW_MS })}>
          −5s
        </button>
        <button className={`chaos-btn${skew === SKEW_MS ? " chaos-active" : ""}`} disabled={busy} onClick={() => void patch("clock skew", { skewMs: skew === SKEW_MS ? 0 : SKEW_MS })}>
          +5s
        </button>
      </span>
    </div>
  );
}

export function ChaosGlobal({ state, onChanged }: { state: ChaosState; onChanged(): void }) {
  const { busy, run } = useChaosAction(onChanged);
  return (
    <section className="chaos-global" aria-label="Chaos presets">
      <div className="chaos-title">Chaos</div>
      <div className="chaos-presets">
        {state.presets.map((p) => (
          <button key={p.name} className="chaos-btn chaos-preset" disabled={busy} title={p.description} onClick={() => void run(p.label, () => applyChaosPreset(p.name))}>
            {p.label}
          </button>
        ))}
        <button className="chaos-btn chaos-reset" disabled={busy} onClick={() => void run("reset", resetChaos)} title="Clear all latency, partitions and skew">
          <IconReload /> Reset
        </button>
      </div>
    </section>
  );
}
