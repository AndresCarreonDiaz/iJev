// Eyes for Jev: Claude looks at the photo once and describes it in words.
// It never suggests edits; Jev still makes every decision. Runs the claude CLI
// headless on the Claude Code login (a subscription), like jevvium's provider,
// and caches each answer in samples/captions.json. look() is also the
// independent judge for the drawing benchmark.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

export type Caption = { scene: string; style: string; looks_off: string }

const CACHE = 'samples/captions.json'
const SYSTEM =
  'You describe photos for an editor that cannot see. Answer with JSON only, no prose: ' +
  '{"scene": "what the photo shows, in one sentence", ' +
  '"style": "its lighting and look, and whether that seems intended (for example a deliberately dark, black and white or muted shot)", ' +
  '"looks_off": "anything about brightness, contrast, color or tint that looks wrong, or \\"nothing\\""}. ' +
  'Describe only; never suggest edits.'
/** Kept out of the CLI's environment so the Claude Code login answers (from jevvium's provider). */
const WITHHELD = ['CLAUDECODE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_EFFORT_LEVEL', 'CLAUDE_CODE_EXTRA_BODY', 'TYPESAFE_API_KEY', 'OPENAI_API_KEY']

const cache: Record<string, Caption & { mtime: number }> = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}
let cwd: string | undefined

export async function see(path: string): Promise<Caption> {
  const mtime = statSync(path).mtimeMs
  const hit = cache[path]
  if (hit?.mtime === mtime) return { scene: hit.scene, style: hit.style, looks_off: hit.looks_off }
  const text = await look([await readFileAsJpeg(path)], SYSTEM, 'Describe this photo.')
  const caption = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Caption
  cache[path] = { ...caption, mtime }
  writeFileSync(CACHE, JSON.stringify(cache, null, 2))
  return caption
}

const readFileAsJpeg = async (path: string) => sharp(path).resize({ width: 512, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer()

/** Show Claude one or more images (JPEG or PNG buffers) and get its text answer. */
export async function look(images: Buffer[], system: string, text: string): Promise<string> {
  const content = [
    ...(await Promise.all(images.map(async (image) => ({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: (await sharp(image).jpeg({ quality: 85 }).toBuffer()).toString('base64') },
    })))),
    { type: 'text', text },
  ]
  const message = { type: 'user', message: { role: 'user', content } }
  // An empty folder, so the CLI finds no project to load.
  if (!cwd) {
    const dir = mkdtempSync(join(tmpdir(), 'jev-canvas-see-'))
    process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
    cwd = dir
  }
  const env = { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  for (const key of WITHHELD) delete env[key]
  const args = [
    '-p', '--safe-mode', '--model', 'sonnet', '--effort', 'low', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--tools', '', '--no-session-persistence', '--system-prompt', system,
  ]
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8').on('data', (c: string) => (out += c))
    child.stderr.setEncoding('utf8').on('data', (c: string) => (err += c))
    const timer = setTimeout(() => child.kill(), 120_000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      code === 0 ? resolve(out) : reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`))
    })
    child.stdin.end(JSON.stringify(message) + '\n')
  })
  const result = stdout.trim().split('\n').map((line) => JSON.parse(line)).find((e) => e.type === 'result')
  return result?.result ?? ''
}

export type Thing = { thing: string; color: string; where: string; box?: [number, number, number, number] }
const THINGS_SYSTEM =
  'You list what is in a photo for an editor who cannot see it. Answer with JSON only: an array of up to 8 ' +
  '{"thing": "...", "color": "its color as it looks", "where": "where it is in the frame and how much of it it covers", ' +
  '"box": [left, top, right, bottom] as rough percentages of the width and height}. ' +
  'Cover the main objects and the background. Describe only.'

/** The main things in a photo, with color and place, from one look by Claude (cached). */
export async function things(path: string): Promise<Thing[]> {
  const key = `things-with-boxes:${path}`
  const mtime = statSync(path).mtimeMs
  const hit = cache[key] as unknown as { mtime: number; list: Thing[] } | undefined
  if (hit?.mtime === mtime) return hit.list
  const text = await look([await readFileAsJpeg(path)], THINGS_SYSTEM, 'List what is in this photo.')
  const list = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)) as Thing[]
  ;(cache as Record<string, unknown>)[key] = { mtime, list }
  writeFileSync(CACHE, JSON.stringify(cache, null, 2))
  return list
}
