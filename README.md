# /demo-video — Claude Code Plugin

Create AI-narrated product demo videos and presentation walkthroughs from your codebase.

## What it does

A Claude Code skill that automates the creation of narrated videos:

- **Screen Recording Mode** — Record a live web app with section highlights, scroll-to-focus, and branded intro/outro
- **Presentation Mode** — Narrate an HTML slide deck with AI voiceover synced to slide transitions

Uses Playwright for screen recording, ElevenLabs for natural AI voiceover, and ffmpeg for composition.

## Install

```bash
/plugin marketplace add morgandoochich/claude-demo-video
/plugin install demo-video@morgandoochich-claude-demo-video
```

## Usage

```
/demo-video [describe what you want to demo]
```

Examples:
```
/demo-video record the sign details page walkthrough
/demo-video create a 60-second presentation introducing our product
/demo-video narrate the existing pitch deck at public/pitch.html
```

## Prerequisites

Before using the skill, ensure these are available:

### System

```bash
brew install ffmpeg
```

### Node packages

```bash
npm install -D @playwright/test @elevenlabs/elevenlabs-js
npx playwright install chromium
```

### Environment

```bash
export ELEVENLABS_API_KEY=your-key-here  # elevenlabs.io/app/settings/api-keys
```

Free tier (10,000 chars/month) is enough for most demo videos.

## How it works

The pipeline runs in strict order:

```
1. VOICEOVER        2. AUTH (optional)    3. RECORD           4. COMPOSE
   ElevenLabs TTS      Playwright           Playwright           ffmpeg
   per-segment clips   storageState         screen/slides        video + audio
   exact timestamps    (screen mode only)   synced to audio      final MP4
```

Each step is independent — re-running any step reuses cached outputs from earlier steps.

### Per-segment chained generation

The key to accurate timing. Instead of generating all narration in one API call (which produces unpredictable segment boundaries), each segment is a separate ElevenLabs call with `previous_text`/`next_text` for voice continuity. This gives:

- **Exact measured duration** per segment (via ffprobe)
- **Exact start/end timestamps** (calculated from measured durations)
- **Controlled silence gaps** (1 second between segments)
- **Consistent voice** across all clips (context chaining)

### Timer-based sync

The recording spec uses `Date.now()` to track elapsed time and `waitUntilVideoTime(targetSec)` to hold until the exact audio timestamp before advancing to the next section. This absorbs all scroll/highlight/navigation overhead automatically — no cumulative drift.

## What the skill generates

When invoked, the skill creates these files in your project:

| File | Purpose |
|------|---------|
| `playwright.config.ts` | Video size, timeout, output directory |
| `playwright/scenes-{name}.mjs` | Narration text and voice configuration |
| `playwright/create-auth-state.mjs` | Pre-authentication script (screen mode) |
| `playwright/record-{name}.spec.ts` | Playwright recording spec |
| `playwright/generate-voiceover.mjs` | ElevenLabs TTS generation |
| `playwright/compose-video.mjs` | ffmpeg video + audio muxing |
| `public/demo-outro.html` | Branded intro/outro screen |

## Built from experience

This skill was built from 33 documented lessons across 11 iterations of a real product demo video pipeline. Key breakthroughs:

- Per-segment chained clips (not single-call) for exact timestamps
- Timer-based absolute timestamps (not hold times) for drift-free sync
- storageState pre-authentication for clean video intros
- `scrollIntoView({ block: 'center' })` for fully visible highlighted cards
- Phonetic brand name spelling for correct TTS pronunciation

## License

MIT
