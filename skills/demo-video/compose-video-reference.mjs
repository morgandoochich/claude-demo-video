#!/usr/bin/env node
/**
 * Compose final demo videos by muxing Playwright recordings with voiceover audio.
 *
 * Usage:
 *   node playwright/compose-video.mjs                                    # auto mode (all flows)
 *   node playwright/compose-video.mjs --scenes playwright/scenes-sign-detail.mjs
 *   node playwright/compose-video.mjs --video v.webm --audio a.mp3 -o out.mp4  # manual mode
 *
 * Requires:
 *   - ffmpeg and ffprobe on PATH
 *   - Playwright video recordings in playwright-results/
 *   - Voiceover audio in playwright-results/voiceover/ (run generate-voiceover.mjs first)
 *
 * Output:
 *   playwright-results/<scene-id>-final.mp4
 */

import { execSync } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync, readdirSync, statSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RESULTS_DIR = join(__dirname, '..', 'playwright-results')
const VOICEOVER_DIR = join(__dirname, 'voiceover-cache')

// ─── CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2)

function getArg(flag) {
  const idx = args.indexOf(flag)
  return idx !== -1 ? args[idx + 1] : null
}

const scenesFile = getArg('--scenes')
const manualVideo = getArg('--video')
const manualAudio = getArg('--audio')
const manualOutput = getArg('--output') || getArg('-o')

// ─── Load scenes ────────────────────────────────────────────
const scenesPath = scenesFile
  ? (scenesFile.startsWith('/') ? scenesFile : join(process.cwd(), scenesFile))
  : join(__dirname, 'scenes.mjs')
const { scenes } = await import(scenesPath)

// ─── Preflight ───────────────────────────────────────────────
try {
  execSync('which ffmpeg', { stdio: 'pipe' })
  execSync('which ffprobe', { stdio: 'pipe' })
} catch {
  console.error('Error: ffmpeg and ffprobe must be installed and on PATH.')
  process.exit(1)
}

// ─── Helpers ─────────────────────────────────────────────────

function getDuration(filePath) {
  const out = execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`,
    { encoding: 'utf-8' }
  )
  return parseFloat(out.trim())
}

/**
 * Find the .webm video file in a Playwright test output directory.
 * Playwright nests videos inside test-result directories.
 */
function findVideoFile(videoDir) {
  // Playwright stores videos in: playwright-results/<test-name>/video.webm
  // But the directory name may vary, so search for .webm files
  const searchDirs = [RESULTS_DIR]

  // Also check subdirectories
  try {
    const entries = readdirSync(RESULTS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        searchDirs.push(join(RESULTS_DIR, entry.name))
      }
    }
  } catch {
    // ignore
  }

  // Search for directory matching the videoDir pattern
  for (const dir of searchDirs) {
    const dirName = dirname !== RESULTS_DIR ? dir.split('/').pop() : ''
    if (dirName && videoDir && dirName.includes(videoDir.replace(/\s/g, '-'))) {
      // Look for .webm files in this directory
      try {
        const files = readdirSync(dir)
        const webm = files.find((f) => f.endsWith('.webm'))
        if (webm) return join(dir, webm)
      } catch {
        // ignore
      }
    }
  }

  // Fallback: search all subdirectories for any .webm matching the scene
  for (const dir of searchDirs) {
    try {
      const files = readdirSync(dir)
      const webm = files.find((f) => f.endsWith('.webm'))
      if (webm) {
        const candidate = join(dir, webm)
        // Return first match if no videoDir filter
        if (!videoDir) return candidate
      }
    } catch {
      // ignore
    }
  }

  return null
}

/** Mux video and audio into MP4 */
function composeVideo(videoPath, audioPath, outputPath) {
  const videoDuration = getDuration(videoPath)
  const audioDuration = getDuration(audioPath)

  if (audioDuration > videoDuration + 1) {
    console.warn(
      `  ⚠ Audio (${audioDuration.toFixed(1)}s) is longer than video (${videoDuration.toFixed(1)}s) — output will be trimmed to video length`
    )
  }

  // Re-encode video (VP8/WebM → H.264/MP4) and mux with audio
  execSync(
    `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v libx264 -preset fast -crf 23 -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${outputPath}"`,
    { stdio: 'pipe' }
  )

  const finalDuration = getDuration(outputPath)
  const size = statSync(outputPath).size
  console.log(
    `  → ${outputPath.split('/').pop()} (${finalDuration.toFixed(1)}s, ${(size / 1024 / 1024).toFixed(1)} MB)`
  )
}

// ─── Main ────────────────────────────────────────────────────

function main() {
  // Manual mode
  if (manualVideo && manualAudio) {
    if (!existsSync(manualVideo)) {
      console.error(`Video file not found: ${manualVideo}`)
      process.exit(1)
    }
    if (!existsSync(manualAudio)) {
      console.error(`Audio file not found: ${manualAudio}`)
      process.exit(1)
    }
    const output = manualOutput || manualVideo.replace(/\.webm$/, '-final.mp4')
    console.log('Composing video...')
    composeVideo(manualVideo, manualAudio, output)
    console.log('\nDone!')
    return
  }

  // Auto mode
  console.log('Composing demo videos...\n')
  let composed = 0

  for (const scene of scenes) {
    const audioPath = join(VOICEOVER_DIR, `${scene.id}-voiceover.mp3`)
    if (!existsSync(audioPath)) {
      console.log(`Skip: ${scene.id} — no voiceover audio (run generate-voiceover.mjs first)`)
      continue
    }

    console.log(`Flow: ${scene.id}`)

    const videoPath = findVideoFile(scene.videoDir)
    if (!videoPath) {
      console.warn(`  ⚠ No video found for "${scene.videoDir}" in playwright-results/`)
      console.warn('    Run: npx playwright test playwright/record-session.spec.ts')
      continue
    }

    console.log(`  Video: ${videoPath.split('/').pop()}`)
    console.log(`  Audio: ${scene.id}-voiceover.mp3`)

    const outputPath = join(RESULTS_DIR, `${scene.id}-final.mp4`)
    composeVideo(videoPath, audioPath, outputPath)
    composed++
    console.log()
  }

  if (composed === 0) {
    console.log('No videos composed. Make sure you have both:')
    console.log('  1. Playwright recordings (npx playwright test)')
    console.log('  2. Voiceover audio (node playwright/generate-voiceover.mjs)')
  } else {
    console.log(`Done! ${composed} video(s) saved to playwright-results/`)
  }
}

main()
