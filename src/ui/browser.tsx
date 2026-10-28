"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { time } from "./format";

export interface BrowserStep {
  at: string;
  label: string;
  url: string;
  screenshot: string | null;
}

/** Evidence view of the isolated browser: what the agent saw at each step, with the page address. */
export function BrowserFrame({ steps, merchant, live }: { steps: BrowserStep[]; merchant: string; live?: boolean }) {
  const [index, setIndex] = useState(Math.max(0, steps.length - 1));
  useEffect(() => setIndex(Math.max(0, steps.length - 1)), [steps.length]);
  const step = steps[index];
  const withShots = steps.filter((s) => s.screenshot);
  return (
    <div className="browser" aria-label={`Isolated browser view of ${merchant}`}>
      <div className="browser-bar">
        <Icon.lock size={14} />
        <span className="browser-url">{step ? `${merchant} (simulated) ${step.url.replace(/^\/m\/[^/]+/, "") || "/"}` : `${merchant} (simulated)`}</span>
        {live ? <span className="caption">Live</span> : null}
      </div>
      <div className="browser-shot">
        {step?.screenshot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={`/api/evidence/screens/${step.screenshot}`} alt={`${merchant} page: ${step.label}`} width={390} height={780} style={{ width: "100%", height: "auto" }} />
        ) : (
          <div className="empty" style={{ minHeight: 120 }}>
            {step ? step.label : live ? "Opening the provider page…" : "No page captured"}
          </div>
        )}
      </div>
      {steps.length ? (
        <div style={{ padding: "10px 12px 0" }}>
          <div className="small" style={{ fontWeight: 600 }}>
            Step {index + 1} of {steps.length}: {step?.label}
          </div>
          <div className="caption">{step ? time(step.at) : ""}</div>
        </div>
      ) : null}
      {withShots.length > 1 ? (
        <div className="browser-steps" role="group" aria-label="Browser steps">
          {steps.map((s, i) => (
            <button key={i} type="button" aria-pressed={i === index} onClick={() => setIndex(i)} aria-label={`Show step ${i + 1}: ${s.label}`}>
              {i + 1}
            </button>
          ))}
        </div>
      ) : (
        <div style={{ height: 12 }} />
      )}
      <p className="caption" style={{ margin: 0, padding: "0 12px 12px" }}>
        Fresh isolated browser with scripts and downloads off. It can open only {merchant}'s pages, and the final request passes the approval check before it leaves.
      </p>
    </div>
  );
}
