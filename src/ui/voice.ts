/** Small Web Speech boundary. It can report a draft, but has no network, send or approval capability. */
export interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
export interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
export interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  abort: () => void;
}
export interface VoicePlatform {
  Recognition?: new () => Recognition;
  synthesis?: Pick<SpeechSynthesis, "speak" | "cancel">;
  utterance?: (text: string) => SpeechSynthesisUtterance;
}
export interface VoiceState {
  reading: boolean;
  listening: boolean;
  canRead: boolean;
  canListen: boolean;
  message: string;
}

export function browserVoicePlatform(): VoicePlatform {
  const browser = window as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return {
    Recognition: browser.SpeechRecognition ?? browser.webkitSpeechRecognition,
    synthesis: "speechSynthesis" in window ? window.speechSynthesis : undefined,
    utterance: typeof SpeechSynthesisUtterance === "function" ? (text) => new SpeechSynthesisUtterance(text) : undefined,
  };
}

export function appendVoiceDraft(existing: string, transcript: string, limit = 600): string {
  const spoken = transcript.replace(/\s+/g, " ").trim();
  if (!spoken) return existing;
  return [existing.trimEnd(), spoken].filter(Boolean).join(" ").slice(0, limit);
}

export class VoiceSession {
  private generation = 0;
  private disposed = false;
  private recognition: Recognition | null = null;
  private speech: SpeechSynthesisUtterance | null = null;
  private state: VoiceState;

  constructor(private platform: VoicePlatform, private changed: (state: VoiceState) => void) {
    this.state = { reading: false, listening: false, canRead: Boolean(platform.synthesis && platform.utterance), canListen: Boolean(platform.Recognition), message: "Voice is optional. You can always read and type instead." };
  }
  getState = () => this.state;
  private update(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    if (!this.disposed) this.changed(this.state);
  }
  private release() {
    ++this.generation;
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onresult = recognition.onerror = recognition.onend = null;
      try { recognition.abort(); } catch { /* Already ended or permission was refused. */ }
    }
    if (this.speech) {
      this.speech.onend = this.speech.onerror = null;
      this.speech = null;
      try { this.platform.synthesis?.cancel(); } catch { /* The browser may have torn down audio. */ }
    }
  }
  stop = () => {
    if (this.disposed) return;
    this.release();
    this.update({ reading: false, listening: false, message: "Voice stopped. You can read or type instead." });
  };
  dispose = () => {
    this.disposed = true;
    this.release();
  };

  read = (text: string) => {
    if (this.disposed) return;
    this.release();
    if (!this.state.canRead || !text.trim()) {
      this.update({ reading: false, listening: false, message: text.trim() ? "Read-aloud is unavailable in this browser. Read the summary on screen." : "There is no loaded summary to read yet." });
      return;
    }
    const generation = this.generation;
    try {
      const speech = this.platform.utterance!(text);
      this.speech = speech;
      speech.lang = "en-GB";
      speech.rate = 0.9;
      speech.onend = () => {
        if (this.disposed || generation !== this.generation) return;
        speech.onend = speech.onerror = null;
        this.speech = null;
        this.update({ reading: false, message: "Finished reading. Full details remain on screen." });
      };
      speech.onerror = () => {
        if (this.disposed || generation !== this.generation) return;
        this.release();
        this.update({ reading: false, listening: false, message: "Read-aloud could not finish. You can read the summary on screen or try again." });
      };
      this.update({ reading: true, listening: false, message: "Reading the summary aloud. This does not approve anything." });
      this.platform.synthesis!.speak(speech);
    } catch {
      this.release();
      this.update({ reading: false, listening: false, message: "Read-aloud could not start. You can read the summary on screen." });
    }
  };

  listen = (draft: (text: string) => void) => {
    if (this.disposed) return;
    this.release();
    if (!this.platform.Recognition) {
      this.update({ reading: false, listening: false, message: "Speech input is unavailable in this browser. Type your question instead." });
      return;
    }
    const generation = this.generation;
    const final = new Map<number, string>();
    try {
      const recognition = new this.platform.Recognition();
      this.recognition = recognition;
      recognition.lang = "en-GB";
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event) => {
        if (this.disposed || generation !== this.generation) return;
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) final.set(i, result[0].transcript);
        }
        const text = [...final.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join(" ").trim();
        if (text) draft(text); // Untrusted text only. Never submit, interpret authority or approve here.
      };
      recognition.onerror = (event) => {
        if (this.disposed || generation !== this.generation) return;
        this.release();
        const message = ["not-allowed", "service-not-allowed"].includes(event.error)
          ? "Microphone permission was denied. Type your question instead."
          : event.error === "no-speech" ? "No speech was captured. Type your question or try again."
          : event.error === "network" ? "Speech input could not reach the browser's service. Type your question instead."
          : "Speech input could not finish. Check your draft, or type your question instead.";
        this.update({ reading: false, listening: false, message });
      };
      recognition.onend = () => {
        if (this.disposed || generation !== this.generation) return;
        recognition.onresult = recognition.onerror = recognition.onend = null;
        this.recognition = null;
        ++this.generation;
        this.update({ listening: false, message: final.size ? "Draft ready. Check the text, then press Send." : "No speech was captured. Type your question or try again." });
      };
      this.update({ reading: false, listening: true, message: "Listening for a draft. Stop at any time. Nothing is sent to the agent." });
      recognition.start();
    } catch {
      this.release();
      this.update({ reading: false, listening: false, message: "The microphone could not start. Type your question instead." });
    }
  };
}

/** Read a bounded summary of rendered text, never input values, hidden details or developer output. */
export function visibleScreenSummary(root: HTMLElement | null): string {
  if (!root) return "";
  const parts: ScreenPart[] = [];
  const items: Element[] = [];
  const textOf = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (!(node instanceof HTMLElement) || node.matches("input, textarea, select, button, .sr-only, .dev, [hidden], [aria-hidden='true']") || getComputedStyle(node).display === "none" || getComputedStyle(node).visibility === "hidden") return "";
    return Array.from(node.childNodes, textOf).join(" ");
  };
  for (const element of root.querySelectorAll<HTMLElement>("h1, .lede, .balance, .account-tile, .opportunity h2, .opportunity p, .kv, .notice, [data-voice]")) {
    if (element.closest("details:not([open]), .dev, [hidden], [aria-hidden='true']") || !element.getClientRects().length || getComputedStyle(element).visibility === "hidden") continue;
    const text = textOf(element).replace(/\s+/g, " ").trim();
    if (!text) continue;
    // Lines inside one listed item (an action on the review screen) are summarised together.
    const item = element.closest("[data-voice-item]");
    if (item && !items.includes(item)) items.push(item);
    parts.push({ text, item: item ? items.indexOf(item) : undefined });
  }
  return screenSummary(parts);
}

export interface ScreenPart {
  text: string;
  /** Index of the listed item (for example one action) the text belongs to. */
  item?: number;
}

const SUMMARY_CAP = 3600;
const ITEM_MIN = 160;

/**
 * Bounded read-aloud text. Every listed item is kept: each gets an equal share of the budget and is cut between whole
 * lines, never inside one, so a long first action cannot push later ones out. Other lines fill what is left in screen
 * order. Nothing is cut through an amount or a term; what does not fit is left on screen and the summary says so.
 */
export function screenSummary(parts: ScreenPart[], cap = SUMMARY_CAP): string {
  const seen = new Set<string>();
  const unique = parts.filter((p) => {
    const k = `${p.item ?? ""}|${p.text}`;
    if (!p.text || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const itemIds = [...new Set(unique.filter((p) => p.item != null).map((p) => p.item!))];
  const share = itemIds.length ? Math.max(ITEM_MIN, Math.floor((cap * 0.7) / itemIds.length)) : 0;
  let cut = false;
  const itemText = new Map<number, string>();
  for (const id of itemIds) {
    const lines: string[] = [];
    for (const p of unique.filter((x) => x.item === id)) {
      // The first line (the item's title) is always kept.
      if (lines.length && lines.join(". ").length + p.text.length + 2 > share) {
        cut = true;
        continue;
      }
      lines.push(p.text);
    }
    itemText.set(id, lines.join(". "));
  }
  const itemsLength = [...itemText.values()].reduce((n, t) => n + t.length + 2, 0);
  // Headings, totals and notices keep at least 30% of the budget however many items there are.
  let left = Math.max(cap * 0.3, cap - itemsLength);
  const out: string[] = [];
  const placed = new Set<number>();
  let dropped = 0;
  for (const p of unique) {
    if (p.item != null) {
      if (placed.has(p.item)) continue;
      placed.add(p.item);
      // Even a very long list stays bounded: past twice the cap the rest of the items are counted, not read.
      if (out.join(". ").length + itemText.get(p.item)!.length > cap * 2) {
        dropped++;
        continue;
      }
      out.push(itemText.get(p.item)!);
    } else if (p.text.length + 2 <= left) {
      out.push(p.text);
      left -= p.text.length + 2;
    } else cut = true;
  }
  if (!out.length) return "";
  const rest = dropped ? ` ${dropped} more item${dropped === 1 ? "" : "s"} on screen.` : cut ? " Some details are only on screen." : "";
  return `Screen summary. ${out.join(". ")}.${rest} Full details and conditions remain on screen. Reading is not approval.`;
}
