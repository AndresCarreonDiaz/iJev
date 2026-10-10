// Experiment 1: pixel art, one choice per pixel.
// Jev paints a 16x16 grid row by row. Each request sends the canvas so far as
// text (one letter per pixel) and asks 16 questions at once, one per pixel in
// the next row. With --blind, rows don't see each other (all sent at once).
//
//   node src/draw-pixels.ts "a red heart on a white background" [--size 16] [--blind]
import { mkdirSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { ask, costLine, type Choice } from './jev.ts'

const PALETTE: Record<string, { letter: string; rgb: [number, number, number] }> = {
  white: { letter: '.', rgb: [255, 255, 255] },
  black: { letter: 'K', rgb: [20, 20, 20] },
  gray: { letter: 'A', rgb: [140, 140, 140] },
  red: { letter: 'R', rgb: [220, 30, 40] },
  orange: { letter: 'O', rgb: [245, 140, 30] },
  yellow: { letter: 'Y', rgb: [250, 215, 40] },
  green: { letter: 'G', rgb: [40, 160, 60] },
  'sky blue': { letter: 'S', rgb: [120, 190, 240] },
  blue: { letter: 'B', rgb: [30, 70, 200] },
  brown: { letter: 'N', rgb: [120, 75, 35] },
  pink: { letter: 'P', rgb: [245, 150, 190] },
}
const COLORS = Object.keys(PALETTE)

const args = process.argv.slice(2)
const subject = args.find((a) => !a.startsWith('--')) ?? 'a red heart on a white background'
const size = Number(args[args.indexOf('--size') + 1]) || 16
const blind = args.includes('--blind')

const grid: (string | null)[][] = Array.from({ length: size }, () => Array(size).fill(null))
const asText = () => grid.map((row) => row.map((c) => (c ? PALETTE[c].letter : '?')).join('')).join('\n')
const legend = Object.fromEntries(COLORS.map((c) => [PALETTE[c].letter, c]))

async function paintRow(y: number) {
  const state = {
    task: `Pixel art of ${subject}, ${size}x${size} pixels.`,
    coordinates: `Row 0 is the top and row ${size - 1} the bottom. Column 0 is the left and column ${size - 1} the right.`,
    ...(blind ? {} : { canvas_so_far: asText(), legend: { ...legend, '?': 'not painted yet' } }),
  }
  const criteria = Object.fromEntries(COLORS.map((c) => [c, null]))
  const questions: Record<string, Choice> = {}
  for (let x = 0; x < size; x++) {
    questions[`x${x}`] = { type: 'choice', instructions: `Which color is the pixel at row ${y}, column ${x}?`, criteria }
  }
  const answers = await ask(state, questions)
  for (let x = 0; x < size; x++) grid[y][x] = answers[`x${x}`].choice
}

const started = performance.now()
if (blind) {
  await Promise.all(grid.map((_, y) => paintRow(y)))
} else {
  for (let y = 0; y < size; y++) await paintRow(y)
}

const pixels = Buffer.from(grid.flat().flatMap((c) => PALETTE[c!].rgb))
const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const out = `out/pixels-${slug}${blind ? '-blind' : ''}.png`
mkdirSync('out', { recursive: true })
await sharp(pixels, { raw: { width: size, height: size, channels: 3 } })
  .resize(size * 20, size * 20, { kernel: 'nearest' })
  .png()
  .toFile(out)
writeFileSync(out.replace('.png', '.txt'), asText() + '\n')

console.log(asText())
console.log(`\n${out}  (${((performance.now() - started) / 1000).toFixed(1)} s)`)
console.log(costLine())
