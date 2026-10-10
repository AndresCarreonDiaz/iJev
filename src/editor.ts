// The photo editor behind edit.ts and bench-edit.ts.
// The jevvium loop: code "reads the screen" (turns the photo into numbers,
// labels and a coarse grid of color names), Jev picks one edit and how strong,
// code applies it with sharp, repeat.
//
// Who decides when to stop:
//   jev      Jev, by choosing "done" or saying the goal is met.
//   checks   Ranges written by hand (a criteria file's `expect`).
//   targets  Ranges Jev picks once at the start, from the goal and the photo.
//   oracle   Ranges around the original photo's own numbers (benchmark ceiling).
// In every mode but jev, code keeps an edit only if it gets the photo closer
// to its ranges; otherwise it tries a smaller step, then Jev's next choice.
import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import { ask, type ChoiceAnswer } from './jev.ts'

export type Raw = { data: Buffer; width: number; height: number }
export const METRICS = ['brightness', 'contrast', 'saturation', 'warmth', 'shadows', 'highlights'] as const
export type Metric = (typeof METRICS)[number]
export type Measures = Record<Metric, number>
export type Ranges = Partial<Record<Metric, [number, number]>>
export type Mode = 'jev' | 'checks' | 'targets' | 'oracle'
type Strength = 'small' | 'medium' | 'large'

const EDITS: Record<string, string> = {
  brighter: 'Raise overall brightness.',
  darker: 'Lower overall brightness.',
  'more contrast': 'Make darks darker and lights lighter.',
  'less contrast': 'Flatten the tones, softer look.',
  'more saturated': 'Make colors more vivid.',
  'less saturated': 'Make colors more muted.',
  warmer: 'Shift colors toward orange and yellow.',
  cooler: 'Shift colors toward blue.',
  'black and white': 'Remove all color.',
  sepia: 'Brown-toned vintage look.',
  'crop to square': 'Crop the center to a 1:1 square.',
  done: 'The photo already meets the goal; stop editing.',
}
const STRENGTHS: Record<Strength, string> = {
  small: 'A gentle nudge, for fine-tuning when the photo is nearly right.',
  medium: 'A clear change.',
  large: 'A big change, for a photo that is far off.',
}
/** small, medium, large factor for each edit that has a strength. */
const FACTORS: Record<string, [number, number, number]> = {
  brighter: [1.07, 1.15, 1.32],
  darker: [0.93, 0.87, 0.76],
  'more contrast': [1.1, 1.2, 1.4],
  'less contrast': [0.92, 0.85, 0.72],
  'more saturated': [1.12, 1.25, 1.5],
  'less saturated': [0.9, 0.8, 0.65],
  warmer: [0.5, 1, 2],
  cooler: [0.5, 1, 2],
}
const LEVEL: Record<Strength, number> = { small: 0, medium: 1, large: 2 }

/**
 * What real photos measure like (calibration.json, from a separate photo set).
 * The first version's labels were tuned on one vivid wallpaper and called most
 * real photos "dull": their median saturation is 0.12, not 0.4.
 */
type Percentiles = Record<'p5' | 'p10' | 'p20' | 'p35' | 'p50' | 'p65' | 'p80' | 'p90' | 'p95', number>
type Tone = 'brightness' | 'contrast' | 'saturation' | 'warmth'
export const CALIBRATION: Record<Tone, Percentiles> = JSON.parse(readFileSync(new URL('../calibration.json', import.meta.url), 'utf8'))
const C = CALIBRATION

/** The middle of the real-photo range: what "typical" means for each number. */
export const typicalRanges = (): Ranges => ({
  brightness: [C.brightness.p20, C.brightness.p80],
  contrast: [C.contrast.p20, C.contrast.p80],
  saturation: [C.saturation.p20, C.saturation.p80],
  warmth: [C.warmth.p20, C.warmth.p80],
})

/**
 * Ordered levels Jev scores the finished photo on, and the range each level
 * means. The middle three come from real photos; the ends are styles.
 */
const TARGET_LEVELS: Record<Tone, { question: string; levels: [string, [number, number]][] }> = {
  brightness: {
    question: 'How bright should the finished photo be overall?',
    levels: [
      ['Very dark: a night or low-key shot.', [20, C.brightness.p10]],
      ['Darker than most photos, moody.', [C.brightness.p5, C.brightness.p35]],
      ['Like most photos.', [C.brightness.p20, C.brightness.p80]],
      ['Brighter than most photos, airy.', [C.brightness.p65, C.brightness.p95]],
      ['Very bright, high-key.', [C.brightness.p90, 235]],
    ],
  },
  contrast: {
    question: 'How much contrast should the finished photo have?',
    levels: [
      ['Very soft, hazy.', [5, C.contrast.p5]],
      ['Softer than most photos.', [C.contrast.p5, C.contrast.p35]],
      ['Like most photos.', [C.contrast.p20, C.contrast.p80]],
      ['Punchier than most photos.', [C.contrast.p65, C.contrast.p95]],
      ['Dramatic: deep blacks and bright whites.', [C.contrast.p90, 110]],
    ],
  },
  saturation: {
    question: 'How colorful should the finished photo be?',
    levels: [
      ['No color at all: black and white.', [0, 0.03]],
      ['More muted than most photos.', [C.saturation.p5, C.saturation.p35]],
      ['Like most photos.', [C.saturation.p20, C.saturation.p80]],
      ['More colorful than most photos.', [C.saturation.p65, C.saturation.p95]],
      ['Very vivid, saturated colors.', [C.saturation.p90, 0.5]],
    ],
  },
  warmth: {
    question: 'How warm or cool should the colors of the finished photo be?',
    levels: [
      ['Very cool, blue.', [-90, C.warmth.p10]],
      ['Cooler than most photos.', [C.warmth.p5, C.warmth.p35]],
      ['Like most photos.', [C.warmth.p20, C.warmth.p80]],
      ['Warmer than most photos.', [C.warmth.p65, C.warmth.p95]],
      ['Very warm, golden or orange.', [C.warmth.p90, 100]],
    ],
  },
}
/** Oracle ranges: the original's own numbers, give or take this much. */
const ORACLE_TOLERANCE: Record<Tone, number> = { brightness: 10, contrast: 6, saturation: 0.04, warmth: 8 }

export async function load(path: string): Promise<Raw> {
  const { data, info } = await sharp(path).rotate().resize({ width: 768, withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

export const pipe = (img: Raw) => sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } })

export async function finish(s: sharp.Sharp): Promise<Raw> {
  const { data, info } = await s.removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/**
 * Brightness and contrast work on luminance only and move every channel by the
 * same amount, so each edit changes one number: color cast and saturation stay
 * put. Earlier versions were tangled: a per-channel contrast stretch also
 * warmed the photo, contrast around mid-gray darkened dark photos, and a
 * multiplicative "darker" also lowered contrast.
 */
function shiftLuma(img: Raw, shiftFor: (luma: number, mean: number) => number): Raw {
  const luma = (i: number) => 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
  let sum = 0
  for (let i = 0; i < img.data.length; i += 3) sum += luma(i)
  const mean = sum / (img.data.length / 3)
  const out = new Uint8ClampedArray(img.data.length)
  for (let i = 0; i < img.data.length; i += 3) {
    const shift = shiftFor(luma(i), mean)
    out[i] = img.data[i] + shift
    out[i + 1] = img.data[i + 1] + shift
    out[i + 2] = img.data[i + 2] + shift
  }
  return { data: Buffer.from(out.buffer), width: img.width, height: img.height }
}
/** Contrast around the photo's own average, so overall brightness stays put. */
const lumaContrast = (img: Raw, k: number) => shiftLuma(img, (l, mean) => (l - mean) * (k - 1))
/** The same shift for every pixel, so contrast stays put. */
const lumaBrightness = (img: Raw, k: number) => shiftLuma(img, (_, mean) => mean * (k - 1))

// Each edit is its own sharp pass: sharp reorders operations inside one pipeline.
export async function apply(img: Raw, edit: string, strength: Strength = 'medium'): Promise<Raw> {
  const f = FACTORS[edit]?.[LEVEL[strength]] ?? 1
  const gray = [0.299, 0.587, 0.114]
  switch (edit) {
    case 'brighter':
    case 'darker': return lumaBrightness(img, f)
    case 'more contrast':
    case 'less contrast': return lumaContrast(img, f)
    case 'more saturated':
    case 'less saturated': return finish(pipe(img).modulate({ saturation: f }))
    case 'warmer': return finish(pipe(img).recomb([[1 + 0.08 * f, 0, 0], [0, 1 + 0.01 * f, 0], [0, 0, 1 - 0.1 * f]]))
    case 'cooler': return finish(pipe(img).recomb([[1 - 0.08 * f, 0, 0], [0, 1, 0], [0, 0, 1 + 0.08 * f]]))
    case 'black and white': return finish(pipe(img).recomb([gray, gray, gray]))
    case 'sepia': return finish(pipe(img).recomb([[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]]))
    case 'crop to square': {
      const side = Math.min(img.width, img.height)
      return finish(pipe(img).extract({ left: (img.width - side) >> 1, top: (img.height - side) >> 1, width: side, height: side }))
    }
  }
  throw new Error(`unknown edit ${edit}`)
}

export async function measure(img: Raw): Promise<Measures> {
  const small = await finish(pipe(img).resize(96, 96, { fit: 'fill' }))
  let sumL = 0, sumL2 = 0, sumC = 0, sumR = 0, sumB = 0, black = 0, white = 0
  const n = small.data.length / 3
  for (let i = 0; i < small.data.length; i += 3) {
    const [r, g, b] = [small.data[i], small.data[i + 1], small.data[i + 2]]
    const luma = 0.299 * r + 0.587 * g + 0.114 * b
    // Chroma, not HSV saturation: HSV calls dark pixels vivid.
    sumL += luma; sumL2 += luma * luma; sumC += (Math.max(r, g, b) - Math.min(r, g, b)) / 255; sumR += r; sumB += b
    if (luma < 12) black++
    if (luma > 243) white++
  }
  const brightness = sumL / n
  return {
    brightness,
    contrast: Math.sqrt(Math.max(0, sumL2 / n - brightness ** 2)),
    saturation: sumC / n,
    warmth: (sumR - sumB) / n,
    shadows: (black / n) * 100,
    highlights: (white / n) * 100,
  }
}

function nameColor(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255
  const l = (max + min) / 2, d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (s < 0.15 || d < 0.08) return l < 0.15 ? 'black' : l < 0.35 ? 'dark gray' : l < 0.65 ? 'gray' : l < 0.85 ? 'light gray' : 'white'
  const tone = l < 0.2 ? 'very dark ' : l < 0.38 ? 'dark ' : l < 0.65 ? '' : l < 0.85 ? 'light ' : 'very light '
  const [R, G, B] = [r / 255, g / 255, b / 255]
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  h = (h * 60 + 360) % 360
  const hue = h < 15 ? 'red' : h < 40 ? 'orange' : h < 65 ? 'yellow' : h < 160 ? 'green' : h < 200 ? 'cyan' : h < 255 ? 'blue' : h < 290 ? 'purple' : h < 335 ? 'pink' : 'red'
  return tone + hue
}

const round = (v: number) => (Math.abs(v) < 1 ? v.toFixed(2) : String(Math.round(v)))
/** Where a number sits among real photos, in words, with the usual range. */
function relative(v: number, p: Percentiles, [lower, higher]: [string, string]): string {
  const usual = `(most photos: ${round(p.p10)} to ${round(p.p90)})`
  if (v < p.p5) return `much ${lower} than most photos ${usual}`
  if (v < p.p20) return `${lower} than most photos ${usual}`
  if (v <= p.p80) return `typical ${usual}`
  if (v <= p.p95) return `${higher} than most photos ${usual}`
  return `much ${higher} than most photos ${usual}`
}

/** The photo as text: what Jev "sees". */
export async function describe(img: Raw, m: Measures) {
  const grid = await finish(pipe(img).resize(5, 5, { fit: 'fill' }))
  const rows: string[] = []
  for (let y = 0; y < 5; y++) {
    const cells = []
    for (let x = 0; x < 5; x++) cells.push(nameColor(...([0, 1, 2].map((c) => grid.data[(y * 5 + x) * 3 + c]) as [number, number, number])))
    rows.push(cells.join(' | '))
  }
  return {
    size: `${img.width}x${img.height} (${img.width === img.height ? 'square' : img.width > img.height ? 'landscape' : 'portrait'})`,
    brightness: `${Math.round(m.brightness)}/255, ${relative(m.brightness, C.brightness, ['darker', 'brighter'])}`,
    contrast: `${Math.round(m.contrast)}, ${relative(m.contrast, C.contrast, ['flatter', 'punchier'])}`,
    saturation: m.saturation < 0.03 ? `${m.saturation.toFixed(2)}, no color (black and white)` : `${m.saturation.toFixed(2)}, ${relative(m.saturation, C.saturation, ['more muted', 'more colorful'])}`,
    color_cast: `${Math.round(m.warmth)} (red minus blue), ${relative(m.warmth, C.warmth, ['cooler', 'warmer'])}`,
    clipped_shadows: `${m.shadows.toFixed(1)}% of pixels pure black`,
    clipped_highlights: `${m.highlights.toFixed(1)}% of pixels pure white`,
    color_grid_top_to_bottom: rows,
  }
}

const fmt = (k: Metric, v: number) => (k === 'saturation' ? v.toFixed(2) : k === 'shadows' || k === 'highlights' ? `${v.toFixed(1)}%` : String(Math.round(v)))
/** Precise enough that a failing value never prints as its own limit. */
const exact = (k: Metric, v: number) => (k === 'saturation' ? v.toFixed(3) : v.toFixed(1))

/** How far the photo is from its ranges, in range widths. 0 means every check passes. */
export function gap(m: Measures, ranges: Ranges): number {
  let total = 0
  for (const [k, [lo, hi]] of Object.entries(ranges) as [Metric, [number, number]][]) {
    total += Math.max(0, lo - m[k], m[k] - hi) / (hi - lo || 1)
  }
  return total
}

export function failing(m: Measures, ranges: Ranges): string[] {
  return (Object.entries(ranges) as [Metric, [number, number]][])
    .filter(([k, [lo, hi]]) => m[k] < lo || m[k] > hi)
    .map(([k, [lo, hi]]) => `${k} ${exact(k, m[k])} (want ${lo} to ${hi})`)
}

export const showRanges = (r: Ranges) =>
  (Object.entries(r) as [Metric, [number, number]][]).map(([k, [lo, hi]]) => `${k} ${fmt(k, lo)}..${fmt(k, hi)}`).join(', ')

/** Mean absolute difference per channel (0-255). */
export async function distance(a: Raw, b: Raw): Promise<number> {
  const [x, y] = await Promise.all([a, b].map((img) => finish(pipe(img).resize(128, 128, { fit: 'fill' }))))
  let sum = 0
  for (let i = 0; i < x.data.length; i++) sum += Math.abs(x.data[i] - y.data[i])
  return sum / x.data.length
}

/**
 * Jev picks, for each number, either "keep as it is" or a level for the
 * finished photo; code turns the pick into a range. "Keep" exists because a
 * level forced on a photo that was already fine (say "softer than most" for a
 * photo described as soft but measuring typical) made it edit good photos.
 */
export async function chooseTargets(
  goal: string,
  now: Measures,
  photo: unknown,
  seen?: Record<string, string>,
): Promise<{ ranges: Ranges; picked: Record<string, string>; levels: Record<string, number> }> {
  const KEEP = 'keep as it is'
  const questions = Object.fromEntries(
    Object.entries(TARGET_LEVELS).map(([k, t]) => [
      k,
      {
        type: 'choice' as const,
        instructions: `The goal is: "${goal}". ${t.question}`,
        criteria: {
          [KEEP]: `The ${k} is already right for the goal; leave it.`,
          ...Object.fromEntries(t.levels.map(([label], i) => [`level ${i}`, label])),
        },
      },
    ]),
  )
  const answers = await ask({ goal, photo_now: photo, ...(seen && { someone_who_saw_the_photo_said: seen }) }, {
    ...questions,
    // First decision: whether to touch the photo at all.
    needs_edit: {
      type: 'noul' as const,
      instructions: `The goal is: "${goal}". Does the photo need any edit to meet it?`,
      criteria: { true: 'Something about it is clearly off for the goal.', false: 'It already meets the goal; editing would only change a good photo.' },
    },
  })
  const ranges: Ranges = {}
  const picked: Record<string, string> = {}
  const levels: Record<string, number> = {}
  const leaveAlone = answers.needs_edit.noul < 0.5
  for (const [k, t] of Object.entries(TARGET_LEVELS) as [Tone, (typeof TARGET_LEVELS)[Tone]][]) {
    const choice = leaveAlone ? KEEP : (answers[k] as ChoiceAnswer).choice
    if (choice === KEEP) {
      ranges[k] = [+(now[k] - ORACLE_TOLERANCE[k]).toFixed(3), +(now[k] + ORACLE_TOLERANCE[k]).toFixed(3)]
      picked[k] = KEEP
      levels[k] = -1
    } else {
      const level = Number(choice.replace('level ', ''))
      ranges[k] = t.levels[level][1]
      picked[k] = t.levels[level][0]
      levels[k] = level
    }
  }
  return { ranges, picked, levels }
}

export function oracleRanges(reference: Measures): Ranges {
  const r: Ranges = {}
  for (const [k, tol] of Object.entries(ORACLE_TOLERANCE) as [keyof typeof ORACLE_TOLERANCE, number][]) {
    r[k] = [+(reference[k] - tol).toFixed(3), +(reference[k] + tol).toFixed(3)]
  }
  return r
}

export type Step = {
  step: number
  measures: Measures
  jev: { edit: string; strength: string; probability: number; goal_met: number }
  applied?: { edit: string; strength: Strength }
  rejected?: string[]
  note: string
}

export type EditResult = {
  img: Raw
  outcome: 'passed' | 'stuck' | 'out of steps' | 'jev stopped'
  applied: { edit: string; strength: Strength }[]
  ranges?: Ranges
  picked?: Record<string, string>
  overrides: number
  steps: Step[]
}

export async function edit(options: {
  photo: Raw
  goal: string
  mode: Mode
  ranges?: Ranges
  reference?: Raw
  /** What someone who looked at the photo said about it before any edits (see.ts). */
  seen?: Record<string, string>
  maxSteps?: number
  log?: (line: string) => void
  onStep?: (img: Raw, step: Step) => Promise<void> | void
}): Promise<EditResult> {
  const { goal, mode, log = () => {} } = options
  let img = options.photo
  const start = await measure(img)
  let ranges: Ranges | undefined
  let picked: Record<string, string> | undefined
  // Clipping allowed on top of what the photo already has. Punchy or dramatic
  // contrast means some pure blacks and whites, so it gets more room.
  let clipping = 3
  if (mode === 'checks') ranges = options.ranges
  if (mode === 'targets') {
    const chosen = await chooseTargets(goal, start, await describe(img, start), options.seen)
    ;({ ranges, picked } = chosen)
    if (chosen.levels.contrast >= 3) clipping = 10
  }
  if (mode === 'oracle') {
    if (!options.reference) throw new Error('oracle mode needs a reference photo')
    ranges = oracleRanges(await measure(options.reference))
  }
  if (ranges) {
    ranges = { highlights: [0, Math.max(clipping, Math.ceil(start.highlights))], shadows: [0, Math.max(clipping, Math.ceil(start.shadows))], ...ranges }
    log(`   ranges: ${showRanges(ranges)}`)
  }

  const applied: EditResult['applied'] = []
  const steps: Step[] = []
  let overrides = 0
  let lastEffect: string | undefined
  let outcome: EditResult['outcome'] = 'out of steps'

  for (let n = 1; n <= (options.maxSteps ?? 10); n++) {
    const m = await measure(img)
    const answers = await ask(
      { goal, photo: await describe(img, m), ...(options.seen && { before_any_edits_someone_who_saw_the_photo_said: options.seen }), edits_applied_so_far: applied.map((a) => `${a.edit} (${a.strength})`), ...(lastEffect && { last_edit_effect: lastEffect }) },
      {
        edit: { type: 'choice', instructions: `Which single edit brings the photo closer to the goal: "${goal}"?`, criteria: EDITS },
        strength: { type: 'choice', instructions: `How strong should the next edit toward "${goal}" be?`, criteria: STRENGTHS },
        goal_met: {
          type: 'noul',
          instructions: `Does the photo, as described, already meet the goal: "${goal}"?`,
          criteria: {
            true: 'Every measurement already fits the goal, and any further edit would push one of them too far.',
            false: 'At least one measurement is still clearly off for the goal.',
          },
        },
      },
    )
    const choice = answers.edit.choice
    const strength = answers.strength.choice as Strength
    const step: Step = {
      step: n,
      measures: m,
      jev: { edit: choice, strength, probability: answers.edit.probabilities[choice] ?? 0, goal_met: answers.goal_met.noul },
      note: '',
    }
    steps.push(step)
    const said = `jev: ${choice} ${step.jev.probability.toFixed(2)} ${strength}, goal_met ${step.jev.goal_met.toFixed(2)}`

    if (ranges && gap(m, ranges) === 0) {
      // Jev was still asked, so the trace shows whether it would have stopped here too.
      step.note = 'checks pass'
      log(`${String(n).padStart(2)}. checks pass, stop  (${said})`)
      outcome = 'passed'
      break
    }

    if (!ranges) {
      if (choice === 'done' || step.jev.goal_met > 0.9) {
        step.note = 'jev stops'
        log(`${String(n).padStart(2)}. jev stops  (${said})`)
        outcome = 'jev stopped'
        break
      }
      img = await apply(img, choice, strength)
      step.applied = { edit: choice, strength }
    } else {
      // Jev's top edits in its own order, each at its strength and then gentler;
      // keep the first that gets closer to the ranges.
      const before = gap(m, ranges)
      const ranked = Object.entries(answers.edit.probabilities).sort((p, q) => q[1] - p[1]).map(([e]) => e)
      const rejected: string[] = choice === 'done' ? ['done'] : []
      for (const e of ranked.filter((x) => x !== 'done').slice(0, 3)) {
        const strengths = FACTORS[e] ? (['large', 'medium', 'small'] as Strength[]).slice(2 - LEVEL[strength]) : (['medium'] as Strength[])
        for (const s of strengths) {
          const next = await apply(img, e, s)
          const nm = await measure(next)
          if (gap(nm, ranges) < before - 1e-6) {
            step.applied = { edit: e, strength: s }
            img = next
            break
          }
          rejected.push(`${e} ${s} (${failing(nm, ranges).join(', ')})`)
        }
        if (step.applied) break
      }
      step.rejected = rejected
      if (!step.applied) {
        step.note = 'stuck'
        log(`${String(n).padStart(2)}. stuck, nothing Jev ranked high gets closer: ${rejected.join('; ')}  (${said})`)
        outcome = 'stuck'
        break
      }
      if (step.applied.edit !== choice) overrides++
    }

    applied.push(step.applied!)
    const after = await measure(img)
    const changed = METRICS.filter((k) => fmt(k, after[k]) !== fmt(k, m[k])).map((k) => `${k} ${fmt(k, m[k])} -> ${fmt(k, after[k])}`)
    lastEffect = `${step.applied!.edit} (${step.applied!.strength}): ${changed.join('; ') || 'no measurable change'}`
    const rejectedNote = step.rejected?.length ? `  rejected ${step.rejected.join('; ')}` : ''
    log(`${String(n).padStart(2)}. ${step.applied!.edit} ${step.applied!.strength}${rejectedNote}  (${said})`)
    await options.onStep?.(img, step)
  }

  return { img, outcome, applied, ranges, picked, overrides, steps }
}
