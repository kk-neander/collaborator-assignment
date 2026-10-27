import { useCallback, useEffect, useRef, useState } from "react";

export interface PollState<T> {
  data: T | undefined;
  error: Error | undefined;
  refresh(): void;
}

export function usePoll<T>(fetcher: () => Promise<T>, intervalMs: number, enabled = true): PollState<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    const run = async () => {
      if (stopped || running) return;
      running = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        const value = await fetcherRef.current();
        if (!stopped) {
          setData(value);
          setError(undefined);
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        running = false;
        if (!stopped) timer = setTimeout(run, intervalMs);
      }
    };
    kick.current = () => void run();
    void run();
    return () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      kick.current = () => {};
    };
  }, [intervalMs, enabled]);

  const refresh = useCallback(() => kick.current(), []);
  return { data, error, refresh };
}

export function useTick(ms: number): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
  return tick;
}

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
