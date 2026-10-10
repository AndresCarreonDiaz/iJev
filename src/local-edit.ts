// Real local edits with a decision model: Jev decides WHERE and WHAT, code does the pixels.
// 1. Code cuts the photo into ~350 regions that follow its edges (regions.ts),
//    and Claude looks once to list the main things in it, with color and place
//    (Jev can't see; from region colors alone it guessed grapes were green).
// 2. Jev answers one yes-or-no question per region: is it part of what the
//    instruction changes? Code smooths the answers with each region's neighbors
//    and turns them into a soft mask.
// 3. Jev picks the operation, color and strength; code applies it inside the mask.
//
//   node src/local-edit.ts samples/photos/75.jpg "Turn the grapes green"
import { mkdirSync } from 'node:fs'
import sharp from 'sharp'
import { ask, costLine } from './jev.ts'
import { segment } from './regions.ts'
import { photoContext, selectThing } from './select.ts'
import { describe as describeSight, see as retina, type Sight } from './retina.ts'

const OPERATIONS: Record<string, string> = {
  recolor: 'Change its color to another color, keeping its shading.',
  brighten: 'Make it lighter.',
  darken: 'Make it darker.',
  'more vivid': 'Make its colors stronger.',
  'more muted': 'Make its colors weaker.',
  'black and white': 'Remove its color.',
  blur: 'Blur it, like an out-of-focus background.',
}
const COLORS: Record<string, [number, number, number]> = {
  red: [210, 40, 40], orange: [240, 130, 40], 'golden yellow': [240, 190, 60], yellow: [240, 220, 60], green: [60, 170, 60],
  'lime green': [150, 210, 60], teal: [30, 160, 150], turquoise: [60, 200, 200], 'sky blue': [110, 180, 240], blue: [40, 80, 210],
  purple: [130, 60, 180], pink: [240, 130, 180], white: [245, 245, 245], brown: [130, 85, 45], black: [25, 25, 25],
}
const STRENGTH = { subtle: 0.45, clear: 0.75, strong: 1 }

// sRGB <-> Lab, so recoloring keeps each pixel's lightness (its light and shadow).
const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const gam = (c: number) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
function toLab(r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.9505), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.089)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}
function fromLab(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200
  const inv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787)
  const X = inv(fx) * 0.9505, Y = inv(fy), Z = inv(fz) * 1.089
  return [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z].map(gam) as [number, number, number]
}

const args = process.argv.slice(2)
const eyes = args.includes('--eyes') ? args[args.indexOf('--eyes') + 1] : 'code'
const [input, instruction] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--eyes')
if (!input || !instruction || !['code', 'claude'].includes(eyes)) {
  console.error('usage: node src/local-edit.ts <photo> "<instruction>" [--eyes code|claude]')
  process.exit(1)
}

const started = performance.now()
const sight = eyes === 'code' ? await retina(input) : undefined
const seg = sight ? sight.seg : await segment(input)
const context = sight ? { image: describeSight(sight) } : await photoContext(input, (line) => console.log(line))

// What to do: one request.
const plan = await ask(
  { instruction, ...context },
  {
    operation: { type: 'choice', instructions: `Which operation carries out: "${instruction}"?`, criteria: OPERATIONS },
    color: { type: 'choice', instructions: `If it needs a new color, which color does "${instruction}" ask for?`, criteria: Object.fromEntries(Object.keys(COLORS).map((c) => [c, null])) },
    strength: { type: 'choice', instructions: `How strong should the change be for "${instruction}"?`, criteria: { subtle: null, clear: null, strong: null } },
  },
)
const operation = plan.operation.choice, color = plan.color.choice, strength = STRENGTH[plan.strength.choice as keyof typeof STRENGTH] ?? 0.75
console.log(`jev: ${operation}${operation === 'recolor' ? ` to ${color}` : ''}, ${plan.strength.choice}`)

// Where: one yes-or-no question per region.
const chosen = sight ? await chooseSegments(sight) : (await selectThing(seg, instruction, context)).chosen
console.log(`jev: ${chosen.size} ${sight ? 'segments' : 'regions'} are part of it`)

/**
 * Code eyes: Jev reads the letter map and picks the segment the instruction is
 * mostly about (one choice across all letters), then says for every other
 * segment whether it is the same thing.
 */
async function chooseSegments(sight: Sight): Promise<Set<number>> {
  const state = { instruction, ...context }
  const first = await ask(state, {
    anchor: { type: 'choice', instructions: `Which segment is (the main part of) what "${instruction}" changes?`, criteria: Object.fromEntries(sight.segs.map((s) => [s.letter, null])) },
  })
  const anchor = first.anchor.choice
  const others = sight.segs.filter((s) => s.letter !== anchor)
  const same = await ask({ ...state, main_part: `segment ${anchor}` }, Object.fromEntries(others.map((s) => [s.letter, {
    type: 'choice' as const,
    instructions: `Segment ${anchor} is (part of) what "${instruction}" changes. Is segment ${s.letter} part of that same thing?`,
    criteria: { 'same thing': `Another part of what segment ${anchor} shows.`, 'something else': 'A different thing, which stays as it is.' },
  }])))
  const picked = [anchor, ...others.filter((s) => same[s.letter].choice === 'same thing').map((s) => s.letter)]
  console.log(`jev: main part ${anchor}; with it ${picked.slice(1).join('') || 'nothing'}`)
  return new Set(sight.segs.filter((s) => picked.includes(s.letter)).map((s) => s.id))
}

// Soft mask at full size.
const small = Buffer.alloc(seg.width * seg.height)
for (let i = 0; i < small.length; i++) small[i] = chosen.has(sight ? sight.segOf[i] : seg.labels[i]) ? 255 : 0
const { data: rgb, info } = await sharp(input).rotate().resize({ width: 1024, withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
const mask = await sharp(small, { raw: { width: seg.width, height: seg.height, channels: 1 } })
  .resize(info.width, info.height, { kernel: 'linear' })
  .blur(2)
  .extractChannel(0) // sharp hands back 3 channels otherwise
  .raw()
  .toBuffer()

// The edit, everywhere; then mixed in through the mask.
const edited = Buffer.alloc(rgb.length)
if (operation === 'blur') {
  const blurred = await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } }).blur(4 + 8 * strength).raw().toBuffer()
  blurred.copy(edited)
} else {
  const [tL, ta, tb] = toLab(...COLORS[color])
  for (let i = 0; i < rgb.length; i += 3) {
    let [L, a, b] = toLab(rgb[i], rgb[i + 1], rgb[i + 2])
    // Color moves all the way; lightness half way, keeping shadows but letting white be white.
    if (operation === 'recolor') { a += (ta - a) * strength; b += (tb - b) * strength; L += (tL - L) * 0.5 * strength }
    if (operation === 'brighten') L = Math.min(100, L + 18 * strength)
    if (operation === 'darken') L = Math.max(0, L - 18 * strength)
    if (operation === 'more vivid') { a *= 1 + 0.6 * strength; b *= 1 + 0.6 * strength }
    if (operation === 'more muted') { a *= 1 - 0.6 * strength; b *= 1 - 0.6 * strength }
    if (operation === 'black and white') { a *= 1 - strength; b *= 1 - strength }
    const out = fromLab(L, a, b)
    for (let c = 0; c < 3; c++) edited[i + c] = Math.max(0, Math.min(255, Math.round(out[c])))
  }
}
const result = Buffer.alloc(rgb.length)
const overlay = Buffer.alloc(rgb.length)
for (let i = 0, m = 0; i < rgb.length; i += 3, m++) {
  const k = mask[m] / 255
  for (let c = 0; c < 3; c++) {
    result[i + c] = Math.round(rgb[i + c] * (1 - k) + edited[i + c] * k)
    // What Jev selected, tinted magenta.
    overlay[i + c] = Math.round(rgb[i + c] * (1 - 0.55 * k) + [255, 0, 200][c] * 0.55 * k)
  }
}

// Side by side: original | what Jev selected | result.
const raw = { raw: { width: info.width, height: info.height, channels: 3 as const } }
const h = 360
const tiles = await Promise.all([rgb, overlay, result].map((b) => sharp(b, raw).resize({ height: h }).jpeg().toBuffer({ resolveWithObject: true })))
const w = tiles[0].info.width
mkdirSync('watch', { recursive: true })
const slug = instruction.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const out = `watch/local-${slug}.jpg`
await sharp({ create: { width: w * 3 + 16, height: h, channels: 3, background: '#ffffff' } })
  .composite(tiles.map((t, i) => ({ input: t.data, left: i * (w + 8), top: 0 })))
  .jpeg({ quality: 88 })
  .toFile(out)
console.log(`${out}  (${((performance.now() - started) / 1000).toFixed(1)} s)`)
console.log(costLine())
