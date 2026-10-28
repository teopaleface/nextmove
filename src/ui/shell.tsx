"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Icon, NMark } from "./icons";
import { SessionProvider, useSession } from "./session";
import { SimpleOrientation } from "./simple-mode";
import { ReadAloud, VoiceProvider } from "./voice-tools";

const TABS = [
  { href: "/home", label: "Home", icon: Icon.home, match: ["/home", "/business"] },
  { href: "/activity", label: "Activity", icon: Icon.activity, match: ["/activity"] },
  { href: "/goals", label: "Goals", icon: Icon.goals, match: ["/goals"] },
  { href: "/agent", label: "Agent", icon: Icon.agent, match: ["/agent", "/capabilities", "/actions", "/receipts", "/batch", "/review"] },
];

export function AppFrame({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Shell>{children}</Shell>
    </SessionProvider>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { session, switchContext, epoch, contextChanging, simpleMode, simpleModeError } = useSession();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hideTabs = pathname.startsWith("/review");

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => setMenu(false), [pathname]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false);
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [menu]);

  const ctx = session?.context;
  const multi = (session?.contexts?.length ?? 0) > 1;
  return (
    <VoiceProvider key={`${epoch}:${Boolean(session?.authenticated)}:${contextChanging}:${pathname}`}><div className="app" data-simple-mode={simpleMode ? "true" : undefined}>
      <header className={`header${scrolled ? " scrolled" : ""}`}>
        <Link href="/home" className="brand" aria-label="NextMove home">
          <NMark />
        </Link>
        <div ref={menuRef} style={{ display: "contents" }}>
          <button type="button" className="context-btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => multi && setMenu((m) => !m)} disabled={!multi} aria-label={ctx ? `Context: ${ctx.name}${multi ? ". Switch context" : ""}` : "Context"}>
            {ctx ? (
              <span>{ctx.name}</span>
            ) : (
              <span className="muted">NextMove</span>
            )}
            {multi ? <Icon.chevronDown size={18} /> : null}
          </button>
          {menu && session?.contexts ? (
            <div className="menu" role="menu" aria-label="Switch context">
              {session.contexts.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={c.id === ctx?.id}
                  className="row"
                  onClick={() => {
                    setMenu(false);
                    if (c.id !== ctx?.id) void switchContext(c.id);
                  }}
                >
                  <span className="mark" aria-hidden="true">
                    {c.kind === "BUSINESS" ? <Icon.briefcase size={20} /> : <Icon.user size={20} />}
                  </span>
                  <span className="row-main">
                    <span className="row-title" style={{ display: "block" }}>
                      {c.name}
                    </span>
                    <span className="row-sub" style={{ display: "block" }}>
                      {c.kind === "BUSINESS" ? `Business, ${c.role.toLowerCase()}` : "Personal"}
                    </span>
                  </span>
                  {c.id === ctx?.id ? <Icon.check size={20} /> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <span className="header-spacer" />
        <span className="env-label" title={session?.features?.environment ?? "Synthetic demo data"}>
          {session?.mode === "bank-demo" ? "Demo" : "Demo Labs"}
        </span>
        <Link href="/agent/monitoring" className="icon-btn" aria-label="Alerts and monitoring">
          <Icon.bell size={22} />
        </Link>
        <Link href="/profile" className="icon-btn" aria-label="Profile, context and access">
          <span className="avatar">{session?.user?.initials ?? ""}</span>
        </Link>
      </header>
      <main className={`main${hideTabs ? " no-tabs" : ""}`} id="main">
        {simpleModeError && !pathname.startsWith("/profile") ? (
          <aside className="display-preference-error" role="alert">
            <p>{simpleModeError}</p>
            <Link href="/profile#display" className="link">Retry in display settings</Link>
          </aside>
        ) : null}
        {session?.authenticated && !contextChanging && simpleMode ? <SimpleOrientation pathname={pathname} context={ctx?.name} /> : null}
        {session?.authenticated && !contextChanging && simpleMode ? <ReadAloud content={contentRef} /> : null}
        <div ref={contentRef}>{session?.authenticated && !contextChanging ? children : <ShellLoading />}</div>
      </main>
      {hideTabs ? null : (
        <nav className="tabbar" aria-label="Main">
          {TABS.map((t) => {
            const active = t.match.some((m) => pathname === m || pathname.startsWith(`${m}/`));
            const I = t.icon;
            return (
              <Link key={t.href} href={t.href} className="tab" aria-current={active ? "page" : undefined}>
                <I size={24} />
                <span>{t.label}</span>
              </Link>
            );
          })}
        </nav>
      )}
    </div></VoiceProvider>
  );
}

function ShellLoading() {
  return (
    <div className="stack" style={{ marginTop: 16 }} aria-busy="true">
      <span className="sr-only">Updating your accounts…</span>
      <div className="skeleton" style={{ height: 96 }} />
      <div className="skeleton" style={{ height: 160 }} />
    </div>
  );
}
