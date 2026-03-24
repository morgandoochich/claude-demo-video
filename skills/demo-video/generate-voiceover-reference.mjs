#!/usr/bin/env node
/**
 * Generate voiceover audio for demo videos.
 *
 * Supports providers:
 *   - openai (gpt-4o-mini-tts) — set via scene.ttsProvider or default
 *   - elevenlabs (eleven_multilingual_v2) — natural Australian voices
 *
 * Supports modes:
 *   - Per-segment: One API call per segment
 *   - Single-call: All text in one call → consistent voice (singleCall: true)
 *
 * Usage:
 *   node playwright/generate-voiceover.mjs --scenes playwright/scenes-sign-detail.mjs
 *   node playwright/generate-voiceover.mjs --force
 *
 * Requires: OPENAI_API_KEY or ELEVENLABS_API_KEY, ffmpeg, ffprobe
 */

import { execSync } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VOICEOVER_DIR = join(__dirname, 'voiceover-cache')
const SAMPLE_RATE = 44100

// ─── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2)
const scenesFile = args.includes('--scenes') ? args[args.indexOf('--scenes') + 1] : null
const flowFilter = args.includes('--flow') ? args[args.indexOf('--flow') + 1] : null
const force = args.includes('--force')

// ─── Load scenes ────────────────────────────────────────────
const scenesPath = scenesFile
  ? (scenesFile.startsWith('/') ? scenesFile : join(process.cwd(), scenesFile))
  : join(__dirname, 'scenes.mjs')
const { scenes } = await import(scenesPath)

// ─── Preflight checks ───────────────────────────────────────
const needsOpenAI = scenes.some((s) => !s.ttsProvider || s.ttsProvider === 'openai')
const needsElevenLabs = scenes.some((s) => s.ttsProvider === 'elevenlabs')

if (needsOpenAI && !process.env.OPENAI_API_KEY) {
  console.error('Error: OPENAI_API_KEY environment variable is not set.')
  process.exit(1)
}
if (needsElevenLabs && !process.env.ELEVENLABS_API_KEY) {
  console.error('Error: ELEVENLABS_API_KEY environment variable is not set.')
  process.exit(1)
}

try {
  execSync('which ffmpeg', { stdio: 'pipe' })
  execSync('which ffprobe', { stdio: 'pipe' })
} catch {
  console.error('Error: ffmpeg and ffprobe must be installed and on PATH.')
  process.exit(1)
}

// ─── TTS clients (lazy init) ────────────────────────────────
let openai = null
let elevenlabs = null

async function getOpenAI() {
  if (!openai) {
    const { default: OpenAI } = await import('openai')
    openai = new OpenAI()
  }
  return openai
}

async function getElevenLabs() {
  if (!elevenlabs) {
    const { ElevenLabsClient } = await import('@elevenlabs/elevenlabs-js')
    elevenlabs = new ElevenLabsClient()
  }
  return elevenlabs
}

// ─── Helpers ─────────────────────────────────────────────────

function getDuration(filePath) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
    { encoding: 'utf-8' }
  )
  return parseFloat(out.trim())
}

function normalize(inputPath, outputPath) {
  execSync(
    `ffmpeg -y -i "${inputPath}" -ar ${SAMPLE_RATE} -ac 1 -c:a libmp3lame -q:a 2 "${outputPath}"`,
    { stdio: 'pipe' }
  )
}

function generateSilence(outputPath, durationSec) {
  execSync(
    `ffmpeg -y -f lavfi -i anullsrc=r=${SAMPLE_RATE}:cl=mono -t ${durationSec} -c:a libmp3lame -q:a 9 "${outputPath}"`,
    { stdio: 'pipe' }
  )
}

/** Detect silence gaps in audio, returns array of { start, end, duration } in seconds */
function detectSilences(filePath, minDuration = 0.4, noiseThreshold = -30) {
  const stderr = execSync(
    `ffmpeg -i "${filePath}" -af "silencedetect=noise=${noiseThreshold}dB:d=${minDuration}" -f null - 2>&1`,
    { encoding: 'utf-8' }
  )
  const silences = []
  const startRegex = /silence_start: ([\d.]+)/g
  const endRegex = /silence_end: ([\d.]+)/g
  const starts = [...stderr.matchAll(startRegex)].map((m) => parseFloat(m[1]))
  const ends = [...stderr.matchAll(endRegex)].map((m) => parseFloat(m[1]))
  for (let i = 0; i < Math.min(starts.length, ends.length); i++) {
    silences.push({ start: starts[i], end: ends[i], duration: ends[i] - starts[i] })
  }
  return silences
}

/**
 * Pick the N largest silence gaps to use as segment boundaries.
 * Returns them sorted by time position (not by duration).
 */
function pickBoundaryGaps(silences, count) {
  // Sort by duration descending, pick the top N
  const sorted = [...silences].sort((a, b) => b.duration - a.duration)
  const picked = sorted.slice(0, count)
  // Re-sort by time position
  picked.sort((a, b) => a.start - b.start)
  return picked
}

// ─── Single-call mode ────────────────────────────────────────

async function generateSingleCall(scene) {
  const rawPath = join(VOICEOVER_DIR, `${scene.id}-single-raw.mp3`)
  const outPath = join(VOICEOVER_DIR, `${scene.id}-voiceover.mp3`)
  const timestampsPath = join(VOICEOVER_DIR, `${scene.id}-timestamps.json`)

  if (!force && existsSync(outPath) && existsSync(timestampsPath)) {
    const timestamps = JSON.parse(readFileSync(timestampsPath, 'utf-8'))
    const duration = getDuration(outPath)
    console.log(`  ✓ ${scene.id}-voiceover.mp3 (cached, ${duration.toFixed(1)}s)`)
    console.log(`  Segment timestamps:`)
    timestamps.forEach((t) => console.log(`    ${t.id}: ${t.startSec.toFixed(1)}s – ${t.endSec.toFixed(1)}s (${(t.endSec - t.startSec).toFixed(1)}s)`))
    return { outPath, timestamps }
  }

  // Build concatenated text with paragraph breaks (no markers — ElevenLabs reads them aloud)
  const fullText = scene.segments.map((s) => s.text).join('\n\n')
  const provider = scene.ttsProvider || 'openai'

  console.log(`  Generating single TTS call via ${provider} (${fullText.length} chars)...`)

  if (provider === 'elevenlabs') {
    const client = await getElevenLabs()
    // Use the voice ID from the first segment or scene default
    const voiceId = scene.voice || scene.segments[0]?.voice || 'VOICE_ID_HERE'
    console.log(`  Voice ID: ${voiceId}`)
    const audio = await client.textToSpeech.convert(voiceId, {
      text: fullText,
      modelId: 'eleven_multilingual_v2',
      outputFormat: 'mp3_44100_128',
    })
    const chunks = []
    for await (const chunk of audio) {
      chunks.push(chunk)
    }
    writeFileSync(outPath, Buffer.concat(chunks))
  } else {
    const client = await getOpenAI()
    const voice = scene.segments[0]?.voice || 'nova'
    const instructions = scene.segments[0]?.instructions ||
      'Speak with a clear Australian accent. Female voice, warm and professional product walkthrough tone. Moderate pace.'
    const response = await client.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice,
      input: fullText,
      instructions,
      response_format: 'mp3',
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    writeFileSync(rawPath, buffer)
    normalize(rawPath, outPath)
    unlinkSync(rawPath)
  }

  const totalDuration = getDuration(outPath)
  console.log(`  ✓ Generated: ${totalDuration.toFixed(1)}s total`)

  // Detect silence gaps to find segment boundaries
  const allSilences = detectSilences(outPath)
  const numBoundaries = scene.segments.length - 1
  const boundaries = pickBoundaryGaps(allSilences, numBoundaries)
  console.log(`  Found ${allSilences.length} silence gaps, picked ${boundaries.length} boundaries (expected ${numBoundaries})`)

  // Build timestamps from boundary midpoints
  const timestamps = []
  let segStart = 0
  for (let i = 0; i < scene.segments.length; i++) {
    const segment = scene.segments[i]
    let segEnd
    if (i < boundaries.length) {
      segEnd = (boundaries[i].start + boundaries[i].end) / 2
    } else {
      segEnd = totalDuration
    }
    timestamps.push({
      id: segment.id,
      startSec: segStart,
      endSec: segEnd,
    })
    console.log(`    ${segment.id}: ${segStart.toFixed(1)}s – ${segEnd.toFixed(1)}s (${(segEnd - segStart).toFixed(1)}s)`)
    if (i < boundaries.length) {
      segStart = boundaries[i].end
    }
  }

  writeFileSync(timestampsPath, JSON.stringify(timestamps, null, 2))
  console.log(`  → ${scene.id}-voiceover.mp3 (${totalDuration.toFixed(1)}s)`)
  console.log(`  → ${scene.id}-timestamps.json`)

  return { outPath, timestamps }
}

// ─── Per-segment chained mode (ElevenLabs) ───────────────────
// Generates each segment as a separate API call with previous_request_ids
// for voice continuity. Measures exact durations, concatenates with
// controlled silence gaps, and produces perfect timestamps.

const SILENCE_GAP_SEC = 1.0 // silence between segments

async function generatePerSegmentChained(scene) {
  const outPath = join(VOICEOVER_DIR, `${scene.id}-voiceover.mp3`)
  const timestampsPath = join(VOICEOVER_DIR, `${scene.id}-timestamps.json`)

  if (!force && existsSync(outPath) && existsSync(timestampsPath)) {
    const timestamps = JSON.parse(readFileSync(timestampsPath, 'utf-8'))
    const duration = getDuration(outPath)
    console.log(`  ✓ ${scene.id}-voiceover.mp3 (cached, ${duration.toFixed(1)}s)`)
    timestamps.forEach((t) => console.log(`    ${t.id}: ${t.startSec.toFixed(1)}s – ${t.endSec.toFixed(1)}s (${(t.endSec - t.startSec).toFixed(1)}s)`))
    return { outPath, timestamps }
  }

  const client = await getElevenLabs()
  const voiceId = scene.voice || 'VOICE_ID_HERE'
  console.log(`  Voice ID: ${voiceId}`)
  console.log(`  Generating ${scene.segments.length} chained segments...`)

  const previousRequestIds = []
  const clipPaths = []
  const clipDurations = []

  for (const segment of scene.segments) {
    const clipPath = join(VOICEOVER_DIR, `${segment.id}.mp3`)

    // Use cached clip if available (same text = same audio)
    if (!force && existsSync(clipPath)) {
      const dur = getDuration(clipPath)
      clipPaths.push(clipPath)
      clipDurations.push(dur)
      console.log(`    ✓ ${segment.id} (cached, ${dur.toFixed(1)}s)`)
      // We don't have the request ID for cached clips, so clear the chain
      // This is fine — voice consistency is per-session, and cached clips
      // were generated in sequence originally
      continue
    }

    const requestParams = {
      text: segment.text,
      modelId: 'eleven_multilingual_v2',
      outputFormat: 'mp3_44100_128',
    }

    // Chain to previous clips for voice continuity
    if (previousRequestIds.length > 0) {
      requestParams.previousRequestIds = previousRequestIds.slice(-3) // last 3 max
    }

    // Pass remaining text as context for pacing
    const segIndex = scene.segments.indexOf(segment)
    if (segIndex < scene.segments.length - 1) {
      requestParams.nextText = scene.segments[segIndex + 1].text
    }
    if (segIndex > 0) {
      requestParams.previousText = scene.segments[segIndex - 1].text
    }

    const audio = await client.textToSpeech.convert(voiceId, requestParams)

    const chunks = []
    for await (const chunk of audio) {
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks)
    writeFileSync(clipPath, buffer)

    // Extract request ID from headers if available (for chaining)
    // ElevenLabs returns request-id in response headers
    // The SDK may expose this — for now we skip and rely on previous_text/next_text

    const dur = getDuration(clipPath)
    clipPaths.push(clipPath)
    clipDurations.push(dur)
    console.log(`    ✓ ${segment.id} (${dur.toFixed(1)}s)`)

    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 500))
  }

  // Build timestamps from exact measured durations
  const timestamps = []
  let currentSec = 0
  for (let i = 0; i < scene.segments.length; i++) {
    const startSec = currentSec
    const endSec = currentSec + clipDurations[i]
    timestamps.push({
      id: scene.segments[i].id,
      startSec: +startSec.toFixed(2),
      endSec: +endSec.toFixed(2),
    })
    currentSec = endSec + SILENCE_GAP_SEC
  }

  console.log(`  Segment timestamps (exact):`)
  timestamps.forEach((t) => console.log(`    ${t.id}: ${t.startSec.toFixed(1)}s – ${t.endSec.toFixed(1)}s (${(t.endSec - t.startSec).toFixed(1)}s)`))

  // Concatenate clips with silence gaps using ffmpeg
  const concatFile = join(VOICEOVER_DIR, `${scene.id}-concat.txt`)
  const lines = []
  for (let i = 0; i < clipPaths.length; i++) {
    lines.push(`file '${clipPaths[i]}'`)
    if (i < clipPaths.length - 1) {
      const silencePath = join(VOICEOVER_DIR, `silence-gap-${i}.mp3`)
      generateSilence(silencePath, SILENCE_GAP_SEC)
      lines.push(`file '${silencePath}'`)
    }
  }

  writeFileSync(concatFile, lines.join('\n'))
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:a libmp3lame -q:a 2 "${outPath}"`,
    { stdio: 'pipe' }
  )

  const totalDuration = getDuration(outPath)
  console.log(`  → ${scene.id}-voiceover.mp3 (${totalDuration.toFixed(1)}s total)`)

  // Clean up
  unlinkSync(concatFile)
  for (let i = 0; i < clipPaths.length - 1; i++) {
    const silencePath = join(VOICEOVER_DIR, `silence-gap-${i}.mp3`)
    if (existsSync(silencePath)) unlinkSync(silencePath)
  }

  writeFileSync(timestampsPath, JSON.stringify(timestamps, null, 2))
  console.log(`  → ${scene.id}-timestamps.json`)

  return { outPath, timestamps }
}

// ─── Per-segment mode (legacy OpenAI) ────────────────────────

async function generateSegmentAudio(segment) {
  const rawPath = join(VOICEOVER_DIR, `${segment.id}-raw.mp3`)
  const outPath = join(VOICEOVER_DIR, `${segment.id}.mp3`)

  if (!force && existsSync(outPath)) {
    console.log(`  ✓ ${segment.id} (cached)`)
    return outPath
  }

  const response = await openai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice: segment.voice,
    input: segment.text,
    instructions: segment.instructions,
    response_format: 'mp3',
  })

  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(rawPath, buffer)
  normalize(rawPath, outPath)
  unlinkSync(rawPath)

  const duration = getDuration(outPath)
  console.log(`  ✓ ${segment.id} (${duration.toFixed(1)}s)`)

  if (segment.durationMs) {
    const slotSec = segment.durationMs / 1000
    if (duration > slotSec) {
      console.warn(`    ⚠ Speech (${duration.toFixed(1)}s) exceeds slot (${slotSec}s)`)
    }
  }

  return outPath
}

function buildCombinedTrack(scene) {
  const concatFile = join(VOICEOVER_DIR, `${scene.id}-concat.txt`)
  const outputPath = join(VOICEOVER_DIR, `${scene.id}-voiceover.mp3`)
  const lines = []
  let currentMs = 0

  for (const segment of scene.segments) {
    const clipPath = join(VOICEOVER_DIR, `${segment.id}.mp3`)
    const clipDuration = getDuration(clipPath)
    const gapMs = (segment.startMs || 0) - currentMs
    if (gapMs > 50) {
      const silencePath = join(VOICEOVER_DIR, `${segment.id}-silence.mp3`)
      generateSilence(silencePath, gapMs / 1000)
      lines.push(`file '${silencePath}'`)
      currentMs += gapMs
    }
    lines.push(`file '${clipPath}'`)
    currentMs += clipDuration * 1000
  }

  writeFileSync(concatFile, lines.join('\n'))
  execSync(
    `ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:a libmp3lame -q:a 2 "${outputPath}"`,
    { stdio: 'pipe' }
  )

  const totalDuration = getDuration(outputPath)
  console.log(`  → ${scene.id}-voiceover.mp3 (${totalDuration.toFixed(1)}s total)`)

  unlinkSync(concatFile)
  for (const segment of scene.segments) {
    const silencePath = join(VOICEOVER_DIR, `${segment.id}-silence.mp3`)
    if (existsSync(silencePath)) unlinkSync(silencePath)
  }

  return outputPath
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  mkdirSync(VOICEOVER_DIR, { recursive: true })

  const filteredScenes = flowFilter
    ? scenes.filter((s) => s.id === flowFilter)
    : scenes

  if (filteredScenes.length === 0) {
    console.error(`No scene found with id "${flowFilter}"`)
    console.error(`Available: ${scenes.map((s) => s.id).join(', ')}`)
    process.exit(1)
  }

  console.log(`Generating voiceover for ${filteredScenes.length} flow(s)...\n`)

  for (const scene of filteredScenes) {
    console.log(`Flow: ${scene.id}`)

    if (scene.perSegmentChained) {
      await generatePerSegmentChained(scene)
    } else if (scene.singleCall) {
      await generateSingleCall(scene)
    } else {
      for (const segment of scene.segments) {
        await generateSegmentAudio(segment)
      }
      buildCombinedTrack(scene)
    }
    console.log()
  }

  console.log(`Done! Audio files saved to ${VOICEOVER_DIR}`)
}

main().catch((err) => {
  console.error('Failed:', err.message)
  process.exit(1)
})
