"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api, setCsrf } from "./api";

export interface SessionInfo {
  authenticated: boolean;
  user?: { displayName: string; initials: string };
  customer?: "alex" | "laziz";
  isolated?: boolean;
  tenantRef?: string;
  context?: { id: string; kind: "PERSONAL" | "BUSINESS"; name: string; subtitle: string; role: string };
  contexts?: { id: string; kind: "PERSONAL" | "BUSINESS"; name: string; subtitle: string; role: string }[];
  csrfToken?: string;
  mode: "labs" | "bank-demo";
  features?: { mode: string; environment: string; realOperations: string; features: Record<string, boolean> };
  demoNow?: string;
  model?: any;
}

interface Ctx {
  session: SessionInfo | null;
  /** Milliseconds to add to a real timestamp to place it on this tenant's demo clock. */
  demoOffset: number;
  epoch: number;
  refresh: () => Promise<SessionInfo | null>;
  switchContext: (id: string) => Promise<void>;
  signOut: () => Promise<void>;
  toast: (text: string) => void;
}

const SessionCtx = createContext<Ctx | null>(null);

export function SessionProvider({ children, requireAuth = true }: { children: React.ReactNode; requireAuth?: boolean }) {
  const router = useRouter();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [demoOffset, setDemoOffset] = useState(0);
  const [toastText, setToastText] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<SessionInfo>("/session");
      setCsrf(s.csrfToken ?? null);
      setSession(s);
      if (s.demoNow) setDemoOffset(Date.parse(s.demoNow) - Date.now());
      if (requireAuth && !s.authenticated) router.replace("/signin");
      return s;
    } catch {
      setSession({ authenticated: false, mode: "labs" });
      return null;
    }
  }, [requireAuth, router]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toast = useCallback((text: string) => {
    setToastText(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(null), 3600);
  }, []);

  const switchContext = useCallback(
    async (id: string) => {
      await api("/session/context", { body: { contextId: id } });
      await refresh();
      setEpoch((e) => e + 1);
      router.push("/home");
    },
    [refresh, router],
  );

  const signOut = useCallback(async () => {
    await api("/session/logout", { body: {} }).catch(() => undefined);
    setCsrf(null);
    setSession({ authenticated: false, mode: session?.mode ?? "labs" });
    router.replace("/signin");
  }, [router, session?.mode]);

  const value = useMemo(() => ({ session, epoch, demoOffset, refresh, switchContext, signOut, toast }), [session, epoch, demoOffset, refresh, switchContext, signOut, toast]);
  return (
    <SessionCtx.Provider value={value}>
      {children}
      {toastText ? (
        <div className="toast" role="status" aria-live="polite">
          {toastText}
        </div>
      ) : null}
    </SessionCtx.Provider>
  );
}

export function useSession() {
  const c = useContext(SessionCtx);
  if (!c) throw new Error("useSession outside SessionProvider");
  return c;
}
