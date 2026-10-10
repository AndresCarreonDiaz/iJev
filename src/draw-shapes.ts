// Experiment 2: a picture from shapes, one decision per element.
// Same loop as jevvium: the "screen" is the list of shapes drawn so far, the
// "actions" are elements Jev can add next, and code does the drawing (SVG).
// Jev can't do geometry, so it places things in words ("on top of the house
// wall") and a tiny layout engine turns those words into coordinates.
//
// With feedback (the default), code describes each element as actually drawn
// (size, proportions, position, what it covers) and Jev may adjust it up to 3
// times. With --variants n, Jev's choices are sampled from its probabilities
// to draw n pictures, and Jev picks the best one from their descriptions.
//
//   node src/draw-shapes.ts "a house with a sun in the sky" [--variants 4] [--no-feedback] [--temperature 1] [--seed 1]
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { ask, costLine, type ChoiceAnswer } from './jev.ts'

const W = 512
const CANVAS_NOTE = 'The canvas starts plain white. Every shape gets a thin dark outline.'
const ELEMENTS = [
  'sky', 'ground', 'grass', 'water', 'snow', 'sun', 'moon', 'cloud', 'mountain', 'hill', 'tree trunk', 'tree leaves',
  'house wall', 'roof', 'door', 'window', 'chimney', 'flower stem', 'flower petals', 'flower center', 'head', 'eye',
  'nose', 'mouth', 'hat', 'body', 'arm', 'button', 'heart', 'star', 'boat hull', 'sail', 'mast', 'road', 'car body',
  'car roof', 'car window', 'wheel',
]
const SHAPES = ['circle', 'square', 'wide rectangle', 'tall rectangle', 'triangle', 'ellipse']
const CANVAS_PLACES = [
  'top-left of the canvas', 'top of the canvas', 'top-right of the canvas', 'left of the canvas', 'center of the canvas',
  'right of the canvas', 'bottom-left of the canvas', 'bottom of the canvas', 'bottom-right of the canvas',
  'top half of the canvas', 'bottom half of the canvas', 'bottom strip of the canvas', 'full canvas',
]
const RELATIONS = [
  'on top of', 'inside', 'lower part of', 'upper part of', 'left part of', 'right part of', 'lower-left part of', 'lower-right part of',
  'upper-left part of', 'upper-right part of', 'below', 'left of', 'right of',
] as const
const SIZES = ['tiny', 'small', 'medium', 'large', 'huge'] as const
const OF_CANVAS = { tiny: 0.06, small: 0.14, medium: 0.28, large: 0.45, huge: 0.7 }
const OF_ANCHOR = { tiny: 0.15, small: 0.3, medium: 0.5, large: 0.8, huge: 1.15 }
const COLORS: Record<string, string> = {
  white: '#ffffff', black: '#1a1a1a', gray: '#8c8c8c', red: '#dc1e28', orange: '#f58c1e', yellow: '#fad728',
  green: '#28a03c', 'dark green': '#1e6428', 'sky blue': '#78bef0', blue: '#1e46c8', 'navy blue': '#141e50',
  brown: '#784b23', pink: '#f596be', purple: '#8c3cb4', beige: '#e6d2aa',
}
const ADJUSTMENTS: Record<string, string> = {
  wider: 'Make it wider.',
  narrower: 'Make it narrower.',
  taller: 'Make it taller.',
  shorter: 'Make it shorter.',
  bigger: 'Make it bigger overall.',
  smaller: 'Make it smaller overall.',
  'move left': 'Move it left.',
  'move right': 'Move it right.',
  'move up': 'Move it up.',
  'move down': 'Move it down.',
}

export type Box = { x: number; y: number; w: number; h: number }
export type Element = { label: string; shape: string; color: string; place: string; size: string; box: Box; adjusted: string[] }
export type DrawOptions = { feedback?: boolean; temperature?: number; rand?: () => number; maxSteps?: number; log?: (line: string) => void }

const options = (list: readonly string[]) => Object.fromEntries(list.map((x) => [x, null]))
const area = (b: Box) => Math.max(0, b.w) * Math.max(0, b.h)
const overlap = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))

/** Width and height of a shape whose main dimension is s. */
function dims(shape: string, s: number): [number, number] {
  if (shape === 'wide rectangle') return [s, s * 0.45]
  if (shape === 'tall rectangle') return [s * 0.4, s]
  if (shape === 'ellipse') return [s, s * 0.6]
  if (shape === 'triangle') return [s, s * 0.6]
  return [s, s]
}

function layout(drawn: Element[], shape: string, place: string, size: (typeof SIZES)[number]): Box {
  const relation = RELATIONS.find((r) => place.startsWith(`${r} the `))
  const anchor = relation && drawn.find((e) => place === `${relation} the ${e.label}`)
  if (relation && anchor) {
    const a = anchor.box
    const [w, h] = dims(shape, OF_ANCHOR[size] * Math.max(a.w, a.h))
    const cx = a.x + a.w / 2
    switch (relation) {
      case 'on top of': return { x: cx - w / 2, y: a.y - h, w, h }
      case 'inside': return { x: cx - w / 2, y: a.y + (a.h - h) / 2, w, h }
      case 'lower part of': return { x: cx - w / 2, y: a.y + a.h - h, w, h }
      case 'upper part of': return { x: cx - w / 2, y: a.y + a.h * 0.12, w, h }
      case 'left part of': return { x: a.x + a.w * 0.27 - w / 2, y: a.y + a.h * 0.4 - h / 2, w, h }
      case 'right part of': return { x: a.x + a.w * 0.73 - w / 2, y: a.y + a.h * 0.4 - h / 2, w, h }
      case 'lower-left part of': return { x: a.x + a.w * 0.25 - w / 2, y: a.y + a.h - h * 0.6, w, h }
      case 'lower-right part of': return { x: a.x + a.w * 0.75 - w / 2, y: a.y + a.h - h * 0.6, w, h }
      case 'upper-left part of': return { x: a.x + a.w * 0.27 - w / 2, y: a.y + a.h * 0.12, w, h }
      case 'upper-right part of': return { x: a.x + a.w * 0.73 - w / 2, y: a.y + a.h * 0.12, w, h }
      case 'below': return { x: cx - w / 2, y: a.y + a.h, w, h }
      case 'left of': return { x: a.x - w - a.w * 0.1, y: a.y + a.h - h, w, h }
      case 'right of': return { x: a.x + a.w * 1.1, y: a.y + a.h - h, w, h }
    }
  }
  // Big wide rectangles in a region fill it (sky, sea, ground); anything else sits at its center.
  const regions: Record<string, Box> = {
    'top half of the canvas': { x: 0, y: 0, w: W, h: W / 2 },
    'bottom half of the canvas': { x: 0, y: W / 2, w: W, h: W / 2 },
    'bottom strip of the canvas': { x: 0, y: W * 0.8, w: W, h: W * 0.2 },
    'full canvas': { x: 0, y: 0, w: W, h: W },
  }
  const region = regions[place]
  if (region && (size === 'large' || size === 'huge') && (shape === 'wide rectangle' || place === 'full canvas')) return region
  const i = CANVAS_PLACES.indexOf(place)
  const cx = region ? region.x + region.w / 2 : ((i % 3) * 2 + 1) * (W / 6)
  const cy = region ? region.y + region.h / 2 : (Math.floor(i / 3) * 2 + 1) * (W / 6)
  const [w, h] = dims(shape, OF_CANVAS[size] * W)
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}

/** Grow or shrink sideways around the center; up and down around the bottom, where things rest. */
function adjust(b: Box, how: string): Box {
  const cx = b.x + b.w / 2, bottom = b.y + b.h, step = W * 0.08
  const resize = (fw: number, fh: number) => ({ x: cx - (b.w * fw) / 2, y: bottom - b.h * fh, w: b.w * fw, h: b.h * fh })
  switch (how) {
    case 'wider': return resize(1.3, 1)
    case 'narrower': return resize(1 / 1.3, 1)
    case 'taller': return resize(1, 1.3)
    case 'shorter': return resize(1, 1 / 1.3)
    case 'bigger': return resize(1.25, 1.25)
    case 'smaller': return resize(0.8, 0.8)
    case 'move left': return { ...b, x: b.x - step }
    case 'move right': return { ...b, x: b.x + step }
    case 'move up': return { ...b, y: b.y - step }
    case 'move down': return { ...b, y: b.y + step }
  }
  return b
}

/** An element as actually drawn, in words: what Jev "sees" with feedback on. */
export function geometry(e: Element, all: Element[]): string {
  const { x, y, w, h } = e.box
  const pct = (v: number) => Math.round((v / W) * 100)
  const ratio = h / w
  const aspect = ratio > 1.6 ? `${ratio.toFixed(1)} times taller than wide` : ratio > 1.15 ? 'a bit taller than wide'
    : ratio < 1 / 1.6 ? `${(1 / ratio).toFixed(1)} times wider than tall` : ratio < 1 / 1.15 ? 'a bit wider than tall' : 'about as wide as tall'
  const cx = (x + w / 2) / W, cy = (y + h / 2) / W
  const where = `${cy < 0.33 ? 'top' : cy < 0.67 ? 'middle' : 'bottom'} ${cx < 0.33 ? 'left' : cx < 0.67 ? 'center' : 'right'}`
  const parts = [`${e.color} ${e.shape}, ${pct(w)}% of the canvas wide and ${pct(h)}% tall (${aspect}), centered ${where}`]
  const outside = 1 - overlap(e.box, { x: 0, y: 0, w: W, h: W }) / (area(e.box) || 1)
  if (outside > 0.05) parts.push(`${Math.round(outside * 100)}% of it is off the canvas`)
  const i = all.indexOf(e)
  for (const [j, o] of all.entries()) {
    if (o === e) continue
    const shared = overlap(e.box, o.box)
    const background = area(o.box) > 0.6 * W * W
    if (j > i && shared / (area(e.box) || 1) > 0.1) parts.push(`${Math.round((shared / area(e.box)) * 100)}% of it is hidden behind the ${o.label}`)
    if (j < i && !background && shared / (area(o.box) || 1) > 0.1) parts.push(`covers ${Math.round((shared / area(o.box)) * 100)}% of the ${o.label}`)
    const touching = Math.abs(y + h - o.box.y) < W * 0.02 && Math.min(x + w, o.box.x + o.box.w) > Math.max(x, o.box.x)
    if (touching && !background) parts.push(`sits on top of the ${o.label}`)
  }
  return `${e.label}: ${parts.join('; ')}`
}

/**
 * Jev's top answer, or with temperature > 0 a sample from its top 3. Sampling
 * from all options pulled in ones Jev gave almost no chance, and the pictures
 * fell apart.
 */
function pick(answer: ChoiceAnswer, temperature: number, rand: () => number): string {
  if (temperature <= 0) return answer.choice
  const weights = Object.entries(answer.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, p]) => [k, Math.pow(p, 1 / temperature)] as const)
  let r = rand() * weights.reduce((a, [, w]) => a + w, 0)
  for (const [k, w] of weights) if ((r -= w) <= 0) return k
  return answer.choice
}

export function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export async function draw(subject: string, opts: DrawOptions = {}): Promise<Element[]> {
  const { feedback = true, temperature = 0, rand = Math.random, maxSteps = 12, log = () => {} } = opts
  const drawn: Element[] = []
  const describe = (e: Element) => (feedback ? geometry(e, drawn) : `${e.label}: ${e.color} ${e.shape}, ${e.size}, ${e.place}`)
  const labelFor = (element: string) => {
    const count = drawn.filter((e) => e.label === element || e.label.startsWith(`${element} #`)).length
    return count ? `${element} #${count + 1}` : element
  }

  for (let step = 0; step < maxSteps; step++) {
    const state = {
      task: `Draw ${subject} with simple flat shapes, back to front (later shapes cover earlier ones).`,
      canvas: CANVAS_NOTE,
      drawn_so_far: drawn.length ? drawn.map(describe) : 'Nothing yet, the canvas is empty.',
    }
    const plan = await ask(state, {
      next: {
        type: 'choice',
        instructions: 'What element should be drawn next? Choose "done" if the picture is complete.',
        criteria: { ...options(ELEMENTS), done: 'The picture already shows everything it needs.' },
      },
      complete: { type: 'noul', instructions: `Does the canvas already show ${subject}?` },
    })
    const next = pick(plan.next, temperature, rand)
    if (next === 'done' || plan.complete.noul > 0.95) break

    const places = [...CANVAS_PLACES, ...drawn.flatMap((e) => RELATIONS.map((r) => `${r} the ${e.label}`))]
    const how = await ask({ ...state, drawing_now: next }, {
      shape: { type: 'choice', instructions: `Which shape best draws the ${next}?`, criteria: options(SHAPES) },
      color: { type: 'choice', instructions: `What color is the ${next}?`, criteria: options(Object.keys(COLORS)) },
      place: { type: 'choice', instructions: `Where does the ${next} go?`, criteria: options(places) },
      size: { type: 'choice', instructions: `How big is the ${next}, compared to what it is placed on (or to the canvas)?`, criteria: options(SIZES) },
    })
    const [shape, color, place] = [pick(how.shape, temperature, rand), pick(how.color, temperature, rand), pick(how.place, temperature, rand)]
    const size = pick(how.size, temperature, rand) as (typeof SIZES)[number]
    const element: Element = { label: labelFor(next), shape, color, place, size, box: layout(drawn, shape, place, size), adjusted: [] }
    drawn.push(element)

    // Feedback: show Jev the element as drawn and let it fix size, proportions or position.
    // A yes-or-no question decides whether to touch it at all: offered as one
    // option among eleven, "looks right" almost never won.
    for (let round = 0; feedback && round < 3; round++) {
      const review = await ask(
        {
          task: `Draw ${subject} with simple flat shapes.`,
          canvas: CANVAS_NOTE,
          picture_so_far: drawn.map((e) => geometry(e, drawn)),
          just_drawn: element.label,
          ...(element.adjusted.length && { adjustments_already_made_to_it: element.adjusted }),
        },
        {
          right: {
            type: 'noul',
            instructions: `Are the ${element.label}'s size, proportions and position right for ${subject}?`,
            criteria: { true: 'It fits the rest of the picture as it is.', false: 'Something about its size, proportions or position is clearly off.' },
          },
          adjust: {
            type: 'choice',
            instructions: `If the ${element.label} needs one change to fit ${subject} better, which one?`,
            criteria: ADJUSTMENTS,
          },
        },
      )
      if (review.right.noul >= 0.5) break
      const how = pick(review.adjust, temperature, rand)
      element.box = adjust(element.box, how)
      element.adjusted.push(how)
    }
    log(`${String(step + 1).padStart(2)}. ${describe(element)}${element.adjusted.length ? `  [adjusted: ${element.adjusted.join(', ')}]` : ''}`)
  }
  return fit(drawn)
}

/**
 * Scale up a drawing that came out small. Relative sizes compound ("small,
 * on top of the small stem"), and Jev's adjustments didn't fix it. Background
 * elements stay put; the rest grow around their bottom center, so things keep
 * resting where they were.
 */
function fit(drawn: Element[]): Element[] {
  const subject = drawn.filter((e) => area(e.box) < 0.4 * W * W)
  if (!subject.length) return drawn
  const left = Math.min(...subject.map((e) => e.box.x)), right = Math.max(...subject.map((e) => e.box.x + e.box.w))
  const top = Math.min(...subject.map((e) => e.box.y)), bottom = Math.max(...subject.map((e) => e.box.y + e.box.h))
  const k = Math.min(0.7 * W / (right - left), 0.7 * W / (bottom - top), 3)
  if (k <= 1.15) return drawn
  const cx = (left + right) / 2
  // Keep the bottom where it was, unless that would push the top off the canvas.
  const anchorY = Math.min(bottom, W * 0.95, top + (bottom - top) * k > W ? W : bottom)
  const newTop = anchorY - (bottom - top) * k
  const dy = newTop < W * 0.03 ? W * 0.03 - newTop : 0
  for (const e of subject) {
    const b = e.box
    e.box = { x: W / 2 + (b.x - cx) * k, y: anchorY + dy + (b.y - bottom) * k, w: b.w * k, h: b.h * k }
  }
  return drawn
}

function svgFor({ shape, color, box: { x, y, w, h } }: Element): string {
  // A thin outline, cartoon style, so a white snowman on the white canvas shows.
  const fill = `${COLORS[color]}" stroke="#1a1a1a" stroke-width="2`
  if (shape === 'circle') return `<circle cx="${x + w / 2}" cy="${y + h / 2}" r="${Math.min(w, h) / 2}" fill="${fill}"/>`
  if (shape === 'ellipse') return `<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}" fill="${fill}"/>`
  if (shape === 'triangle') return `<polygon points="${x},${y + h} ${x + w / 2},${y} ${x + w},${y + h}" fill="${fill}"/>`
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`
}

export const render = (drawn: Element[]) =>
  sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}"><rect width="${W}" height="${W}" fill="#fff"/>${drawn.map(svgFor).join('')}</svg>`)).png().toBuffer()

/** Jev picks the best of several pictures, judging from their descriptions. */
export async function judge(subject: string, pictures: Element[][]): Promise<{ index: number; probabilities: number[] }> {
  const criteria = Object.fromEntries(pictures.map((p, i) => [`picture ${i + 1}`, p.map((e) => geometry(e, p))]))
  const answers = await ask(
    { task: `Choose the drawing that best shows ${subject}.`, canvas: CANVAS_NOTE },
    { best: { type: 'choice', instructions: `Which picture best shows ${subject}, judging from what each part is, its size, proportions, position and color?`, criteria } },
  )
  return { index: Number(answers.best.choice.replace('picture ', '')) - 1, probabilities: pictures.map((_, i) => answers.best.probabilities[`picture ${i + 1}`] ?? 0) }
}

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
  const subject = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) ?? 'a house with a sun in the sky'
  const variants = Number(flag('--variants')) || 1
  const temperature = Number(flag('--temperature') ?? 1)
  const rand = seeded(Number(flag('--seed')) || 1)
  const feedback = !args.includes('--no-feedback')
  const dir = `out/shapes-${slugify(subject)}${feedback ? '' : '-no-feedback'}`
  mkdirSync(dir, { recursive: true })

  const pictures: Element[][] = []
  for (let v = 0; v < variants; v++) {
    console.log(`\n-- picture ${v + 1}${v === 0 ? ' (Jev\'s top choices)' : ` (sampled, temperature ${temperature})`}`)
    // The first picture always takes Jev's top answers; the rest sample.
    const drawn = await draw(subject, { feedback, temperature: v === 0 ? 0 : temperature, rand, log: (l) => console.log(l) })
    pictures.push(drawn)
    writeFileSync(`${dir}/picture-${v + 1}.png`, await render(drawn))
  }
  writeFileSync(`${dir}/pictures.json`, JSON.stringify({ subject, feedback, pictures }, null, 2))
  if (variants > 1) {
    const { index, probabilities } = await judge(subject, pictures)
    console.log(`\nJev picks picture ${index + 1}  (${probabilities.map((p, i) => `${i + 1}: ${p.toFixed(2)}`).join(', ')})`)
    writeFileSync(`${dir}/best.png`, await render(pictures[index]))
  }
  console.log(`\n${dir}/`)
  console.log(costLine())
}
