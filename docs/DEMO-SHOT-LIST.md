# MOBIUS Demo Video — Shot List (≤ 3 minutes)

Target: YouTube, English (or English subtitles), live in Chrome. Total: ~2:45.

| # | Time | Shot | What the viewer sees / hears |
|---|---|---|---|
| 1 | 0:00–0:15 | **Intro** | Title card: "MOBIUS — Your Intelligence. Everywhere. Owned by You." Voiceover: "MOBIUS is a personal AI layer that lives in your browser. On-device first. Cloud only when you allow it." |
| 2 | 0:15–0:35 | **Setup proof** | `chrome://extensions` → MOBIUS loaded unpacked from `dist/`. Side Panel open: Onboarding toggles visible (Read Page ON, DOM Actions ON, Allow Cloud AI OFF). |
| 3 | 0:35–0:55 | **On-device, offline** | Disconnect network (or show the offline indicator). Open a news article, click the bubble, type "Summarize this page". Summary appears with provenance "Gemini Nano on-device". Voiceover: "Short text never leaves the device." |
| 4 | 0:55–1:20 | **Router Log (live audit)** | Side Panel → Router Log tab: the summary decision is listed as ON-DEVICE with reason, latency, and "cloud allowed: no". Voiceover: "Every routing decision is logged — you can audit it live." |
| 5 | 1:20–1:55 | **WhatsApp Web smart reply** | Open `web.whatsapp.com`, open a chat with an incoming message. Bubble → "Reply to the last message". The draft appears in the bubble and is inserted into the message box (send stays with the user). Provenance: "Processed Locally via Gemini Nano". |
| 6 | 1:55–2:25 | **Cloud escalation (opt-in)** | Settings → turn ON "Allow Cloud AI". Ask for a long, complex synthesis (long article). Router Log shows the decision flip to CLOUD with reason "Nano unavailable / long synthesis, cloud allowed". Turn the toggle back OFF. Voiceover: "Borrowed intelligence — only when you say so." |
| 7 | 2:25–2:45 | **Memory + close** | History tab: the task outcome stored locally with TTL; delete one entry live. Closing card: "MOBIUS — Your browser, with a mind of its own — and it stays yours." GitHub link + Apache 2.0. |

## Recording notes

- Record at 1920×1080, Chrome window maximized, bubble visible.
- Keep the Router Log open on a second monitor / second window during shots 3–6 so the audit trail is visible.
- If Gemini Nano is not yet downloaded in the recording Chrome, the local extractive fallback still demonstrates the flow — label it honestly in the voiceover ("on-device model still downloading; local fallback shown").
- Subtitles: English, burned in or YouTube auto-captions reviewed.
