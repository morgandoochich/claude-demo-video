---
name: demo-video
description: Create a narrated video with AI voiceover. Two modes — (1) Screen Recording: record a web app page with section highlights and narration, or (2) Presentation: narrate an existing HTML slide deck. Uses Playwright for recording, ElevenLabs for voiceover, and ffmpeg for composition. Invoke when the user wants to record a product demo, walkthrough video, feature showcase, or narrated presentation.
argument-hint: [page/presentation description]
---

# Demo Video Pipeline

Create narrated videos with AI voiceover. Supports two modes:

| Mode | Use when | Recording method |
|---|---|---|
| **Screen Recording** | Demoing a live web app page | Playwright navigates the app, highlights sections, scrolls through features |
| **Presentation** | Narrating an existing HTML slide deck | Playwright opens the HTML file, advances slides synced to voiceover timestamps |

Both modes share the same voiceover generation (ElevenLabs per-segment chained), composition (ffmpeg), and timing infrastructure (timer-based absolute timestamps).

## First: Determine the Mode

Ask the user: **"Are we recording a live app page, or narrating a presentation/slide deck?"**

Then follow the relevant section below. The voiceover generation (Step 3) and composition (Steps 6-7) are identical for both modes.

## Overview

The pipeline has 4 steps run in strict order:

```
1. VOICEOVER → 2. AUTH → 3. RECORD → 4. COMPOSE
```

Each step is independent — re-running any step reuses cached outputs from earlier steps.

## Prerequisites Check

Before starting, verify these are available:

```bash
# System
which ffmpeg    # brew install ffmpeg

# Node packages (install if missing)
npm ls @playwright/test @elevenlabs/elevenlabs-js 2>/dev/null
# If missing: npm install -D @playwright/test @elevenlabs/elevenlabs-js && npx playwright install chromium

# Environment
echo $ELEVENLABS_API_KEY  # must be set
```

## Step-by-Step Execution

### Step 1: Gather Requirements

Ask the user for:
1. **Which page/feature to demo** — URL path and what sections to highlight
2. **What each section should say** — or generate narration from the page content
3. **Voice preference** — search ElevenLabs library if needed
4. **Auth flow** — how to log in to the app
5. **Branding** — ask the user to either:

   **Option A: Point to existing brand docs.** Ask if there's a brand guidelines file, style guide, design tokens file, or tailwind config in the project. Common locations:
   - `CLAUDE.md`, `README.md`, `design.md`, `brand.md`
   - `tailwind.config.ts` (look for `colors.primary`, `colors.brand`, custom theme)
   - `src/styles/globals.css` or CSS variables (`:root { --primary: ... }`)
   - `public/` directory for logo files (SVG, PNG)
   - `package.json` name/description for product name
   - Any existing marketing pages (`src/app/(marketing)/page.tsx`, `public/index.html`)

   Read the referenced files and extract: brand colours, logo path, product name, tagline, URL, and font. Fill in any gaps by asking the user directly.

   **Option B: Provide details directly:**
   - Primary brand colour hex (used for section highlight outlines)
   - Secondary/gradient colour hex (used for intro/outro background)
   - Logo file path (SVG or PNG in the project's public/ directory)
   - Product tagline or strapline
   - Product URL (as displayed — e.g. "yourproduct.com")
   - CTA text (e.g. "Get in touch", "Start your free trial", "Book a demo")
   - Font preference if not system default (Google Font name or local font file)
   - Whether logo needs to be inverted for dark backgrounds

### Step 2: Create Files

Create these files in the project. Adapt the templates below to the user's app.

#### playwright.config.ts

```ts
import { defineConfig } from '@playwright/test'

export default defineConfig({
  timeout: 300000,
  use: {
    baseURL: 'http://localhost:3000', // ADAPT: app URL
    video: { mode: 'on', size: { width: 1280, height: 720 } },
    screenshot: 'on',
    trace: 'on',
    viewport: { width: 1280, height: 720 },
  },
  outputDir: './playwright-results',
  testDir: './playwright',
})
```

**Resolution note:** `viewport` alone does NOT set video resolution — Playwright downscales to ~800x450. The explicit `video.size` is required.

**Timeout note:** Must exceed total video duration + auth + navigation time. 300s is safe for videos up to 3 minutes.

#### playwright/scenes-{name}.mjs

```js
// ADAPT: voice ID, provider, segment text
const DEFAULT_VOICE = 'elevenlabs-voice-id'
const TTS_PROVIDER = 'elevenlabs'

export const scenes = [
  {
    id: 'feature-name',
    videoDir: 'record-feature-Test-Name', // matches Playwright test output dir
    perSegmentChained: true,              // ALWAYS use this — gives exact timestamps
    ttsProvider: TTS_PROVIDER,
    voice: DEFAULT_VOICE,
    segments: [
      // SCREEN RECORDING MODE: 1-2 sentences per section (~5-10s speech)
      { id: 'intro', text: 'Welcome to Your Product. Let me show you...' },
      { id: 'section-1', text: 'Description of first feature shown on screen.' },
      { id: 'outro', text: 'Visit your product dot com to learn more.' },

      // PRESENTATION MODE: 2-4 sentences per slide (~15-30s speech)
      // { id: 'slide-intro', text: 'Today I want to walk you through our platform...' },
      // { id: 'slide-problem', text: 'The challenge many teams face is...' },
      // { id: 'slide-outro', text: 'If you would like to learn more...' },
    ],
  },
]
```

**Critical rules for narration text:**
- `perSegmentChained: true` — generates one clip per segment with exact measured timestamps. Never use `singleCall` — silence detection for splitting is unreliable.
- `voice` must be on the **scene object**, not individual segments
- Spell brand names phonetically if TTS mispronounces them (e.g. "MyApp" → "My App")
- Never use `[pause]` markers — ElevenLabs reads them aloud as literal text
- Use "dot com" not ".com" for URLs in speech

#### playwright/create-auth-state.mjs (screen recording mode only)

```js
import { chromium } from 'playwright'

const AUTH_STATE_PATH = 'playwright/voiceover-cache/.auth-state.json'

async function main() {
  const browser = await chromium.launch({ headless: true })
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  // ADAPT: login flow for the target app
  await page.goto('http://localhost:3000/login')
  await page.fill('input[name="email"]', 'user@example.com')
  await page.fill('input[name="password"]', 'password')
  await page.click('button:has-text("Log in")')
  await page.waitForURL('**/dashboard**', { timeout: 20000 })

  await ctx.storageState({ path: AUTH_STATE_PATH })
  await ctx.close()
  await browser.close()
  console.log(`Auth state saved to ${AUTH_STATE_PATH}`)
}

main().catch(console.error)
```

**Why separate script:** `test.use({ storageState })` evaluates at module load time — before `beforeAll`. The file must already exist when the test starts.

#### public/demo-outro.html

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <!-- ADAPT: uncomment if using a Google Font -->
  <!-- <link href="https://fonts.googleapis.com/css2?family=FONT_NAME:wght@300;400;600&display=swap" rel="stylesheet"> -->
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      width: 1280px; height: 720px;
      /* ADAPT: brand gradient — primary and secondary colours */
      background: linear-gradient(135deg, BRAND_COLOUR_HEX 0%, BRAND_COLOUR_ALT_HEX 50%, BRAND_COLOUR_HEX 100%);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      /* ADAPT: font-family if brand uses a custom font */
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      color: white;
    }
    .logo {
      width: 280px;
      margin-bottom: 32px;
      /* ADAPT: remove this filter if logo is already white/light */
      filter: brightness(0) invert(1);
    }
    .tagline { font-size: 28px; font-weight: 300; opacity: 0.9; margin-bottom: 16px; }
    .url { font-size: 36px; font-weight: 600; letter-spacing: 1px; }
    .cta { margin-top: 40px; font-size: 20px; opacity: 0.8; font-weight: 300; }
  </style>
</head>
<body>
  <!-- ADAPT: all values below from brand guidelines -->
  <img src="/LOGO_FILENAME" alt="PRODUCT_NAME" class="logo">
  <p class="tagline">PRODUCT_TAGLINE</p>
  <p class="url">PRODUCT_URL</p>
  <p class="cta">CTA_TEXT</p>
</body>
</html>
```

**Why static HTML:** App pages (marketing homepage, login) need JS hydration and may show skeleton/loading states. Static HTML renders instantly — no blank frames.

**Adapt checklist for the branded screen:**
- Replace `BRAND_COLOUR_HEX` and `BRAND_COLOUR_ALT_HEX` with brand gradient colours
- Replace `LOGO_FILENAME` with the logo file in `public/` (e.g. `logo.svg`)
- Remove `filter: brightness(0) invert(1)` if the logo is already white/light-coloured
- Replace `PRODUCT_NAME`, `PRODUCT_TAGLINE`, `PRODUCT_URL`, `CTA_TEXT`
- Uncomment and set the Google Font link if the brand uses a custom font
- Adjust `.logo` width if the logo aspect ratio needs more/less space

#### playwright/record-{name}.spec.ts

The recording spec uses **absolute timestamps** via a timer to sync video with audio. This absorbs all scroll/highlight/navigation overhead automatically.

```ts
import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'fs'
import { join } from 'path'

const AUTH_STATE_PATH = 'playwright/voiceover-cache/.auth-state.json'

// Load exact timestamps from voiceover generation
const timestamps = JSON.parse(
  readFileSync(join('playwright', 'voiceover-cache', '{name}-timestamps.json'), 'utf-8')
)

function getAudioStart(id: string): number {
  return timestamps.find((t: any) => t.id === id)?.startSec ?? 0
}
function getAudioEnd(id: string): number {
  return timestamps.find((t: any) => t.id === id)?.endSec ?? 0
}

// TIMER-BASED SYNC — the key to accurate timing
// Records when the "real" video starts, then waits until exact audio timestamps
let videoStartMs = 0
async function waitUntilVideoTime(page: Page, targetSec: number) {
  const remaining = targetSec * 1000 - (Date.now() - videoStartMs)
  if (remaining > 100) await page.waitForTimeout(remaining)
}

// HIGHLIGHT — finds heading text, walks up to card container, outlines it
async function highlightSection(page: Page, headingText: string) {
  await page.evaluate(() => {
    document.querySelectorAll('[data-demo-hl]').forEach((el) => {
      ;(el as HTMLElement).style.outline = 'none'
      el.removeAttribute('data-demo-hl')
    })
  })

  const heading = page.getByText(headingText, { exact: false }).first()
  if (!await heading.isVisible({ timeout: 1500 }).catch(() => false)) {
    await page.evaluate(() => window.scrollBy(0, 400))
    if (!await heading.isVisible({ timeout: 1000 }).catch(() => false)) return
  }

  await heading.evaluate((node) => {
    let el = node as HTMLElement
    for (let i = 0; i < 6; i++) {
      el = el?.parentElement as HTMLElement
      if (!el) break
      const style = getComputedStyle(el)
      if (style.borderRadius && parseFloat(style.borderRadius) > 0 && el.tagName === 'DIV') {
        el.scrollIntoView({ block: 'center' })
        el.style.outline = '3px solid BRAND_COLOUR_HEX' // ADAPT: brand colour
        el.style.outlineOffset = '4px'
        el.style.transition = 'outline 0.3s ease'
        el.setAttribute('data-demo-hl', '1')
        // Ensure full card visible
        const rect = el.getBoundingClientRect()
        if (rect.bottom > window.innerHeight - 20) {
          window.scrollBy(0, rect.bottom - window.innerHeight + 40)
        }
        break
      }
    }
  })

  await page.waitForTimeout(300)
  const box = await heading.boundingBox()
  if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

// ADAPT: sections to highlight — id must match scenes segment id
const SECTIONS = [
  { id: 'section-1', heading: 'Section Title' },
  { id: 'section-2', heading: 'Another Title' },
  { id: 'page-header', heading: 'Page Title', noHighlight: true },
  // noHighlight: skip DOM walk-up for elements without a card ancestor (e.g. h1)
]

test.use({ storageState: AUTH_STATE_PATH })

test('Feature Walkthrough', async ({ page }) => {
  // ADAPT: if the target page is slow, pre-warm it before starting the timeline
  // await page.goto('/your/slow/page')
  // await page.waitForLoadState('networkidle') // or domcontentloaded for WebSocket apps
  // const prewarmDone = Date.now()

  // INTRO
  await page.goto('/demo-outro.html')
  await page.waitForLoadState('load')
  await page.waitForTimeout(300)
  videoStartMs = Date.now()

  // Wait for intro audio to finish
  await waitUntilVideoTime(page, getAudioStart(SECTIONS[0].id) - 1)

  // Navigate to target page
  await page.goto('/your/page') // ADAPT
  await page.waitForLoadState('networkidle')
  await expect(page.locator('text="Expected Element"')).toBeVisible({ timeout: 10000 })

  // Walk through sections at exact audio timestamps
  for (const section of SECTIONS) {
    await waitUntilVideoTime(page, getAudioStart(section.id))
    if (!('noHighlight' in section)) {
      await highlightSection(page, section.heading)
    }
    await waitUntilVideoTime(page, getAudioEnd(section.id))
  }

  // OUTRO
  await waitUntilVideoTime(page, getAudioStart('outro'))
  await page.goto('/demo-outro.html')
  await page.waitForTimeout(200)
  await waitUntilVideoTime(page, getAudioEnd('outro') + 2)
})
```

#### Presentation Mode: Recording Spec

For presentation mode, the Playwright spec opens an HTML slide deck via `file://` and advances slides synced to voiceover timestamps. No server needed.

```ts
// playwright/record-{name}.spec.ts (PRESENTATION MODE)
import { test, type Page } from '@playwright/test'
import { readFileSync } from 'fs'
import { join, resolve } from 'path'

const timestampsPath = join('playwright', 'voiceover-cache', '{name}-timestamps.json')
const timestamps = JSON.parse(readFileSync(timestampsPath, 'utf-8'))

function getAudioStart(id: string): number {
  return timestamps.find((t: any) => t.id === id)?.startSec ?? 0
}
function getAudioEnd(id: string): number {
  return timestamps.find((t: any) => t.id === id)?.endSec ?? 0
}

let videoStartMs = 0
async function waitUntilVideoTime(page: Page, targetSec: number) {
  const remaining = targetSec * 1000 - (Date.now() - videoStartMs)
  if (remaining > 100) await page.waitForTimeout(remaining)
}

// ADAPT: one entry per slide, id must match scenes segment id
const SLIDES = [
  { id: 'slide-intro', index: 0 },
  { id: 'slide-problem', index: 1 },
  { id: 'slide-solution', index: 2 },
  // ...
  { id: 'slide-outro', index: -1 }, // -1 = last slide, no advance
]

test('Presentation Narration', async ({ page }) => {
  // Set timeout to just above audio duration — prevents Playwright from recording
  // blank frames for the full global timeout (e.g. 300s of nothing after a 60s video)
  const lastSegment = timestamps[timestamps.length - 1]
  test.setTimeout((lastSegment.endSec + 15) * 1000)

  // ADAPT: path to the HTML presentation file
  const htmlPath = resolve('presentation/video.html')
  await page.goto(`file://${htmlPath}`)
  await page.waitForLoadState('load')
  await page.waitForTimeout(500)

  // Save trim offset (pre-warm frames to trim from final video)
  const fs = await import('fs')
  const trimPath = join('playwright', 'voiceover-cache', '{name}-trim.txt')

  videoStartMs = Date.now()

  for (const slide of SLIDES) {
    await waitUntilVideoTime(page, getAudioStart(slide.id))

    if (slide.index >= 0) {
      // Advance to this slide — direct DOM manipulation for instant transitions
      // ADAPT: this depends on your presentation's HTML structure
      await page.evaluate((idx) => {
        // Hide all slides, show the target
        document.querySelectorAll('[data-slide]').forEach((el, i) => {
          ;(el as HTMLElement).style.display = i === idx ? 'flex' : 'none'
        })
        // Update nav indicators if present
        const counter = document.querySelector('.slide-counter')
        if (counter) counter.textContent = `${idx + 1}`
      }, slide.index)
    }

    await waitUntilVideoTime(page, getAudioEnd(slide.id))
  }

  // Hold final slide for 3 extra seconds
  await page.waitForTimeout(3000)

  // Save the video explicitly (required for Playwright to retain it)
  const video = page.video()
  if (video) {
    await video.saveAs(join('playwright-results', '{name}-recording.webm'))
  }
})
```

**Key differences from screen recording mode:**
- Opens HTML via `file://` — no server or auth needed
- Advances slides via `page.evaluate()` DOM manipulation — instant transitions, no animation
- No section highlights — the full slide is the visual
- No scrolling — each slide fills the viewport
- Must call `page.video().saveAs()` explicitly — without this, Playwright doesn't retain the video for passing tests
- Nav bar/progress indicators must be updated manually in `page.evaluate()` since direct DOM changes don't trigger the presentation's JS event handlers
- Timeout must exceed total audio duration (a 10-minute presentation needs `timeout: 900000`)

**Presentation narration guidelines (vs screen recording):**
- Segments are longer: 2-4 sentences (~15-30s) per slide vs 1-2 sentences per section
- The intro should preview what the presentation covers
- The outro should close on next steps / CTA
- Match segment count to slide count (one segment per slide)

### Step 3: Generate Voiceover

```bash
node playwright/generate-voiceover.mjs --scenes playwright/scenes-{name}.mjs --force
```

This generates one clip per segment, measures exact durations, concatenates with 1s silence gaps, and writes timestamps JSON. Clips are cached — re-run skips existing clips unless `--force` is used.

If rate-limited (429), just re-run — cached clips are skipped.

### Step 4: Create Auth State (screen recording mode only)

```bash
node playwright/create-auth-state.mjs
```

Run this **immediately before** recording — sessions may expire.

Skip this step for presentation mode — no auth is needed (HTML opens via `file://`).

### Step 5: Record

```bash
npx playwright test playwright/record-{name}.spec.ts
```

### Step 6: Find Trim Point and Compose

```bash
# Extract frames to find where branded intro appears
for t in 0 1 2 3; do
  ffmpeg -y -ss $t -i playwright-results/.../video.webm -vframes 1 /tmp/frame_${t}s.jpg
done

# Compose (TRIM = seconds to skip login/pre-warm frames)
ffmpeg -y -ss <TRIM> \
  -i playwright-results/.../video.webm \
  -i playwright/voiceover-cache/{name}-voiceover.mp3 \
  -c:v libx264 -preset fast -crf 23 -c:a aac \
  -map 0:v:0 -map 1:a:0 -shortest \
  output.mp4
```

**Why re-encode:** Playwright outputs VP8/WebM which can't be stream-copied into MP4. Must use `-c:v libx264`.

### Step 7: Verify

```bash
# Extract frames at key audio timestamps to verify sync
for t in 0 10 30 60 90; do
  ffmpeg -y -ss $t -i output.mp4 -vframes 1 /tmp/check_${t}s.jpg
done
```

### Step 8: Add to .gitignore

```
playwright-results/
playwright/voiceover-cache/
public/demo-outro.html
```

## Platform-Specific Adaptations

### Apps with persistent WebSockets (Salesforce, Supabase Realtime, etc.)
- Never use `page.waitForLoadState('networkidle')` — it hangs forever
- Use `domcontentloaded` + explicit element visibility waits instead

### Apps with slow initial page loads
- **Pre-warm**: Navigate to the target page before starting the video timeline
- Save the pre-warm duration and use it as the ffmpeg trim offset
- Add extra wait time (5-10s) after full page navigations

### Apps with tabbed interfaces
- Click tabs 2s before the segment audio starts (lead time) so content is loaded when narration begins
- For nested tabs, click parent first: `relatedTab: ['Parent', 'Child']`

### Apps with Shadow DOM (Salesforce Lightning, Web Components)
- `page.getByText()` auto-pierces shadow DOM — use for finding elements
- `page.evaluate()` does NOT pierce shadow DOM — use floating `<div>` overlays positioned via `boundingBox()` instead of styling shadow elements directly

### Apps requiring database lookups for navigation
- Query the database directly from the test (REST API, Supabase client, etc.) to get record IDs
- Navigate via `page.goto(url)` rather than clicking table rows — `onClick={() => router.push()}` handlers are not reliably clickable by Playwright

## Finding a Voice

```js
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'
const client = new ElevenLabsClient()
const results = await client.voices.getShared({
  gender: 'female',     // or 'male'
  accent: 'australian',  // or 'british', 'american', etc.
  language: 'en',
  pageSize: 10,
})
// Preview at elevenlabs.io/voice-library, then use voiceId in scenes file
```

## Quality Checklist

Before sharing the video, verify:

**Both modes:**
- [ ] Voiceover matches what's on screen at each timestamp
- [ ] Voice consistent throughout all segments
- [ ] No dead silence at the end
- [ ] Resolution is correct (1280x720 or 1920x1080)
- [ ] Brand names pronounced correctly
- [ ] Branded intro and outro appear at correct times

**Screen recording mode:**
- [ ] Every frame shows the expected page/section
- [ ] No login/auth/loading screens visible
- [ ] Highlights visible around each discussed section
- [ ] Highlighted cards fully visible (not clipped at viewport edge)

**Presentation mode:**
- [ ] Correct slide visible for each voiceover segment
- [ ] Nav bar/counter shows correct slide number
- [ ] No blank frames during slide transitions
- [ ] Final slide holds for a few seconds after narration ends

## Creating an HTML Presentation

If the user needs a presentation created (not just narrated), gather requirements and build it as an HTML slide deck.

### Requirements to Ask For

1. **Content source** — existing content to base slides on:
   - A document, brief, or outline (PDF, Google Doc, Markdown)
   - Bullet points or raw notes
   - "Generate from this topic" (Claude writes the content)

2. **Presentation type** — determines template and style:
   | Type | Best for | Nav style | Slides |
   |---|---|---|---|
   | Product demo | Feature walkthroughs, customer-facing | Progress bar + counter | 15-50 |
   | Pitch deck | Investors, stakeholders | Minimal or print/PDF | 10-20 |
   | Strategic/technical | Internal teams, analysis | Dark theme + full nav | 20-40 |
   | Executive brief | C-suite, board | Password-gated + dots | 15-30 |

3. **Visual style:**
   - Light or dark theme
   - Brand colours (primary, accent, status colours) — or point to brand docs (see branding section above)
   - Logo file path
   - Font preference

4. **Content elements needed:**
   - App screenshots (provide URLs/pages to screenshot, or existing image paths)
   - Device mockups — browser frame, phone frame, or both
   - Data tables, metric cards, charts
   - Architecture/flow diagrams
   - Icons (emoji, Lucide, or custom SVG)

5. **Delivery format:**
   - Interactive (HTML with keyboard/touch nav) — for presenting live
   - Video-optimised (HTML without password gate, instant transitions) — for recording with voiceover
   - Print/PDF (static, no JS) — for emailing or printing
   - All of the above (create both `index.html` and `video.html` versions)

6. **Navigation preferences:**
   - Progress bar (top or bottom)
   - Slide counter (e.g. "3 / 19")
   - Dot indicators for direct slide jumping
   - Keyboard + touch/swipe support
   - Password gate (if confidential)

### HTML Presentation Template

Use a single HTML file with inline CSS and JS. The standard architecture:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=1920, initial-scale=1">
  <title>PRESENTATION_TITLE</title>
  <style>
    /* ── Reset + Base ── */
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      /* ADAPT: light theme (#ffffff) or dark theme (#0a0a0b) */
      background: var(--bg);
      color: var(--text);
      overflow: hidden;
    }

    /* ── Colour System (ADAPT to brand) ── */
    :root {
      --bg: #ffffff;
      --surface: #f8f8fa;
      --surface-2: #f0f0f4;
      --border: #e2e2e8;
      --text: #1a1a2e;
      --text-muted: #6b6b80;
      --accent: BRAND_COLOUR_HEX;
      --accent-light: BRAND_COLOUR_LIGHT_HEX;
      --green: #22c55e;
      --amber: #f59e0b;
      --red: #ef4444;
    }

    /* ── Slide Container ── */
    .deck { position: relative; width: 100vw; height: 100vh; }

    .slide {
      position: absolute;
      inset: 0;
      display: none;
      flex-direction: column;
      justify-content: center;
      padding: 60px 80px;
      opacity: 0;
      transform: translateX(40px);
      transition: opacity 0.45s ease, transform 0.45s ease;
    }
    .slide.active {
      display: flex;
      opacity: 1;
      transform: translateX(0);
    }

    /* ── Navigation ── */
    .nav-bar {
      position: fixed; bottom: 0; left: 0; right: 0;
      height: 48px;
      background: var(--surface);
      border-top: 1px solid var(--border);
      display: flex; align-items: center; justify-content: center; gap: 16px;
      z-index: 100;
    }
    .progress {
      position: fixed; top: 0; left: 0;
      height: 3px;
      background: var(--accent);
      transition: width 0.4s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 100;
    }
    .counter { font-size: 13px; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .nav-btn {
      width: 36px; height: 36px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--surface);
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
    }
    .nav-btn:hover { background: var(--surface-2); }

    /* ── Reusable Components ── */

    /* Cards */
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
    }
    .card-grid { display: grid; gap: 20px; }
    .card-grid.two-col { grid-template-columns: 1fr 1fr; }
    .card-grid.three-col { grid-template-columns: 1fr 1fr 1fr; }

    /* Split layout (text + image) */
    .split { display: flex; gap: 60px; align-items: center; }
    .split > * { flex: 1; }

    /* Tags */
    .tag {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      background: var(--accent-light);
      color: var(--accent);
    }

    /* Callout */
    .callout {
      border-left: 3px solid var(--accent);
      background: var(--surface);
      padding: 16px 20px;
      border-radius: 0 8px 8px 0;
    }

    /* Browser mockup */
    .browser-frame {
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }
    .browser-titlebar {
      display: flex; align-items: center; gap: 6px;
      padding: 10px 14px;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
    }
    .browser-dot { width: 10px; height: 10px; border-radius: 50%; }
    .browser-frame img { width: 100%; display: block; }

    /* Gradient slides (title/section dividers) */
    .slide-gradient {
      background: linear-gradient(135deg, BRAND_COLOUR_HEX, BRAND_COLOUR_ALT_HEX);
      color: white;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="progress" id="progress"></div>
  <div class="deck">

    <!-- SLIDE 1: Title -->
    <div class="slide slide-gradient active" data-slide="0">
      <h1 style="font-size: 48px;">Presentation Title</h1>
      <p style="font-size: 24px; opacity: 0.8; margin-top: 16px;">Subtitle or date</p>
    </div>

    <!-- SLIDE 2: Content -->
    <div class="slide" data-slide="1">
      <h2>Section Title</h2>
      <div class="card-grid two-col" style="margin-top: 32px;">
        <div class="card">
          <h3>Card Title</h3>
          <p style="color: var(--text-muted);">Card content here.</p>
        </div>
        <div class="card">
          <h3>Card Title</h3>
          <p style="color: var(--text-muted);">Card content here.</p>
        </div>
      </div>
    </div>

    <!-- Add more slides... -->

  </div>

  <!-- Navigation -->
  <div class="nav-bar">
    <button class="nav-btn" id="prev">←</button>
    <span class="counter" id="counter">1 / 2</span>
    <button class="nav-btn" id="next">→</button>
  </div>

  <script>
    const slides = document.querySelectorAll('.slide')
    let current = 0

    function showSlide(n) {
      slides[current].classList.remove('active')
      current = Math.max(0, Math.min(n, slides.length - 1))
      slides[current].classList.add('active')
      updateUI()
    }

    function updateUI() {
      document.getElementById('progress').style.width =
        (current / (slides.length - 1)) * 100 + '%'
      document.getElementById('counter').textContent =
        (current + 1) + ' / ' + slides.length
    }

    document.getElementById('next').onclick = () => showSlide(current + 1)
    document.getElementById('prev').onclick = () => showSlide(current - 1)

    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') showSlide(current + 1)
      if (e.key === 'ArrowLeft' || e.key === 'Backspace') showSlide(current - 1)
      if (e.key === 'Home') showSlide(0)
      if (e.key === 'End') showSlide(slides.length - 1)
    })

    // Touch/swipe
    let touchStartX = 0
    document.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX })
    document.addEventListener('touchend', (e) => {
      const diff = touchStartX - e.changedTouches[0].clientX
      if (Math.abs(diff) > 50) showSlide(current + (diff > 0 ? 1 : -1))
    })
  </script>
</body>
</html>
```

### Slide Content Patterns

When building slides, use these reusable layout patterns:

| Pattern | When to use | HTML |
|---|---|---|
| **Title slide** | Opening, section dividers | `.slide.slide-gradient` with centred h1 |
| **Split layout** | Feature + screenshot | `.split` with text left, browser/phone mockup right |
| **Card grid** | Features, benefits, comparisons | `.card-grid.two-col` or `.three-col` |
| **Stat cards** | Metrics, KPIs | Large number (42px) + label in a card |
| **Table** | Data, pricing, comparisons | `<table>` inside a card |
| **Callout** | Key insight, quote | `.callout` with left border |
| **Bullet list** | Process steps, requirements | `<ul>` with custom styled bullets |

### Video-Optimised Version

If creating a version for video recording, make a separate `video.html` with these changes:
- Remove password gate (if present)
- Remove slide transition animations (use instant `display: none/flex` swaps)
- Remove hover effects that don't appear in recordings
- Ensure all slides are accessible from slide 0 (no conditional visibility)

## Presentation Mode — Additional Notes

**Timeout:** Set `test.setTimeout()` inside the test to just above the expected audio duration (e.g. 65s audio → `test.setTimeout(80000)`). Don't rely on the global config timeout — Playwright keeps the test alive until the timeout expires, recording blank frames the entire time. A 5-minute config timeout on a 60s video produces a 300s WebM that wastes disk and encoding time.

**Slide transitions:** Use direct DOM manipulation (`display: none/flex`) not the presentation's built-in `goToSlide()` — JS animation functions cause blank frames in the recording.

**Nav bar updates:** Direct DOM changes don't trigger the presentation's JS event handlers. Manually update counters, progress bars, and dot indicators in `page.evaluate()` after each slide change.

**Video save:** Call `page.video().saveAs(path)` explicitly at the end. Without this, Playwright does not retain the video file for passing tests.

**Test exit code:** The test may exit with code 1 (timeout) even though the video is saved successfully. Use `;` not `&&` when chaining the record command with compose: `npm run demo:record ; node compose-video.mjs ...`

**Screenshots for slides:** If the presentation includes app screenshots, capture them with a separate Playwright script before recording. Use retina resolution (2x `deviceScaleFactor`) for crisp images at 1920x1080.
