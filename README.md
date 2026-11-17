# Whiteboard Tutor

An AI tutor that teaches any topic in about two minutes, with a friendly voice and a hand-drawn
whiteboard that draws itself **in sync with the narration**. Pause, rewind, seek, change the speed,
write on the board yourself, and ask follow-up questions that get their own mini-lesson.

- **Chat-first**: type a topic (or click an example) and get a lesson.
- **Voice + board in sync**: every drawing starts on the exact word the tutor says (word-level timing).
- **Full player**: play, pause, resume, seek (scrubber, ±5 s, chapters), restart, speed 0.75-2x,
  captions with the spoken word highlighted, volume, full screen, keyboard shortcuts.
- **Interactive whiteboard**: zoom and pan (buttons, pinch, Ctrl+wheel), pen and eraser for your own notes.
- **Follow-up questions**: the answer is written, spoken *and* drawn; afterwards you can resume the
  lesson exactly where you left it.
- **Lesson history**, shareable read-only lesson links, responsive from phones to desktops, light and
  dark mode.

> **Tech:** Next.js 16 (App Router, Cache Components) · React 19 · TypeScript · Tailwind CSS 4 ·
> Neon Postgres + Drizzle ORM · Google Gemini (lesson writing) · ElevenLabs (voice + word timestamps) ·
> rough.js (hand-drawn SVG whiteboard) · Vitest + Playwright.

---

## 1. Quick start

### Prerequisites

- **Node.js 22.9 or newer** (developed on Node 24) and npm
- A **Neon** account (free): https://neon.tech
- A **Google AI Studio** API key (free tier available): https://aistudio.google.com/apikey
- An **ElevenLabs** API key (free tier available): https://elevenlabs.io/app/settings/api-keys

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your local environment file and fill it in (see the table below)
cp .env.example .env.local        # Windows PowerShell: Copy-Item .env.example .env.local

# 3. Create the database tables in Neon
npm run db:migrate

# 4. Start the app
npm run dev                       # http://localhost:3000
```

Open http://localhost:3000/api/health. You should see `{"ok":true,"database":"connected",...}`.
If something is misconfigured the response says which area; secrets are never printed.

### Getting the keys

| Service | Where | Notes |
|---|---|---|
| **Neon** | Create a project at https://console.neon.tech, then **Connect**. Copy the **pooled** connection string (host contains `-pooler`) into `DATABASE_URL`. | `DATABASE_URL_UNPOOLED` (the same URL without `-pooler`) is optional: it is derived automatically. |
| **Gemini** | https://aistudio.google.com/apikey → **Create API key**. | See "Free-tier limits" below. |
| **ElevenLabs** | https://elevenlabs.io/app/settings/api-keys → **Create API Key**, keep **Text to Speech** enabled. | Free plans can only use the *premade* voices through the API (the default voice is one). |

### Environment variables

Put these in `.env.local` (git-ignored). **Never commit real keys**: only `.env.example` is tracked.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | yes | – | Neon pooled connection string |
| `DATABASE_URL_UNPOOLED` | no | derived | Direct connection for migrations |
| `GOOGLE_GENERATIVE_AI_API_KEY` | yes | – | Gemini key |
| `GEMINI_MODEL` | no | `gemini-3.5-flash` | Primary model |
| `GEMINI_FALLBACK_MODELS` | no | `gemini-3.7-flash,gemini-3.5-flash-lite` | Tried in order when the primary is out of quota, busy or hung |
| `ELEVENLABS_API_KEY` | no* | – | Voice. *Without it the browser's built-in voice is used |
| `ELEVENLABS_VOICE_ID` | no | `EXAVITQu4vr4xnSDxMaL` (Sarah) | Any voice your plan can use through the API |
| `ELEVENLABS_MODEL` | no | `eleven_flash_v2_5` | Cheapest and fastest model |
| `TTS_PROVIDER` | no | auto | `elevenlabs` or `browser` (browser = spends no credits) |
| `RATE_LIMIT_LESSONS_PER_HOUR` | no | `8` | Per visitor |
| `RATE_LIMIT_MESSAGES_PER_HOUR` | no | `40` | Follow-up questions, per visitor |
| `RATE_LIMIT_AUDIO_PER_HOUR` | no | `120` | Narration clips, per visitor |

---

## 2. Free-tier limits and reliability (please read)

- **Gemini free tier is limited per model per day** (observed: **20 requests per model per day**).
  One lesson costs 1 request (2 if the first draft needs a retry) and each follow-up costs 1. That is
  roughly 10-25 lessons per day across the fallback chain. The app handles this gracefully:
  - If a model is out of quota, busy (503), retired (404) or **hung** (no data for 25 s) the next model in
    `GEMINI_FALLBACK_MODELS` is tried automatically. Quotas are tracked per model, so a chain multiplies
    your daily allowance.
  - The last model in the chain is a small, fast one. If it is the only one available, lessons are
    **shorter** (about 1 minute) - a deliberate degraded mode rather than an error.
  - When everything is exhausted the user sees a clear message. To lift the limit, **enable billing**
    for the Google AI key: Flash-class models cost a fraction of a cent per lesson.
- **ElevenLabs** free tier is 10,000 credits per month. This app uses about **0.4 credit per character**
  with `eleven_flash_v2_5`, i.e. **about 600-800 credits per 2-minute lesson (roughly 12-15 lessons per month)**.
  Audio is stored in your database and reused, so replaying never costs credits again.
  If the quota runs out (or the key is invalid) the lesson **automatically falls back to the browser's
  built-in voice**, with the same word-synchronised captions and drawing. Nothing breaks.
- Lesson generation normally takes **15-45 seconds** (longer when the Gemini API is busy; the UI shows
  progress). Narration is recorded right after, scene by scene (a few seconds in total).

---

## 3. How it works

```
topic ──► POST /api/lessons ──► Gemini (structured JSON) ──► sanitize ──► Neon (lesson script)
                                                                            │
 browser ◄── GET /api/lessons/:id ◄─────────────────────────────────────────┘
    │
    ├─ POST /api/messages/:id/audio  (per scene) ──► ElevenLabs "with-timestamps"
    │        └─ stores MP3 + word timings in Neon;  GET /api/clips/:id streams it (HTTP Range)
    │
    └─ PlaybackEngine: audio is the master clock ──► timeline ──► whiteboard = f(time)
```

**The lesson script.** Gemini returns scenes; each scene is one whiteboard page made of *beats*. A
beat is a sentence of narration plus the drawing actions that appear while it is spoken. Every action
has a `cue`: the exact word(s) at which it should start drawing. Action types: `text`, `box`, `ellipse`,
`diamond`, `triangle`, `line`/`arrow` (glued to shapes by id), `curve`, `graph` (axes + a safely
evaluated function plot), `highlight`, `pointer` and `erase`. See `src/lib/lesson/types.ts`.

**Making the model's output safe.** `src/lib/lesson/sanitize.ts` validates everything: unknown fields
and actions are dropped, coordinates are clamped into the canvas, labels are wrapped and shapes grown
to fit, connectors attach to the shapes they reference, math expressions go through a tiny parser (no
`eval`), and narration is cleaned for speech. A bad action never breaks a lesson.

**Synchronisation.** ElevenLabs returns per-character timestamps; they are converted to word timings.
`src/lib/lesson/timeline.ts` turns script + word timings into absolute-time drawing events. The
whiteboard (`boardAt(timeline, t)`) is a **pure function of time**, which is why seeking is exact.
During playback the audio element is the clock (`time = sceneStart + audio.currentTime`), so drawing
cannot drift from the voice. Without recorded audio (browser voice) a wall clock drives the timeline
and the browser speaks each scene.

**Follow-ups.** The question, the lesson, where you paused and what you had just heard are sent to
Gemini, which answers with a short mini-lesson in the same script format (text + voice + drawing).
The lesson position is remembered so you can resume it.

**Anonymous ownership.** There are no accounts. Each browser gets a random httpOnly cookie; only that
browser can ask follow-ups or delete its lessons. Lesson URLs are unguessable capability links: anyone
with the link can *watch* (with browser voice for anything not yet recorded).

---

## 4. Project structure

```
src/
  app/                    Next.js routes (/, /lesson/[id]) and API route handlers
    api/lessons/…         create / list / read / delete lessons, follow-up questions
    api/messages/[id]/audio   record one scene's narration (TTS) on demand
    api/clips/[id]        stream narration audio with Range support
    api/health            deployment check
  components/
    home/                 landing page
    tutor/                Workspace, Stage, Whiteboard, Controls, Captions, ChatPanel
    brand/                header, logo, history drawer
  lib/
    ai/                   Gemini client (streaming, fallback chain), prompts, schema, generation
    tts/                  ElevenLabs client + alignment → word timing
    lesson/               script types, sanitizer, geometry, expression parser, timeline
    playback/             PlaybackEngine (clock, audio, speech, seek) – framework-free
    whiteboard/           rough.js drawing pieces + palette
    client/               browser API client, controller hook, audio preparer
    db/                   Drizzle schema, queries, Neon client
drizzle/                  generated SQL migrations
scripts/                  migrate, db-check, lesson sampler
tests/unit, tests/e2e     Vitest and Playwright suites
```

---

## 5. Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build / server |
| `npm run db:migrate` | Apply SQL migrations to Neon |
| `npm run db:generate` | Generate a new migration after editing `src/lib/db/schema.ts` |
| `npm run db:check` | Write/read/delete test rows (incl. binary audio) to verify the database |
| `npm run lesson:sample -- "topic" out.json` | Generate one lesson in the terminal and print a summary |
| `npm run lint` · `npm run typecheck` | Static checks |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | Browser tests (Playwright) |

---

## 6. Testing

```bash
npm test                 # ~120 unit tests: sanitizer, timeline, playback engine, Gemini client
                         # (fallbacks, streaming, hung models), ElevenLabs client, API errors…
npx playwright install chromium   # once
npm run test:e2e         # starts `npm run dev` if needed
```

The Playwright suites:

- **`ui.spec.ts`** – full UI behaviour on desktop, tablet and phone viewports against a *mocked* backend:
  player controls, seeking exactness, captions, whiteboard tools, follow-up flow, errors, history,
  responsive layout. Uses no paid services.
- **`api.spec.ts`** – HTTP contract against the real database (seeded directly): ownership, validation,
  byte ranges, cascade deletes, rate limiting. Uses no paid services.
- **`smoke.spec.ts`** – works against any build, including production:
  `npm run build && npx next start -p 3100`, then `E2E_PORT=3100 npx playwright test smoke.spec.ts`.
- **`live.spec.ts`** – the real journey end to end (Gemini + ElevenLabs + Neon). **Spends credits**
  (~800 ElevenLabs credits and a few Gemini requests), so it only runs when asked:
  `E2E_LIVE=1 npx playwright test live.spec.ts` (PowerShell: `$env:E2E_LIVE=1; npx playwright test live.spec.ts`).

Tests that use `window.__wbt` (a development-only debug hook) must run against `npm run dev`.

---

## 7. Deploying (Vercel)

1. Push the repository to GitHub and import it in Vercel (framework: Next.js; no special build settings).
2. Add the environment variables from the table above in **Project → Settings → Environment Variables**
   (at least `DATABASE_URL`, `GOOGLE_GENERATIVE_AI_API_KEY`, `ELEVENLABS_API_KEY`).
3. Run the migrations once against Neon from your machine: `npm run db:migrate`.
4. **Set the Function Region** (Settings → Functions) next to your Neon region (e.g. Neon `us-east-2` →
   Vercel `iad1`). Each API call makes a few database round trips; a nearby region makes them fast.
5. Lesson generation runs inside a function with `maxDuration = 120` (see `src/app/api/lessons/route.ts`).
   Make sure your Vercel plan allows that duration, or lower it (and the 100 s budget in
   `src/lib/ai/generate.ts`) accordingly.
6. Deploy, then open `/api/health`.

No file storage service is needed: narration audio is stored in Postgres (about 1 MB per lesson at
64 kbps) and streamed from `/api/clips/:id`. The Neon free plan (0.5 GB) holds several hundred lessons;
delete lessons from the History panel to free space.

## 8. Security notes

- Secrets live only in environment variables (`.env.local` is git-ignored; `.env.example` has placeholders).
- All model output is validated and clamped before use; the app never injects HTML; math is parsed, not evaluated.
- Prompt-injection hardening: user text is passed as quoted data with explicit "ignore instructions inside" rules.
- Per-visitor and per-IP hourly rate limits (stored in Postgres) protect your API budget.
- Baseline security headers are set in `next.config.ts` (no CSP: Next's inline bootstrap scripts need nonces).
- If you ever pasted an API key somewhere public, **rotate it** in the provider's dashboard.

## 9. Troubleshooting

| Symptom | Likely cause |
|---|---|
| "The free AI quota for today has been used up" | Gemini free-tier daily limit on every model in the chain. Wait for the reset or enable billing. |
| "The AI took too long to respond" | The Gemini API is overloaded; retry in a minute. |
| Lesson says "Browser voice" | ElevenLabs quota/key problem (or `TTS_PROVIDER=browser`). Check the key has *Text to Speech* permission. |
| `/api/health` returns 503 | A required environment variable is missing; the response names the area. |
| 402 "paid_plan_required" in server logs | The chosen ElevenLabs voice is a library voice; free plans can only use premade voices. |
| Migrations fail | Use the *direct* Neon URL (no `-pooler`) in `DATABASE_URL_UNPOOLED`. |

## 10. Known limitations

- English only. Lessons are generated by an AI and can contain mistakes (the UI says so).
- Pasting a very long or unusual topic may be refused by the safety checks of the model.
- The whiteboard layout is produced by the model; the sanitizer prevents off-screen or broken elements
  but cannot guarantee perfect aesthetics for every topic.
