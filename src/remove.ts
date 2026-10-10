// Remove an object: Jev decides what goes and what shows through; code fills the hole.
//
// Code eyes (the default, no models): the retina (retina.ts) turns the photo into
// a letter map and legend; for each letter Jev decides remove, fill from, or keep.
//
// Claude eyes (--eyes claude):
// 1. Claude lists the things in the photo with rough boxes (see.ts).
// 2. Jev picks which things go ("the cup, and its saucer") and which continue
//    behind them ("the wooden table").
// 3. Around each removed thing's box, code groups the pixels by color and
//    describes each group (color, share of the box, how much of it lies outside
//    the box, middle or edges). Jev says which thing each group is. Per-region
//    questions failed here: "light gray, some texture" doesn't say saucer, and
//    Jev confidently called it table.
// 4. Code fills the hole from the outside in with patches copied only from the
//    groups Jev said continue behind, in colors that match the hole's rim.
//
//   node src/remove.ts samples/photos/8.jpg "Remove the coffee cup" [--eyes code|claude]
import { mkdirSync } from 'node:fs'
import { basename, extname } from 'node:path'
import sharp from 'sharp'
import { ask, costLine, type Choice } from './jev.ts'
import { nameColor, segment, toLab } from './regions.ts'
import { choose, photoContext, selectThing, strongestPieces, whichThings } from './select.ts'
import type { Thing } from './see.ts'
import { describe as describeSight, see as retina } from './retina.ts'

const WORK = 1024 // work and fill at this width
const R = 4 // patch radius: 9x9 patches
const WINDOW = 140 // look for patches this far around each spot first
const GROUPS = 7 // color groups per box

const args = process.argv.slice(2)
const eyes = args.includes('--eyes') ? args[args.indexOf('--eyes') + 1] : 'code'
const [input, instruction] = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--eyes')
if (!input || !instruction || !['code', 'claude'].includes(eyes)) {
  console.error('usage: node src/remove.ts <photo> "Remove the ..." [--eyes code|claude]')
  process.exit(1)
}
const started = performance.now()
const context: Awaited<ReturnType<typeof photoContext>> = eyes === 'claude' ? await photoContext(input, (line) => console.log(line)) : { photo_overview_top_to_bottom: [] }
const { data: work, info: wi } = await sharp(input).rotate().resize({ width: WORK, withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
const W = wi.width, H = wi.height
const unknown = new Uint8Array(W * H) // the hole
const fromHere = new Uint8Array(W * H) // where patches may come from
const near = new Uint8Array(W * H) // where the hole may grow by color (around the boxes)

const list = context.things_in_the_photo
let goneThings: Thing[] = []
let throughThings: Thing[] = []
if (list) {
  const state = { instruction, ...context }
  const [gone, through] = await Promise.all([
    whichThings(list, state, (t) => `The instruction is "${instruction}". Should "${t.thing}" go, to carry it out? Things that belong with what is removed go too, like the saucer and spoon of a cup.`),
    // "Any part": asked whether something continues behind it, Jev named only the
    // table, and the fill pasted wood where the dark background behind a cup's top was.
    whichThings(list, state, (t) => `The instruction is "${instruction}". Once that is removed, would "${t.thing}" show in any part of the gap it leaves, like the table under a cup's base or the wall or background behind its top?`),
  ])
  for (const g of gone) through.delete(g)
  goneThings = list.filter((t) => gone.has(t.thing))
  throughThings = list.filter((t) => through.has(t.thing))
  console.log(`jev: remove ${goneThings.map((t) => t.thing).join(', ') || 'nothing'}; fill with ${throughThings.map((t) => t.thing).join(', ') || 'whatever is near'}`)
}

const boxed = goneThings.filter((t) => t.box)
if (eyes === 'code') {
  await codeEyes()
} else if (boxed.length) {
  for (const thing of boxed) await groupsInBox(thing)
} else {
  // No boxes (or no eyes): one yes-or-no question per region, as in local-edit.ts.
  const seg = await segment(input, { width: 320, count: 700 })
  const picked = await selectThing(seg, instruction, context)
  const hole = strongestPieces(seg, picked.chosen, picked.p)
  const ring = new Set<number>()
  let edge = [...hole]
  for (let step = 0; step < 3; step++) {
    edge = edge.flatMap((id) => [...seg.regions[id].neighbors]).filter((id) => !hole.has(id) && !ring.has(id))
    edge.forEach((id) => ring.add(id))
  }
  const behind = await choose(seg, [...ring], { instruction, ...context },
    `The instruction is "${instruction}". Once that is gone, the spot where it was must be filled in. Does this region show the surface that most likely continues behind it?`,
    'This region shows the surface that continues behind the removed thing.', 'This region shows another object.')
  const source = behind.chosen.size ? behind.chosen : ring
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const id = seg.labels[Math.min(seg.height - 1, Math.floor((y * seg.height) / H)) * seg.width + Math.min(seg.width - 1, Math.floor((x * seg.width) / W))]
    unknown[y * W + x] = hole.has(id) ? 1 : 0
    fromHere[y * W + x] = source.has(id) && !picked.chosen.has(id) ? 1 : 0
    near[y * W + x] = 1
  }
}
let holeSize = unknown.reduce((a, v) => a + v, 0)
if (process.env.DEBUG) console.log(`debug: hole after selection ${holeSize}`)
if (!holeSize) {
  console.log('nothing to remove')
  process.exit(0)
}

/**
 * The photo as text made by code (retina.ts); Jev reads it and decides:
 * 1. which segment is the thing to remove (one choice across all letters),
 * 2. which segments near it go with it (a saucer, the coffee, a spoon),
 * 3. which segments are the surface that should continue into the gap.
 * Asked per segment "remove, fill from or keep?", Jev never compared the
 * letters and marked the table and laptop for removal; a choice across all
 * letters is how the shape quiz got "which is biggest" right.
 */
async function codeEyes() {
  const sight = await retina(input)
  const image = describeSight(sight)
  const state = { instruction, image }
  const letters = Object.fromEntries(sight.segs.map((sg) => [sg.letter, null]))
  const first = await ask(state, {
    anchor: { type: 'choice', instructions: `The instruction is "${instruction}". Which segment is (the main part of) what it removes?`, criteria: letters },
  })
  const anchor = sight.segs.find((sg) => sg.letter === first.anchor.choice)!
  // Candidates: segments within two borders of the anchor.
  const byLetter = new Map(sight.segs.map((sg) => [sg.letter, sg]))
  const near1 = new Set(anchor.touches)
  const nearby = new Set([...near1, ...[...near1].flatMap((l) => byLetter.get(l)?.touches ?? [])])
  nearby.delete(anchor.letter)
  const candidates = [...nearby].filter((l) => byLetter.get(l)!.area < 0.25)
  const second = await ask({ ...state, removing: `segment ${anchor.letter}` }, {
    ...Object.fromEntries(candidates.map((l) => [`with_${l}`, {
      type: 'noul' as const,
      instructions: `Segment ${anchor.letter} is being removed. Does segment ${l} go with it: another part of the same thing, or something on, in or under it that belongs to it (a saucer, the coffee, a spoon, its shadow)?`,
    }])),
    surface: { type: 'choice', instructions: `Which segment is the surface around or behind segment ${anchor.letter}, which should continue into the gap?`, criteria: Object.fromEntries([...near1].map((l) => [l, null])) },
  })
  const gone = new Set([anchor.letter, ...candidates.filter((l) => (second[`with_${l}`] as { noul: number }).noul >= 0.5)])
  const surface = (second.surface as { choice: string }).choice
  const fill = new Set([surface, ...[...near1].filter((l) => !gone.has(l) && byLetter.get(l)!.area >= byLetter.get(surface)!.area * 0.5)])
  console.log(`jev: remove ${[...gone].join('')} (main part ${anchor.letter}); fill from ${[...fill].join('')}`)

  const role = new Map(sight.segs.map((sg) => [sg.id, gone.has(sg.letter) ? 'remove' : fill.has(sg.letter) ? 'fill from' : 'keep']))
  const sw = sight.seg.width, sh = sight.seg.height
  let [l, t, r, b] = [W, H, 0, 0]
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const what = role.get(sight.segOf[Math.min(sh - 1, Math.floor((y * sh) / H)) * sw + Math.min(sw - 1, Math.floor((x * sw) / W))])
    if (what === 'remove') { unknown[y * W + x] = 1; l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y) }
    if (what === 'fill from') fromHere[y * W + x] = 1
  }
  // The hole may grow by color only near what was removed.
  const m = Math.round(0.05 * W)
  for (let y = Math.max(0, t - m); y < Math.min(H, b + m); y++) for (let x = Math.max(0, l - m); x < Math.min(W, r + m); x++) near[y * W + x] = 1
}

/** Color groups around one removed thing's box, labeled by Jev; marks the hole and the fill source. */
async function groupsInBox(thing: Thing) {
  const [l, t, r, b] = thing.box!
  const pad = (v: number, d: number, max: number) => Math.max(0, Math.min(max, v + d))
  // Inner: the box plus a little. Outer: a margin around it, where the surface behind shows.
  const inner = [pad((l * W) / 100, -0.03 * W, W), pad((t * H) / 100, -0.03 * H, H), pad((r * W) / 100, 0.03 * W, W), pad((b * H) / 100, 0.03 * H, H)]
  const mx = Math.max(0.04 * W, 0.35 * (inner[2] - inner[0])), my = Math.max(0.04 * H, 0.35 * (inner[3] - inner[1]))
  const outer = [pad(inner[0], -mx, W), pad(inner[1], -my, H), pad(inner[2], mx, W), pad(inner[3], my, H)].map(Math.round)
  const isInner = (x: number, y: number) => x >= inner[0] && x < inner[2] && y >= inner[1] && y < inner[3]

  // k-means in Lab over the outer box.
  const pixels: number[] = []
  for (let y = outer[1]; y < outer[3]; y++) for (let x = outer[0]; x < outer[2]; x++) pixels.push(y * W + x)
  const labs = pixels.map((i) => toLab(work[i * 3], work[i * 3 + 1], work[i * 3 + 2]))
  let centers = Array.from({ length: GROUPS }, (_, k) => labs[Math.floor(((k + 0.5) * labs.length) / GROUPS)])
  const group = new Int32Array(pixels.length)
  for (let iter = 0; iter < 12; iter++) {
    const sums = centers.map(() => [0, 0, 0, 0])
    labs.forEach((v, i) => {
      let best = 0, bd = Infinity
      centers.forEach((c, k) => { const d = (v[0] - c[0]) ** 2 + (v[1] - c[1]) ** 2 + (v[2] - c[2]) ** 2; if (d < bd) { bd = d; best = k } })
      group[i] = best
      const s = sums[best]; s[0] += v[0]; s[1] += v[1]; s[2] += v[2]; s[3]++
    })
    centers = sums.map((s, k) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : centers[k]))
  }

  // Each group in words.
  const innerCount = pixels.filter((i) => isInner(i % W, Math.floor(i / W))).length
  const stats = centers.map(() => ({ n: 0, inside: 0, edge: 0, rgb: [0, 0, 0] }))
  pixels.forEach((i, j) => {
    const s = stats[group[j]], x = i % W, y = Math.floor(i / W)
    s.n++
    for (let c = 0; c < 3; c++) s.rgb[c] += work[i * 3 + c]
    if (isInner(x, y)) {
      s.inside++
      const fx = (x - inner[0]) / (inner[2] - inner[0]), fy = (y - inner[1]) / (inner[3] - inner[1])
      if (Math.min(fx, 1 - fx, fy, 1 - fy) < 0.15) s.edge++
    }
  })
  const describe = (k: number) => {
    const s = stats[k]
    const rgb = s.rgb.map((v) => v / s.n) as [number, number, number]
    const outside = 1 - s.inside / s.n
    return `${nameColor(...rgb)}; covers ${Math.round((100 * s.inside) / innerCount)}% of the box; ${Math.round(100 * outside)}% of this color lies outside the box` +
      `; inside the box it sits ${s.inside && s.edge / s.inside > 0.5 ? 'mostly along the edges' : 'mostly toward the middle'}`
  }
  const options: Record<string, string> = {
    [thing.thing]: `${thing.color} (to remove)`,
    ...Object.fromEntries(throughThings.map((o) => [o.thing, o.color])),
    'something else': 'Another object, or a shadow or reflection of something that stays.',
  }
  const live = centers.map((_, k) => k).filter((k) => stats[k].n > 0)
  const questions: Record<string, Choice> = Object.fromEntries(live.map((k) => [`g${k}`, {
    type: 'choice' as const,
    instructions: { question: `In and around the box of "${thing.thing}", which thing does this group of pixels show?`, color_group: describe(k) },
    criteria: options,
  }]))
  const answers = await ask({ instruction, ...context, note: 'Pixels in and around the box are grouped by color; each question describes one group.' }, questions)
  const labelOf = new Map(live.map((k) => [k, answers[`g${k}`].choice]))
  for (const k of live) console.log(`   ${describe(k)}  ->  ${labelOf.get(k)} ${answers[`g${k}`].probabilities[labelOf.get(k)!].toFixed(2)}`)

  // A group that is mostly outside the box surrounds the object (the dark background
  // behind a cup's top, which Jev left out of "what shows in the gap").
  const surrounds = (k: number) => 1 - stats[k].inside / stats[k].n >= 0.6
  // The hole: inner-box pixels in the removed thing's groups. The source: outer pixels in the groups behind it.
  const mask = new Uint8Array(W * H)
  pixels.forEach((i, j) => {
    const label = labelOf.get(group[j])
    if (label === thing.thing && isInner(i % W, Math.floor(i / W))) mask[i] = 1
    else if (throughThings.some((o) => o.thing === label) || (label === 'something else' && surrounds(group[j]))) fromHere[i] = 1
    near[i] = 1
  })
  // Keep the pieces that reach the middle half of the box, then close what they enclose
  // (the coffee inside a cup, a logo on a phone).
  const cx0 = (inner[0] * 3 + inner[2]) / 4, cx1 = (inner[0] + inner[2] * 3) / 4, cy0 = (inner[1] * 3 + inner[3]) / 4, cy1 = (inner[1] + inner[3] * 3) / 4
  const keep = new Uint8Array(W * H)
  const seen = new Uint8Array(W * H)
  for (const startPx of pixels) {
    if (!mask[startPx] || seen[startPx]) continue
    const piece: number[] = []
    const stack = [startPx]
    seen[startPx] = 1
    let central = false
    while (stack.length) {
      const i = stack.pop()!, x = i % W, y = Math.floor(i / W)
      piece.push(i)
      if (x >= cx0 && x <= cx1 && y >= cy0 && y <= cy1) central = true
      for (const n of [i - 1, i + 1, i - W, i + W]) if (n >= 0 && n < W * H && mask[n] && !seen[n] && Math.abs((n % W) - x) <= 1) { seen[n] = 1; stack.push(n) }
    }
    if (central) for (const i of piece) keep[i] = 1
  }
  // Close: flood the inner box from its border over non-hole pixels; whatever isn't reached is enclosed.
  const reached = new Uint8Array(W * H)
  const stack: number[] = []
  const [x0, y0, x1, y1] = [Math.ceil(inner[0]), Math.ceil(inner[1]), Math.floor(inner[2]) - 1, Math.floor(inner[3]) - 1]
  const seedAt = (x: number, y: number) => { const i = y * W + x; if (!keep[i] && !reached[i]) { reached[i] = 1; stack.push(i) } }
  for (let x = x0; x <= x1; x++) { seedAt(x, y0); seedAt(x, y1) }
  for (let y = y0; y <= y1; y++) { seedAt(x0, y); seedAt(x1, y) }
  while (stack.length) {
    const i = stack.pop()!, x = i % W, y = Math.floor(i / W)
    for (const [nx, ny] of [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]) {
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue
      const n = ny * W + nx
      if (!keep[n] && !reached[n]) { reached[n] = 1; stack.push(n) }
    }
  }
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = y * W + x
    if (keep[i] || !reached[i]) { unknown[i] = 1; fromHere[i] = 0 }
  }
}

// Grow the hole by 1% of the width: the object's rim and soft shadow sit just outside.
for (let pass = 0; pass < Math.round(W / 100); pass++) {
  const grown = unknown.slice()
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x
    if (!unknown[i] && (unknown[i - 1] || unknown[i + 1] || unknown[i - W] || unknown[i + W])) grown[i] = 1
  }
  unknown.set(grown)
}
if (process.env.DEBUG) console.log(`debug: hole after 1% growth ${unknown.reduce((a, v) => a + v, 0)}`)
// The surface around the hole, a little away from it: the colors the fill should have.
// Measured right at the edge, it included the saucer's shadow, which then stayed.
const D = 2 * Math.round(W / 120)
const rimLab: [number, number, number][] = []
for (let y = D; y < H - D; y++) for (let x = D; x < W - D; x++) {
  const i = y * W + x
  if (unknown[i] || unknown[i - D / 2] || unknown[i + D / 2] || unknown[i - (D / 2) * W] || unknown[i + (D / 2) * W]) continue
  if (unknown[i - D] || unknown[i + D] || unknown[i - D * W] || unknown[i + D * W]) rimLab.push(toLab(work[i * 3], work[i * 3 + 1], work[i * 3 + 2]))
}
const rimMean = [0, 1, 2].map((c) => rimLab.reduce((a, v) => a + v[c], 0) / (rimLab.length || 1))
const rimSd = [0, 1, 2].map((c) => Math.sqrt(rimLab.reduce((a, v) => a + (v[c] - rimMean[c]) ** 2, 0) / (rimLab.length || 1)) + 4)
const likeRim = (i: number) => {
  const v = toLab(work[i * 3], work[i * 3 + 1], work[i * 3 + 2])
  return [0, 1, 2].every((c) => Math.abs(v[c] - rimMean[c]) <= 2.5 * rimSd[c])
}
// Then grow it into nearby pixels that don't look like the rim (a saucer's thin
// white edge sat just outside the hole and got copied into the fill).
for (let pass = 0; pass < Math.round(W / 100); pass++) {
  const grown = unknown.slice()
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x
    if (!unknown[i] && near[i] && !likeRim(i) && (unknown[i - 1] || unknown[i + 1] || unknown[i - W] || unknown[i + W])) grown[i] = 1
  }
  unknown.set(grown)
}
const holeMask = unknown.slice()
holeSize = holeMask.reduce((a, v) => a + v, 0)

// Patch centers we may copy from: chosen source, whole patch outside the hole, center colored like the rim
// (on a book page, the logos next to a phone are "book" too, but not page-white).
const valid = new Uint8Array(W * H)
let validList: number[] = []
const collect = (needSource: boolean) => {
  for (let y = R; y < H - R; y++) for (let x = R; x < W - R; x++) {
    const i = y * W + x
    if (holeMask[i] || (needSource && (!fromHere[i] || !likeRim(i)))) continue
    let ok = true
    for (let dy = -R; dy <= R && ok; dy++) for (let dx = -R; dx <= R; dx++) if (holeMask[(y + dy) * W + x + dx]) { ok = false; break }
    if (ok) { valid[i] = 1; validList.push(i) }
  }
}
collect(true)
if (validList.length < 50) {
  console.log('too few source patches; using any patch outside the hole')
  validList = []
  collect(false)
}
console.log(`hole ${holeSize} px, copying from ${validList.length} patch centers`)
if (process.env.DEBUG) {
  const vis = Buffer.alloc(W * H * 3)
  for (let i = 0; i < W * H; i++) { vis[i * 3] = holeMask[i] ? 255 : 0; vis[i * 3 + 1] = valid[i] ? 255 : 0; vis[i * 3 + 2] = work[i * 3 + 2] >> 2 }
  await sharp(vis, { raw: { width: W, height: H, channels: 3 } }).png().toFile('out/debug-masks.png')
}

// Fill from the outside in, in rounds: each round takes the hole's current edge,
// most-known spots first. Candidates: the patches that continue what neighbors
// were copied from (keeps wood grain running), plus a random sample nearby,
// then a small local search around the best.
const img = Float32Array.from(work)
const from = new Int32Array(W * H).fill(-1) // for filled pixels: where they were copied from
let seed = 1
const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
const knownAround = (x: number, y: number) => {
  let k = 0
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const xx = x + dx, yy = y + dy
    if (xx >= 0 && yy >= 0 && xx < W && yy < H && !unknown[yy * W + xx]) k++
  }
  return k
}
const ssd = (px: number, py: number, c: number, limit: number) => {
  const cx = c % W, cy = Math.floor(c / W)
  let s = 0
  for (let dy = -R; dy <= R && s < limit; dy++) for (let dx = -R; dx <= R; dx++) {
    const tx = px + dx, ty = py + dy
    if (tx < 0 || ty < 0 || tx >= W || ty >= H || unknown[ty * W + tx]) continue
    const t = (ty * W + tx) * 3, so = ((cy + dy) * W + cx + dx) * 3
    s += (img[t] - work[so]) ** 2 + (img[t + 1] - work[so + 1]) ** 2 + (img[t + 2] - work[so + 2]) ** 2
  }
  return s
}
/** How strongly the known image's edges point into the hole at i, 0 to about 1. */
const isophote = (i: number) => {
  const x = i % W, y = Math.floor(i / W)
  let gx = 0, gy = 0, nx = 0, ny = 0, count = 0
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const xx = x + dx, yy = y + dy
    if (xx < 1 || yy < 1 || xx >= W - 1 || yy >= H - 1) continue
    const j = yy * W + xx
    nx += dx * (unknown[j] ? 1 : 0); ny += dy * (unknown[j] ? 1 : 0)
    if (unknown[j] || unknown[j - 1] || unknown[j + 1] || unknown[j - W] || unknown[j + W]) continue
    const lum = (k: number) => 0.299 * img[k * 3] + 0.587 * img[k * 3 + 1] + 0.114 * img[k * 3 + 2]
    gx += lum(j + 1) - lum(j - 1); gy += lum(j + W) - lum(j - W); count++
  }
  if (!count) return 0
  gx /= count; gy /= count
  const norm = Math.hypot(nx, ny) || 1
  // The edge runs along (-gy, gx); how much of it points along the hole's normal.
  return Math.min(1, Math.abs((-gy * nx + gx * ny) / norm) / 60)
}
let remaining = holeSize
while (remaining > 0) {
  const edge: [number, number][] = []
  for (let i = 0; i < W * H; i++) {
    if (!unknown[i]) continue
    const x = i % W, y = Math.floor(i / W)
    if ((x > 0 && !unknown[i - 1]) || (x < W - 1 && !unknown[i + 1]) || (y > 0 && !unknown[i - W]) || (y < H - 1 && !unknown[i + W])) edge.push([i, knownAround(x, y)])
  }
  // Most-known spots first, boosted where a strong edge in the photo runs into
  // the hole (Criminisi's data term), so lines like a table's far edge carry
  // through instead of being smeared.
  for (const e of edge) e[1] = (e[1] / ((2 * R + 1) ** 2)) * (0.15 + isophote(e[0]))
  edge.sort((a, b) => b[1] - a[1])
  for (const [p] of edge) {
    if (!unknown[p]) continue
    const px = p % W, py = Math.floor(p / W)
    const candidates = new Set<number>()
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (py + dy < 0 || py + dy >= H || px + dx < 0 || px + dx >= W) continue
      const n = (py + dy) * W + px + dx
      if (from[n] < 0) continue
      const c = from[n] - (dy * W + dx)
      if (c >= 0 && c < W * H && valid[c]) candidates.add(c)
    }
    for (let tries = 0; candidates.size < 260 && tries < 4000; tries++) {
      const c = validList[Math.floor(rand() * validList.length)]
      if (Math.abs((c % W) - px) <= WINDOW && Math.abs(Math.floor(c / W) - py) <= WINDOW) candidates.add(c)
    }
    if (!candidates.size) for (let k = 0; k < 200; k++) candidates.add(validList[Math.floor(rand() * validList.length)])
    let best = -1, score = Infinity
    for (const c of candidates) { const s = ssd(px, py, c, score); if (s < score) { score = s; best = c } }
    for (let step = 0; step < 3; step++) {
      const bx = best % W, by = Math.floor(best / W)
      for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2], [-1, -1], [1, 1], [-1, 1], [1, -1]]) {
        const c = (by + dy) * W + bx + dx
        if (c < 0 || c >= W * H || !valid[c]) continue
        const s = ssd(px, py, c, score)
        if (s < score) { score = s; best = c }
      }
    }
    const bx = best % W, by = Math.floor(best / W)
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const tx = px + dx, ty = py + dy
      if (tx < 0 || ty < 0 || tx >= W || ty >= H || !unknown[ty * W + tx]) continue
      const t = (ty * W + tx) * 3, s = ((by + dy) * W + bx + dx) * 3
      img[t] = work[s]; img[t + 1] = work[s + 1]; img[t + 2] = work[s + 2]
      unknown[ty * W + tx] = 0
      from[ty * W + tx] = (by + dy) * W + bx + dx
      remaining--
    }
  }
}

// Smooth the seams: re-match every patch in the hole now that it is all filled,
// and set each hole pixel to the average of the patches covering it (the voting
// step behind content-aware fill). Copied 9x9 patches showed as squares.
for (let round = 0; round < 3; round++) {
  const sum = new Float32Array(W * H * 3)
  const weight = new Float32Array(W * H)
  for (let p = 0; p < W * H; p++) {
    const px = p % W, py = Math.floor(p / W)
    if (!holeMask[p] || px % 2 || py % 2) continue
    const candidates = new Set<number>()
    if (from[p] >= 0 && valid[from[p]]) candidates.add(from[p])
    for (const d of [-2, 2, -2 * W, 2 * W]) { const n = p + d; if (n >= 0 && n < W * H && from[n] >= 0 && valid[from[n] - d]) candidates.add(from[n] - d) }
    for (let k = 0; k < 40; k++) {
      const c = validList[Math.floor(rand() * validList.length)]
      if (Math.abs((c % W) - px) <= WINDOW && Math.abs(Math.floor(c / W) - py) <= WINDOW) candidates.add(c)
    }
    let best = -1, score = Infinity
    for (const c of candidates) {
      const cx = c % W, cy = Math.floor(c / W)
      let d = 0
      for (let dy = -R; dy <= R && d < score; dy++) for (let dx = -R; dx <= R; dx++) {
        const tx = px + dx, ty = py + dy
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue
        const t = (ty * W + tx) * 3, so = ((cy + dy) * W + cx + dx) * 3
        d += (img[t] - work[so]) ** 2 + (img[t + 1] - work[so + 1]) ** 2 + (img[t + 2] - work[so + 2]) ** 2
      }
      if (d < score) { score = d; best = c }
    }
    if (best < 0) continue
    from[p] = best
    const bx = best % W, by = Math.floor(best / W)
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const tx = px + dx, ty = py + dy
      if (tx < 0 || ty < 0 || tx >= W || ty >= H || !holeMask[ty * W + tx]) continue
      const t = ty * W + tx, so = ((by + dy) * W + bx + dx) * 3
      sum[t * 3] += work[so]; sum[t * 3 + 1] += work[so + 1]; sum[t * 3 + 2] += work[so + 2]; weight[t]++
    }
  }
  for (let i = 0; i < W * H; i++) if (holeMask[i] && weight[i]) for (let c = 0; c < 3; c++) img[i * 3 + c] = sum[i * 3 + c] / weight[i]
}

// Blend the fill in with a soft edge, and show original | removed (magenta) and copied from (cyan) | result.
const filled = Buffer.from(Uint8ClampedArray.from(img))
const blend = await sharp(Buffer.from(holeMask.map((v) => v * 255)), { raw: { width: W, height: H, channels: 1 } }).blur(1.2).extractChannel(0).raw().toBuffer()
const result = Buffer.alloc(work.length)
const overlay = Buffer.alloc(work.length)
for (let i = 0, m = 0; i < work.length; i += 3, m++) {
  const k = blend[m] / 255, s = valid[m] ? 0.4 : 0
  for (let c = 0; c < 3; c++) {
    result[i + c] = Math.round(work[i + c] * (1 - k) + filled[i + c] * k)
    overlay[i + c] = Math.round(work[i + c] * (1 - 0.55 * k - s * (1 - k)) + [255, 0, 200][c] * 0.55 * k + [0, 220, 255][c] * s * (1 - k))
  }
}
const raw = { raw: { width: W, height: H, channels: 3 as const } }
const h = 360
const tiles = await Promise.all([work, overlay, result].map((b) => sharp(b, raw).resize({ height: h }).jpeg().toBuffer({ resolveWithObject: true })))
const w = tiles[0].info.width
mkdirSync('watch', { recursive: true })
mkdirSync('out', { recursive: true })
const slug = instruction.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const name = `${basename(input, extname(input))}-${slug}`
await sharp({ create: { width: w * 3 + 16, height: h, channels: 3, background: '#ffffff' } })
  .composite(tiles.map((t, i) => ({ input: t.data, left: i * (w + 8), top: 0 })))
  .jpeg({ quality: 88 })
  .toFile(`watch/${name}.jpg`)
await sharp(result, raw).jpeg({ quality: 92 }).toFile(`out/${name}-full.jpg`)
console.log(`watch/${name}.jpg  (${((performance.now() - started) / 1000).toFixed(1)} s)`)
console.log(costLine())
