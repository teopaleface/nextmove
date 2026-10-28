"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { VoiceSession, appendVoiceDraft, browserVoicePlatform, visibleScreenSummary } from "./voice";
import type { VoiceState } from "./voice";

const initial: VoiceState = { reading: false, listening: false, canRead: false, canListen: false, message: "Checking voice support. You can always read and type instead." };
const VoiceContext = createContext<{
  state: VoiceState;
  read: (text: string) => void;
  listen: (draft: (text: string) => void) => void;
  stop: () => void;
} | null>(null);

/** Shell keys this provider by route, context and session epoch. Nothing starts on mount. */
export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const controller = useRef<VoiceSession | null>(null);
  const [state, setState] = useState(initial);
  useEffect(() => {
    const voice = new VoiceSession(browserVoicePlatform(), setState);
    controller.current = voice;
    setState(voice.getState());
    const hidden = () => { if (document.hidden) voice.stop(); };
    const leave = () => voice.stop();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leave);
    return () => {
      controller.current = null;
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leave);
      voice.dispose();
    };
  }, []);
  const read = useCallback((text: string) => controller.current?.read(text), []);
  const listen = useCallback((draft: (text: string) => void) => controller.current?.listen(draft), []);
  const stop = useCallback(() => controller.current?.stop(), []);
  return <VoiceContext.Provider value={{ state, read, listen, stop }}>{children}</VoiceContext.Provider>;
}

export function useVoice() {
  const voice = useContext(VoiceContext);
  if (!voice) throw new Error("useVoice outside VoiceProvider");
  return voice;
}

export function ReadAloud({ content }: { content: RefObject<HTMLDivElement | null> }) {
  const { state, read, stop } = useVoice();
  useEffect(() => () => stop(), [stop]);
  // A changed summary (including a changed selection/price) stops the previous reading.
  useEffect(() => {
    if (!state.reading || !content.current) return;
    const screen = content.current;
    const observer = new MutationObserver(stop);
    observer.observe(screen, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["checked", "hidden", "open", "aria-checked"] });
    screen.addEventListener("input", stop);
    screen.addEventListener("change", stop);
    return () => {
      observer.disconnect();
      screen.removeEventListener("input", stop);
      screen.removeEventListener("change", stop);
    };
  }, [state.reading, content, stop]);
  return (
    <details className="voice-panel" onToggle={(event) => { if (!event.currentTarget.open) stop(); }}>
      <summary>Read aloud (optional)</summary>
      <p className="small">Reads a short summary, which may include private amounts. Full amounts, fees and conditions stay on screen.</p>
      <div className="voice-actions">
        <button type="button" className="btn" disabled={!state.canRead || state.reading} onClick={() => read(visibleScreenSummary(content.current))}>Read summary aloud</button>
        {state.reading ? <button type="button" className="btn" onClick={stop}>Stop reading</button> : null}
      </div>
      <p className="small" role="status">{state.canRead ? state.message : "Read-aloud is unavailable in this browser. All information is available as text."}</p>
    </details>
  );
}

export function VoiceDraft({ text, onDraft, disabled }: { text: string; onDraft: (text: string) => void; disabled?: boolean }) {
  const { state, listen, stop } = useVoice();
  useEffect(() => () => stop(), [stop]);
  return (
    <details className="voice-panel" onToggle={(event) => { if (!event.currentTarget.open) stop(); }}>
      <summary>Use your voice (optional)</summary>
      <p className="small">Your browser may send audio to its speech service. Start only when you are ready. Speech adds text to your editable draft; it never sends or approves anything.</p>
      <div className="voice-actions">
        <button type="button" className="btn" disabled={disabled || !state.canListen || state.listening} onClick={() => listen((transcript) => onDraft(appendVoiceDraft(text, transcript)))}>Speak a draft</button>
        {state.listening ? <button type="button" className="btn" onClick={stop}>Stop microphone</button> : null}
      </div>
      <p className="small" role="status">{state.canListen ? state.message : "Speech input is unavailable in this browser. Type in the question box instead."}</p>
    </details>
  );
}
