"use client";

import Link from "next/link";
import { useSession } from "./session";
import { Group, Section } from "./kit";

export function SimpleModeSettings() {
  const { simpleMode, simpleModeReady, simpleModeSaving, simpleModeError, setSimpleMode, reloadSimpleMode } = useSession();
  return (
    <Section title="Display and voice" id="display">
      <Group>
        <label className="row check-row">
          <input type="checkbox" checked={simpleMode} disabled={!simpleModeReady || simpleModeSaving} onChange={(event) => { void setSimpleMode(event.target.checked); }} aria-describedby="simple-mode-help" />
          <span className="row-main">
            <span className="row-title">Simple mode</span>
            <span className="row-sub" id="simple-mode-help">Larger text, larger buttons and clear directions. Every amount, fee and approval stays available.</span>
          </span>
        </label>
      </Group>
      <p className="small muted" role="status">{simpleModeSaving ? "Saving your display preference…" : simpleModeReady ? `Simple mode is ${simpleMode ? "on" : "off"} for this customer context.` : simpleModeError ? "Your saved display preference is unavailable." : "Loading your display preference…"}</p>
      {simpleModeError ? <div role="alert"><p className="small">{simpleModeError}</p><button type="button" className="btn" onClick={() => { void reloadSimpleMode(); }}>Try again</button></div> : null}
      <p className="small muted">Optional read-aloud is available in Simple mode. On Agent, you can also speak a draft. Voice starts only when you choose it, and you can stop at any time.</p>
    </Section>
  );
}

export function simpleOrientation(path: string): { place: string; help: string } {
  if (path.startsWith("/review") || path.startsWith("/batch")) return { place: "Review", help: "Check each selected action, amount, fee and condition before you confirm. You can go back without approving." };
  if (path.startsWith("/actions") || path.startsWith("/receipts")) return { place: "Action details", help: "Check the outcome and receipt. Pending or unknown does not mean completed." };
  if (path.startsWith("/profile")) return { place: "Profile", help: "Change Simple mode below. Your setting is saved for the current customer context." };
  if (path.startsWith("/activity")) return { place: "Activity", help: "See payments and charges. Open an item for the full details." };
  if (path.startsWith("/goals")) return { place: "Goals", help: "Check your plans and the money they need. A plan does not move money." };
  if (path.startsWith("/agent") || path.startsWith("/capabilities")) return { place: "Agent", help: "Write or speak a question. Check your draft, then press Send. Any commitment still needs an exact review." };
  return { place: "Your bank", help: "Home shows your money. Activity shows charges. Goals holds your plans. Agent helps you decide." };
}

export function SimpleOrientation({ pathname, context }: { pathname: string; context?: string }) {
  const { place, help } = simpleOrientation(pathname);
  return (
    <aside className="simple-orientation" aria-label="Screen guide">
      <div className="label">{place}{context ? ` · ${context}` : ""}</div>
      <p>{help}</p>
      <Link href="/profile#display" className="link">Simple mode settings</Link>
    </aside>
  );
}
