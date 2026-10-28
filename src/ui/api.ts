"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Client-side API access. The server derives tenant, user and context from the HttpOnly session cookie; the client
// only adds the per-session CSRF token to state-changing requests.

export class ApiError extends Error {
  /** Seconds the server asked us to wait (429 Retry-After), else 0. */
  constructor(public status: number, public code: string, message: string, public retryAfter = 0) {
    super(message);
  }
}

let csrfToken: string | null = null;
export function setCsrf(token: string | null) {
  csrfToken = token;
}

export async function api<T = any>(path: string, opts: { method?: "GET" | "POST" | "DELETE"; body?: unknown; form?: FormData } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.form ? "POST" : "GET");
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : method === "POST" ? "{}" : undefined),
    credentials: "same-origin",
    cache: "no-store",
  });
  const type = res.headers.get("content-type") ?? "";
  const data = type.includes("application/json") ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data as any)?.error ?? "ERROR", (data as any)?.message ?? `Request failed (${res.status})`, Math.min(3600, Math.max(0, Number(res.headers.get("retry-after")) || 0)));
  return data as T;
}

type Poll<T> = number | ((data: T) => number | null | false);

/** Fetch a JSON resource; keeps the last good data while refreshing and optionally polls while work is running. */
export function useApi<T = any>(path: string | null, opts: { poll?: Poll<T>; epoch?: number } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef(opts.poll);
  pollRef.current = opts.poll;

  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    if (timer.current) clearTimeout(timer.current);
    try {
      const d = await api<T>(path);
      if (mine !== seq.current) return;
      setData(d);
      setError(null);
      const p = pollRef.current;
      const next = typeof p === "function" ? p(d) : p;
      if (next) timer.current = setTimeout(load, next);
    } catch (e: any) {
      if (mine !== seq.current) return;
      setError(e instanceof ApiError ? e : new ApiError(0, "NETWORK", "Could not reach NextMove. Check that the local server is running."));
      const p = pollRef.current;
      // A rate-limited poll waits as long as the server asked instead of knocking every 3 seconds.
      if (p) timer.current = setTimeout(load, Math.max(3000, (e instanceof ApiError ? e.retryAfter : 0) * 1000));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    setLoading(Boolean(path));
    void load();
    return () => {
      seq.current++;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, opts.epoch]);

  return { data, error, loading, reload: load, setData };
}
