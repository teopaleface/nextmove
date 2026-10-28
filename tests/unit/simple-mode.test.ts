import { describe, expect, it, vi } from "vitest";
import { SimpleModePreferences, simpleModeScope } from "../../src/ui/simple-mode-preferences";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const session = { authenticated: true, csrfToken: "test-session-a", customer: "alex", tenantRef: "test-tenant", context: { id: "test-tenant:personal" } };

describe("Simple mode preferences", () => {
  it("separates session, tenant, customer and context identities; signed-out has no scope", () => {
    const scope = simpleModeScope(session);
    expect(scope).not.toBeNull();
    for (const other of [
      { ...session, csrfToken: "test-session-b" },
      { ...session, tenantRef: "another-tenant" },
      { ...session, customer: "laziz" },
      { ...session, context: { id: "test-tenant:business" } },
    ]) expect(simpleModeScope(other)).not.toBe(scope);
    expect(simpleModeScope(null)).toBeNull();
    expect(simpleModeScope({ ...session, authenticated: false })).toBeNull();
    expect(simpleModeScope({ ...session, csrfToken: undefined })).toBeNull();
  });

  it("enables only a saved boolean true, never truthy strings or unrelated financial preferences", async () => {
    for (const value of [undefined, null, false, "true", 1, [true], { enabled: true }]) {
      const prefs = new SimpleModePreferences({ read: async () => ({ preferences: { simple_mode: value, protected_benefits: ["offline_playback"] } }), write: async () => ({}) });
      await prefs.activate("a");
      expect(prefs.getSnapshot()).toMatchObject({ enabled: false, ready: true });
    }
    const prefs = new SimpleModePreferences({ read: async () => ({ preferences: { simple_mode: true } }), write: async () => ({}) });
    await prefs.activate("a");
    expect(prefs.getSnapshot().enabled).toBe(true);
  });

  it("never paints an old context's late preference load, including after logout", async () => {
    const a = deferred<{ preferences: Record<string, unknown> }>();
    const b = deferred<{ preferences: Record<string, unknown> }>();
    const read = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const prefs = new SimpleModePreferences({ read, write: async () => ({}) });
    const first = prefs.activate("a");
    const second = prefs.activate("b");
    a.resolve({ preferences: { simple_mode: true } });
    await first;
    expect(prefs.getSnapshot()).toMatchObject({ scope: "b", enabled: false, ready: false });
    await prefs.activate(null);
    b.resolve({ preferences: { simple_mode: true } });
    await second;
    expect(prefs.getSnapshot()).toMatchObject({ scope: null, enabled: false, ready: false, error: null });
  });

  it("saves a boolean, answers the tap immediately, and prevents duplicate writes", async () => {
    const done = deferred<{ value: unknown }>();
    const write = vi.fn(() => done.promise);
    const prefs = new SimpleModePreferences({ read: async () => ({ preferences: {} }), write });
    await prefs.activate("a");
    const saving = prefs.save("a", true);
    expect(prefs.getSnapshot()).toMatchObject({ enabled: true, saving: true });
    expect(await prefs.save("a", false)).toBe(false);
    expect(await prefs.save("b", true)).toBe(false);
    expect(write).toHaveBeenCalledExactlyOnceWith(true);
    let settled = false;
    const waiting = prefs.settleWrite().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    done.resolve({ value: true });
    expect(await saving).toBe(true);
    await waiting;
    expect(settled).toBe(true);
    expect(prefs.getSnapshot()).toMatchObject({ enabled: true, saving: false, error: null });
  });

  it("rolls back a failed write and a mismatched server acknowledgement", async () => {
    for (const write of [async () => { throw new Error("offline"); }, async () => ({ value: "true" })]) {
      const prefs = new SimpleModePreferences({ read: async () => ({ preferences: { simple_mode: false } }), write });
      await prefs.activate("a");
      expect(await prefs.save("a", true)).toBe(false);
      expect(prefs.getSnapshot()).toMatchObject({ enabled: false, saving: false });
      expect(prefs.getSnapshot().error).toContain("not saved");
    }
  });

  it("neither a late write success nor a late failure can alter a new context", async () => {
    for (const succeed of [true, false]) {
      const done = deferred<{ value: unknown }>();
      const prefs = new SimpleModePreferences({ read: async () => ({ preferences: { simple_mode: false } }), write: () => done.promise });
      await prefs.activate("a");
      const saving = prefs.save("a", true);
      await prefs.activate("b");
      if (succeed) done.resolve({ value: true });
      else done.reject(new Error("late error"));
      expect(await saving).toBe(false);
      expect(prefs.getSnapshot()).toMatchObject({ scope: "b", enabled: false, ready: true, error: null });
    }
  });

  it("shows a retryable load error and refuses to write before the correct scope is ready", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ preferences: { simple_mode: true } });
    const write = vi.fn();
    const prefs = new SimpleModePreferences({ read, write });
    await prefs.activate("a");
    expect(prefs.getSnapshot()).toMatchObject({ ready: false, enabled: false });
    expect(prefs.getSnapshot().error).toContain("Try again");
    expect(await prefs.save("a", true)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    await prefs.activate("a");
    expect(prefs.getSnapshot()).toMatchObject({ ready: true, enabled: true, error: null });
  });
});
