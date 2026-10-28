# Simple mode (Bunic Mode)

Simple mode is an optional display preference for the current fictional customer context. Profile → Display and voice controls it. It keeps the existing yellow/black phone bank and the four tabs: Home, Activity, Goals and Agent.

The mode raises body and financial row text to 20px, supporting text to 18px and captions/navigation to 16px. Primary controls reach 56px and icon controls 52px. Account groups and label/value details stack vertically. Amounts can wrap without ellipsis; terms, fees, eligibility, exact selections, confirmations and receipts remain in the existing flows. A short screen guide explains the current location and next step. In Simple mode a suggested Agent question fills the draft; the customer then chooses Send.

## Persistence and isolation

The client reads `preferences.simple_mode` from `GET /api/permissions` and saves a boolean through `POST /api/preferences` with `{ "key": "simple_mode", "value": true }` (or false). Missing values mean off. Strings such as `"true"` do not enable the mode. Storage is the existing authenticated tenant/context preferences table; no schema or browser-storage key is added.

The server allowlists boolean `simple_mode` and rejects ambiguous nonboolean values. Its `Permissions-Policy` permits `microphone=(self)` while keeping camera/geolocation denied. This enables a browser permission request; it does not grant microphone access or start capture.

In-memory identity includes the session identity and customer/tenant/context. Old loads, failed writes and acknowledgements cannot update a later scope. Switching context or signing out clears the display state immediately, stops voice, and waits for an already-sent preference write before changing the server session's context. A failed save restores the previous display value and shows a scoped error; outside Profile, the persistent shell links back to display settings so the customer can retry. A failed load offers retry.

## Optional voice

Enabling Simple mode never speaks or requests microphone access. The optional Read aloud disclosure offers a separate **Read summary aloud** button and **Stop reading**. It reads a bounded summary of rendered headings, balances, account groups, opportunities and key/value details, without reading input values, hidden content or developer output. It keeps whole terms/amounts rather than cutting a node mid-value. The screen retains the complete details; the summary is not an approval. Changing screen content or editing a control stops an existing reading.

Agent offers **Speak a draft** in either display mode. Before starting, the disclosure says that the browser may send audio to its speech service. Final recognition results add plain text to the editable 600-character question draft. They never send a task, choose an action, grant authority or approve anything. Existing typed text is retained. Editing stops the microphone and ignores late results. Voice drafts require an explicit Send; pressing Enter in a voice draft adds a line break. Names, amounts and dates need review. Existing exact financial review/confirmation still applies after a question is sent.

One voice session arbitrates microphone and read-aloud so they do not run together. Stop, permission errors, recognition end, audio errors and synchronous API failures release owned resources. No automatic restart occurs. Route/context/session changes, hidden tabs, page exit and unmount stop audio and abort recognition. Captured callbacks from old sessions cannot alter a new draft. There is no custom voice service, audio recording/storage, API key or dependency.

The implementation uses feature detection, including the prefixed recognition constructor where available. Speech recognition has limited browser support and some browser engines send audio to a service. Read-aloud and speech input each retain clear text/keyboard fallbacks. The API behavior was checked against [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition), [abort](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/abort), [recognition end](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/end_event), [recognition errors](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/error_event), and [SpeechSynthesis](https://developer.mozilla.org/en-US/docs/Web/API/SpeechSynthesis). These are documentation checks, not proof that real audio works in the demo browser.

## Verification and demo

Focused unit tests cover strict preference parsing, scope identity, late loads/writes, failed save rollback, acknowledgement mismatch, pending-write sequencing, draft-only speech, typed-text preservation, permission failures, recognition end, unsupported APIs, Stop, disposal and stale voice callbacks. These test the pure lifecycle boundaries with fake browser speech objects. They do not verify a real microphone or speaker.

After the parent applies the patch and server hooks:

1. Sign into an isolated demo customer. Open Profile, turn on Simple mode and reload. Confirm the value persists for that context.
2. Visit all four tabs at 360px and 390px. Check larger text/targets, account/amount wrapping, complete terms and the existing exact review actions. Return to Profile to turn the mode off.
3. Switch customer/context while preference requests are delayed. Confirm the prior setting/draft never appears in the next scope. Check failed-load/save retry and rollback.
4. On Agent, type a draft, optionally speak additional text, then edit it. Confirm no task appears until Send and no commitment runs without exact review. Test denial/unsupported-browser fallback with keyboard alone.
5. Start reading an available summary, then Stop, navigate, switch context or hide the tab. Confirm audio stops. Repeat for microphone input and check there is no automatic restart.

The combined branch passes 182 unit/integration tests and the build. The four phone tabs were checked at 360px and 390px; an exact review was checked at 360px after correcting its action-bar overflow. Reload persistence, customer/context isolation, failure feedback after navigation and retry through settings were exercised in the browser. Browser speech mocks verified draft-only input, Enter without submission, typed edits rejecting late results, read-aloud and Stop. No real microphone or speaker was used; those need a human device check. Recordings, evidence manifest and long live-model E2E remain postponed.
