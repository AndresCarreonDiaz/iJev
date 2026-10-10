// Jev picks regions: one yes-or-no question per region, asked in parallel batches.
// Shared by local-edit.ts (what to change) and remove.ts (what to remove, and
// what should show through where it was).
import { ask, type Choice, type Noul } from './jev.ts'
import { describeRegion, nameColor, overview, toLab, type Region, type Segmentation } from './regions.ts'
import { things, type Thing } from './see.ts'

const BATCH = 40

/** What Jev gets about the whole photo: a 6x6 grid of color names, plus Claude's list of what is in it. */
export async function photoContext(path: string, log: (line: string) => void = () => {}) {
  const grid = await overview(path)
  const inPhoto = process.env.NO_EYES ? undefined : uniqueThings(await things(path))
  if (inPhoto) log(`claude sees: ${inPhoto.map((t) => t.thing).join(', ')}`)
  return { photo_overview_top_to_bottom: grid, ...(inPhoto && { things_in_the_photo: inPhoto }) }
}

/** Ask the same yes-or-no question about each region; returns Jev's probability of yes per region id. */
export async function askEach(seg: Segmentation, ids: number[], state: object, question: string, yes: string, no: string): Promise<Map<number, number>> {
  const p = new Map<number, number>()
  const batches: number[][] = []
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH))
  await Promise.all(batches.map(async (batch) => {
    const questions: Record<string, Noul> = {}
    for (const id of batch) {
      questions[`r${id}`] = { type: 'noul', instructions: { question, region: describeRegion(seg.regions[id], seg.regions) }, criteria: { true: yes, false: no } }
    }
    const answers = await ask({ ...state, note: 'The photo is cut into small regions; each question describes one.' }, questions)
    for (const id of batch) p.set(id, answers[`r${id}`].noul)
  }))
  return p
}

/** Each region's answer nudged toward its neighbors' (Jev judges regions one at a time). */
export function smooth(regions: Region[], p: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>()
  for (const [id, v] of p) {
    const n = [...regions[id].neighbors].filter((k) => p.has(k))
    out.set(id, n.length ? 0.6 * v + (0.4 * n.reduce((a, k) => a + p.get(k)!, 0)) / n.length : v)
  }
  return out
}

/**
 * Where Jev's answers split into a "yes" and a "no" group (Otsu), weighted by
 * region size: its probabilities sit in a narrow band, so a fixed 0.5 cut
 * selected far too much or too little.
 */
export function splitPoint(values: number[], weights: number[]): number {
  let best = 0.5, bestScore = -1
  for (let t = 0.05; t < 0.95; t += 0.01) {
    let w0 = 0, w1 = 0, s0 = 0, s1 = 0
    values.forEach((v, i) => (v < t ? ((w0 += weights[i]), (s0 += v * weights[i])) : ((w1 += weights[i]), (s1 += v * weights[i]))))
    if (!w0 || !w1) continue
    const score = w0 * w1 * (s0 / w0 - s1 / w1) ** 2
    if (score > bestScore) { bestScore = score; best = t }
  }
  return best
}

/** Ask, smooth, cut: the set of region ids Jev says yes to. */
export async function choose(seg: Segmentation, ids: number[], state: object, question: string, yes: string, no: string) {
  const p = smooth(seg.regions, await askEach(seg, ids, state, question, yes, no))
  const cut = splitPoint(ids.map((id) => p.get(id)!), ids.map((id) => seg.regions[id].size))
  return { chosen: new Set(ids.filter((id) => p.get(id)! >= cut)), p, cut }
}

/** The regions showing what an instruction is about, as it looks now. */
export function selectThing(seg: Segmentation, instruction: string, context: object) {
  return choose(
    seg,
    seg.regions.map((r) => r.id),
    { instruction, ...context },
    `The instruction is "${instruction}". Does this region show the thing the instruction is about, as it looks now, before any change? ` +
      'Ignore the new color or look the instruction asks for: that is the result, not what the thing looks like now.',
    'This region shows (part of) the object or area the instruction is about.',
    'This region shows something else.',
  )
}

/**
 * Keep only the connected pieces Jev is most sure about. The selection for one
 * object spread to other dark things (a phone, laptop keys) at a lower score;
 * the object itself is one or a few blobs with the highest scores.
 */
export function strongestPieces(seg: Segmentation, chosen: Set<number>, p: Map<number, number>, slack = 0.05): Set<number> {
  const pieces: number[][] = []
  const seen = new Set<number>()
  for (const start of chosen) {
    if (seen.has(start)) continue
    const piece: number[] = []
    const stack = [start]
    seen.add(start)
    while (stack.length) {
      const id = stack.pop()!
      piece.push(id)
      for (const n of seg.regions[id].neighbors) if (chosen.has(n) && !seen.has(n)) { seen.add(n); stack.push(n) }
    }
    pieces.push(piece)
  }
  // A piece's score: its regions' answers, weighted by size.
  const score = (piece: number[]) => {
    const w = piece.reduce((a, id) => a + seg.regions[id].size, 0)
    return piece.reduce((a, id) => a + p.get(id)! * seg.regions[id].size, 0) / w
  }
  const best = Math.max(...pieces.map(score))
  return new Set(pieces.filter((piece) => score(piece) >= best - slack).flat())
}

/**
 * Classify every region as one of the things Claude listed (or something else).
 * A yes-or-no per region never made Jev compare: for "the coffee cup" it said
 * yes to the whole corner, wooden table included. Choosing among named things,
 * the table regions go to the table.
 */
export async function classify(seg: Segmentation, list: Thing[], context: object): Promise<Map<number, Record<string, number>>> {
  const criteria: Record<string, string> = Object.fromEntries(list.map((t) => [t.thing, `${t.color}; ${t.where}${t.box ? `; box ${t.box.join(', ')}` : ''}`]))
  criteria['something else'] = 'None of the listed things.'
  // Rough boxes from Claude, in percent: which ones a region's center falls in.
  const inside = (r: Region) =>
    list.filter((t) => t.box && r.x * 100 >= t.box[0] - 2 && r.x * 100 <= t.box[2] + 2 && r.y * 100 >= t.box[1] - 2 && r.y * 100 <= t.box[3] + 2).map((t) => t.thing)
  // Each option also says how deep inside its box this region sits, and how big
  // the box is: a region in the middle of a small phone box is most likely phone,
  // even when its colors look like the book under it.
  const depth = (r: Region, t: Thing) => {
    const [l, tp, rt, b] = t.box!
    const d = Math.min((r.x * 100 - l) / (rt - l), (rt - r.x * 100) / (rt - l), (r.y * 100 - tp) / (b - tp), (b - r.y * 100) / (b - tp)) * 2
    const size = ((rt - l) * (b - tp)) / 100
    return `${d > 0.5 ? 'well inside' : d > 0.2 ? 'inside, toward the edge of' : 'at the edge of'} its box, which covers ${Math.max(1, Math.round(size))}% of the photo`
  }
  // Only the things whose box holds the region are options: inside the cup's box
  // that is about "cup or table", which Jev gets right far more often than a
  // pick among everything in the photo.
  const optionsFor = (r: Region, extra: (thing: string) => string = () => '') => {
    const boxes = inside(r)
    return boxes.length
      ? Object.fromEntries([
          ...boxes.map((k) => [k, `${criteria[k]}; this region is ${depth(r, list.find((t) => t.thing === k)!)}${extra(k)}`]),
          ['something else', criteria['something else']],
        ])
      : criteria
  }
  const run = async (ids: number[], question: (r: Region) => Choice) => {
    const out = new Map<number, Record<string, number>>()
    const batches: number[][] = []
    for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH))
    await Promise.all(batches.map(async (batch) => {
      const questions: Record<string, Choice> = Object.fromEntries(batch.map((id) => [`r${id}`, question(seg.regions[id])]))
      const answers = await ask({ ...context, note: 'The photo is cut into small regions; each question describes one.' }, questions)
      for (const id of batch) out.set(id, answers[`r${id}`].probabilities)
    }))
    return out
  }

  const first = await run(seg.regions.map((r) => r.id), (r) => ({
    type: 'choice',
    instructions: { question: 'Which of these things does this region show?', region: describeRegion(r, seg.regions) },
    criteria: optionsFor(r),
  }))

  // Second pass for the unsure regions, anchored on Jev's own sure answers: in a
  // dark photo it called the shaded white cup's "light gray" regions table, though
  // every region it was sure was table is orange.
  const sure = new Map<string, number[]>()
  for (const [id, probs] of first) {
    const [top, p] = Object.entries(probs).sort((a, b) => b[1] - a[1])[0]
    if (p >= 0.8 && top !== 'something else') sure.set(top, [...(sure.get(top) ?? []), id])
  }
  const looks = new Map<string, { lab: [number, number, number]; names: string }>()
  for (const [thing, ids] of sure) {
    const w = ids.reduce((a, id) => a + seg.regions[id].size, 0)
    const lab = [0, 1, 2].map((c) => ids.reduce((a, id) => a + toLab(...seg.regions[id].rgb)[c] * seg.regions[id].size, 0) / w) as [number, number, number]
    const counts = new Map<string, number>()
    for (const id of ids) { const n = nameColor(...seg.regions[id].rgb); counts.set(n, (counts.get(n) ?? 0) + 1) }
    looks.set(thing, { lab, names: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n).join(', ') })
  }
  const unsure = [...first].filter(([id, probs]) => Math.max(...Object.values(probs)) < 0.7 && inside(seg.regions[id]).length > 1).map(([id]) => id)
  const second = await run(unsure, (r) => {
    const lab = toLab(...r.rgb)
    const closest = inside(r)
      .filter((k) => looks.has(k))
      .sort((a, b) => dist(lab, looks.get(a)!.lab) - dist(lab, looks.get(b)!.lab))
    return {
      type: 'choice',
      instructions: {
        question: 'Which of these things does this region show?',
        region: describeRegion(r, seg.regions),
        ...(closest.length && { closest_in_color_to_the_regions_already_labeled: closest[0] }),
      },
      criteria: optionsFor(r, (k) => (looks.has(k) ? `; regions already labeled this look ${looks.get(k)!.names}` : '')),
    }
  })
  for (const [id, probs] of second) first.set(id, probs)
  return first
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** Which of the listed things a question applies to: one yes-or-no per thing, in one request. */
export async function whichThings(list: Thing[], state: object, question: (thing: Thing) => string): Promise<Set<string>> {
  const questions: Record<string, Noul> = Object.fromEntries(list.map((t, i) => [`t${i}`, { type: 'noul', instructions: { question: question(t), thing: t } }]))
  const answers = await ask(state, questions)
  return new Set(list.filter((_, i) => answers[`t${i}`].noul >= 0.5).map((t) => t.thing))
}

/**
 * Regions whose most likely class is one of the given things (after smoothing
 * with neighbors). A 0.5 cut found nothing for a small cup: each region spreads
 * its probability over several things.
 */
export function regionsOf(seg: Segmentation, classes: Map<number, Record<string, number>>, names: Set<string>): { chosen: Set<number>; p: Map<number, number> } {
  const share = new Map<number, number>()
  const rival = new Map<number, number>()
  for (const [id, probs] of classes) {
    share.set(id, [...names].reduce((a, n) => a + (probs[n] ?? 0), 0))
    rival.set(id, Math.max(0, ...Object.entries(probs).filter(([n]) => !names.has(n)).map(([, v]) => v)))
  }
  const p = smooth(seg.regions, share)
  const q = smooth(seg.regions, rival)
  return { chosen: new Set([...p].filter(([id, v]) => v > q.get(id)!).map(([id]) => id)), p }
}

/** Unique names, since Jev's answers come back keyed by them. */
export function uniqueThings(list: Thing[]): Thing[] {
  const seen = new Map<string, number>()
  return list.map((t) => {
    const n = (seen.get(t.thing) ?? 0) + 1
    seen.set(t.thing, n)
    return n === 1 ? t : { ...t, thing: `${t.thing} (${n})` }
  })
}
