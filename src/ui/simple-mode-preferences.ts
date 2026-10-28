/** Display preferences use the authenticated tenant/context API, never browser storage. */
export const SIMPLE_MODE_KEY = "simple_mode";

export interface SimpleModeSnapshot {
  scope: string | null;
  enabled: boolean;
  ready: boolean;
  saving: boolean;
  error: string | null;
}

export function simpleModeScope(session: {
  authenticated: boolean;
  csrfToken?: string;
  customer?: string;
  tenantRef?: string;
  context?: { id: string };
} | null): string | null {
  if (!session?.authenticated || !session.context || !session.csrfToken) return null;
  // The token distinguishes sessions, even when they use the same customer/context.
  // This identity stays in memory; never use it as a DOM attribute or storage key.
  return JSON.stringify([session.csrfToken, session.customer, session.tenantRef, session.context.id]);
}

const empty = (scope: string | null): SimpleModeSnapshot => ({ scope, enabled: false, ready: false, saving: false, error: null });

/** Guards late responses and rolls back failed optimistic writes within their original scope only. */
export class SimpleModePreferences {
  private snapshot = empty(null);
  private generation = 0;
  private listeners = new Set<() => void>();
  private pendingWrite: Promise<boolean> | null = null;

  constructor(private transport: {
    read: () => Promise<{ preferences?: Record<string, unknown> }>;
    write: (enabled: boolean) => Promise<{ value?: unknown }>;
  }) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(snapshot: SimpleModeSnapshot) {
    this.snapshot = snapshot;
    this.listeners.forEach((listener) => listener());
  }

  async activate(scope: string | null) {
    const generation = ++this.generation;
    this.publish(empty(scope));
    if (!scope) return;
    try {
      const result = await this.transport.read();
      if (generation !== this.generation) return;
      this.publish({ ...empty(scope), ready: true, enabled: result.preferences?.[SIMPLE_MODE_KEY] === true });
    } catch {
      if (generation !== this.generation) return;
      this.publish({ ...empty(scope), error: "Could not load your display preference. Try again." });
    }
  }

  save(scope: string | null, enabled: boolean): Promise<boolean> {
    const previous = this.snapshot;
    if (!scope || scope !== previous.scope || !previous.ready || previous.saving) return Promise.resolve(false);
    const generation = this.generation;
    this.publish({ ...previous, enabled, saving: true, error: null });
    const write = (async () => {
      try {
        const result = await this.transport.write(enabled);
        if (result.value !== enabled) throw new Error("Preference not confirmed");
        if (generation !== this.generation) return false;
        this.publish({ ...previous, enabled, saving: false, error: null });
        return true;
      } catch {
        if (generation === this.generation) this.publish({ ...previous, saving: false, error: "Simple mode was not saved. Your previous display setting is still in use. Try again." });
        return false;
      }
    })();
    this.pendingWrite = write;
    void write.finally(() => { if (this.pendingWrite === write) this.pendingWrite = null; });
    return write;
  }

  /** Finish an already-sent write before changing the server session's active context. */
  settleWrite = async () => { await this.pendingWrite; };
}
