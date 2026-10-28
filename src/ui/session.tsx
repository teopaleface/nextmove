"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { api, setCsrf } from "./api";
import { SIMPLE_MODE_KEY, SimpleModePreferences, simpleModeScope } from "./simple-mode-preferences";

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
  contextChanging: boolean;
  simpleMode: boolean;
  simpleModeReady: boolean;
  simpleModeSaving: boolean;
  simpleModeError: string | null;
  setSimpleMode: (enabled: boolean) => Promise<boolean>;
  reloadSimpleMode: () => Promise<void>;
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
  const [contextChanging, setContextChanging] = useState(false);
  const sessionIdentity = useRef<string | null>(null);
  const refreshSequence = useRef(0);
  const transition = useRef(false);
  const preferences = useMemo(() => new SimpleModePreferences({
    read: () => api("/permissions"),
    write: (enabled) => api("/preferences", { body: { key: SIMPLE_MODE_KEY, value: enabled } }),
  }), []);
  const preferenceState = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot, preferences.getSnapshot);
  const scope = contextChanging ? null : simpleModeScope(session);
  const preferenceMatches = Boolean(scope && preferenceState.scope === scope);
  const simpleMode = preferenceMatches && preferenceState.enabled;
  const simpleModeReady = preferenceMatches && preferenceState.ready;
  const simpleModeSaving = preferenceMatches && preferenceState.saving;
  const simpleModeError = preferenceMatches ? preferenceState.error : null;
  const setSimpleMode = useCallback((enabled: boolean) => preferences.save(scope, enabled), [preferences, scope]);
  const reloadSimpleMode = useCallback(() => preferences.activate(scope), [preferences, scope]);

  useEffect(() => {
    void preferences.activate(scope);
    return () => { void preferences.activate(null); };
  }, [preferences, scope]);
  const [demoOffset, setDemoOffset] = useState(0);
  const [toastText, setToastText] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const s = await api<SessionInfo>("/session");
      if (sequence !== refreshSequence.current) return null;
      const identity = simpleModeScope(s);
      if (sessionIdentity.current !== identity) {
        sessionIdentity.current = identity;
        void preferences.activate(null);
        setEpoch((e) => e + 1);
      }
      setCsrf(s.csrfToken ?? null);
      setSession(s);
      if (s.demoNow) setDemoOffset(Date.parse(s.demoNow) - Date.now());
      if (requireAuth && !s.authenticated) router.replace("/signin");
      return s;
    } catch {
      if (sequence !== refreshSequence.current) return null;
      void preferences.activate(null);
      setCsrf(null);
      setSession({ authenticated: false, mode: "labs" });
      return null;
    }
  }, [preferences, requireAuth, router]);

  useEffect(() => {
    void refresh();
    return () => { ++refreshSequence.current; };
  }, [refresh]);

  const toast = useCallback((text: string) => {
    setToastText(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastText(null), 3600);
  }, []);

  const switchContext = useCallback(
    async (id: string) => {
      if (transition.current) return;
      transition.current = true;
      ++refreshSequence.current;
      setContextChanging(true);
      void preferences.activate(null);
      try {
        // A pending display write must finish while its original context is still active.
        await preferences.settleWrite();
        await api("/session/context", { body: { contextId: id } });
        await refresh();
        router.push("/home");
      } catch {
        toast("Could not switch context. Please try again.");
      } finally {
        transition.current = false;
        setContextChanging(false);
      }
    },
    [preferences, refresh, router, toast],
  );

  const signOut = useCallback(async () => {
    if (transition.current) return;
    transition.current = true;
    ++refreshSequence.current;
    setContextChanging(true);
    void preferences.activate(null);
    await preferences.settleWrite();
    await api("/session/logout", { body: {} }).catch(() => undefined);
    sessionIdentity.current = null;
    setCsrf(null);
    setSession({ authenticated: false, mode: session?.mode ?? "labs" });
    transition.current = false;
    setContextChanging(false);
    router.replace("/signin");
  }, [preferences, router, session?.mode]);

  const value = useMemo(() => ({ session, epoch, demoOffset, contextChanging, simpleMode, simpleModeReady, simpleModeSaving, simpleModeError, setSimpleMode, reloadSimpleMode, refresh, switchContext, signOut, toast }), [session, epoch, demoOffset, contextChanging, simpleMode, simpleModeReady, simpleModeSaving, simpleModeError, setSimpleMode, reloadSimpleMode, refresh, switchContext, signOut, toast]);
  return (
    <SessionCtx.Provider value={value}>
      {children}
      {toastText ? (
        <div className={simpleMode ? "toast simple-toast" : "toast"} role="status" aria-live="polite">
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
