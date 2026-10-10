// Can Jev see? A quiz with known answers.
// Code draws random scenes of circles, squares and triangles, then shows Jev
// each scene only as text made by code (no models) and asks about it:
// what color is the circle, what shape is the blue one, where is it, how many
// triangles, which color is biggest. Three ways of turning the image into text:
//   raw       a grid of color letters, one per cell, nothing else
//   segments  the retina's letter map and legend (retina.ts), no silhouettes
//   full      the same plus a # and . silhouette of each segment
//
//   node src/quiz.ts [--scenes 30] [--modes raw,segments,full]
import { mkdirSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { ask, costLine, type Choice, type ChoiceAnswer, type Noul } from './jev.ts'
import { describe, see } from './retina.ts'

import { BACKGROUNDS, COLORS, H, PLACES, SHAPES, W, makeScene, pickFrom, seeded, svg, type Scene } from './scenes.ts'

/** The plainest image-as-text: each cell's nearest named color, as a letter. */
async function rawGrid(path: string, cols = 48) {
  const rows = Math.round((cols * H) / W / 2)
  const palette: Record<string, string> = { ...COLORS, ...BACKGROUNDS }
  const names = Object.keys(palette)
  const letters = 'RBGYPOKWLEC'
  const rgb = names.map((n) => [1, 3, 5].map((k) => parseInt(palette[n].slice(k, k + 2), 16)))
  const { data } = await sharp(path).resize(cols, rows, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const grid: string[] = []
  for (let y = 0; y < rows; y++) {
    let row = ''
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 3
      let best = 0, bd = Infinity
      rgb.forEach((c, k) => { const d = (c[0] - data[i]) ** 2 + (c[1] - data[i + 1]) ** 2 + (c[2] - data[i + 2]) ** 2; if (d < bd) { bd = d; best = k } })
      row += letters[best]
    }
    grid.push(row)
  }
  return {
    how_to_read: `The image is drawn as a ${cols} x ${rows} grid of letters, one per cell, each the nearest color. Row 1 is the top.`,
    legend: Object.fromEntries(names.map((n, k) => [letters[k], n])),
    grid,
  }
}

type Question = { kind: string; text: string; options: string[]; answer: string }

function questions(scene: Scene, rand: () => number): Question[] {
  const qs: Question[] = []
  const unique = SHAPES.filter((t) => scene.shapes.filter((s) => s.type === t).length === 1)
  if (unique.length) {
    const t = pickFrom(unique, rand)
    qs.push({ kind: 'color of a shape', text: `What color is the ${t}?`, options: Object.keys(COLORS), answer: scene.shapes.find((s) => s.type === t)!.color })
  }
  const s = pickFrom(scene.shapes, rand)
  qs.push({ kind: 'shape of a color', text: `What shape is the ${s.color} one?`, options: [...SHAPES], answer: s.type })
  const s2 = pickFrom(scene.shapes, rand)
  qs.push({ kind: 'where', text: `Where is the ${s2.color} shape?`, options: PLACES, answer: PLACES[s2.cell] })
  const t = pickFrom(SHAPES, rand)
  qs.push({ kind: 'count', text: `How many ${t}s are there?`, options: ['0', '1', '2', '3', '4'], answer: String(scene.shapes.filter((x) => x.type === t).length) })
  const biggest = [...scene.shapes].sort((a, b) => b.size - a.size)[0]
  qs.push({ kind: 'biggest', text: 'What color is the biggest shape?', options: Object.keys(COLORS), answer: biggest.color })
  return qs
}

const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const count = Number(flag('--scenes')) || 30
const modes = (flag('--modes') ?? 'raw,segments,full').split(',')
mkdirSync('samples/quiz', { recursive: true })
const rand = seeded(7)
const results: { scene: number; mode: string; kind: string; answer: string; got: string; p: number }[] = []

await Promise.all(Array.from({ length: count }, async (_, n) => {
  const scene = makeScene(seeded(1000 + n))
  const qs = questions(scene, seeded(2000 + n))
  const path = `samples/quiz/scene-${n}.png`
  await sharp(Buffer.from(svg(scene))).png().toFile(path)
  const sight = modes.some((m) => m !== 'raw') ? await see(path, { cols: 48, maxSegments: 12, slicWidth: 320, slicCount: 400 }) : undefined
  for (const mode of modes) {
    const image = mode === 'raw' ? await rawGrid(path) : describe(sight!, { silhouettes: mode === 'full' })
    const asked: Record<string, Choice | Noul> = Object.fromEntries(qs.map((q, i) => [`q${i}`, { type: 'choice' as const, instructions: q.text, criteria: Object.fromEntries(q.options.map((o) => [o, null])) }]))
    // Counting, the Jev way: one yes-or-no per segment ("is B a triangle?"), and code
    // counts the yeses. Asked to count in one go, Jev was barely above chance.
    const countQ = qs.findIndex((q) => q.kind === 'count')
    const shapeType = countQ >= 0 ? qs[countQ].text.match(/many (\w+)s/)![1] : ''
    // A yes-or-no "is B a triangle?" came back too cautious (it missed 8 triangles);
    // "what shape is B?" is the question Jev gets right every time.
    if (mode !== 'raw' && countQ >= 0) {
      delete asked[`q${countQ}`]
      for (const sg of sight!.segs) {
        asked[`shape_${sg.letter}`] = { type: 'choice', instructions: `What is segment ${sg.letter}?`, criteria: { circle: null, square: null, triangle: null, background: null } }
      }
    }
    // Biggest, in two steps: which segment (a letter), then that segment's color.
    const bigQ = qs.findIndex((q) => q.kind === 'biggest')
    if (mode !== 'raw' && bigQ >= 0) {
      delete asked[`q${bigQ}`]
      asked.biggest_segment = {
        type: 'choice',
        instructions: 'Which segment is the biggest shape (not the background)?',
        criteria: Object.fromEntries(sight!.segs.map((sg) => [sg.letter, null])),
      }
    }
    const state = { task: 'Answer questions about the image below, which you see only as text.', image }
    const answers = await ask(state, asked)
    const bigColor = mode !== 'raw' && bigQ >= 0
      ? (await ask(state, { color: { type: 'choice', instructions: `What color is segment ${(answers.biggest_segment as ChoiceAnswer).choice}?`, criteria: Object.fromEntries(Object.keys(COLORS).map((c) => [c, null])) } })).color.choice
      : ''
    qs.forEach((q, i) => {
      if (mode !== 'raw' && i === countQ) {
        const counted = String(Math.min(4, sight!.segs.filter((sg) => (answers[`shape_${sg.letter}`] as ChoiceAnswer).choice === shapeType).length))
        results.push({ scene: n, mode, kind: q.kind, answer: q.answer, got: counted, p: counted === q.answer ? 1 : 0 })
        return
      }
      if (mode !== 'raw' && i === bigQ) {
        results.push({ scene: n, mode, kind: q.kind, answer: q.answer, got: bigColor, p: bigColor === q.answer ? 1 : 0 })
        return
      }
      const a = answers[`q${i}`] as ChoiceAnswer
      results.push({ scene: n, mode, kind: q.kind, answer: q.answer, got: a.choice, p: a.probabilities[q.answer] ?? 0 })
    })
  }
}))
void rand

const kinds = ['color of a shape', 'shape of a color', 'where', 'count', 'biggest']
const chance: Record<string, string> = { 'color of a shape': '14%', 'shape of a color': '33%', where: '11%', count: '20%', biggest: '14%' }
const lines = [`| question | chance | ${modes.join(' | ')} |`, `| --- | --- | ${modes.map(() => '---').join(' | ')} |`]
for (const k of kinds) {
  const cells = modes.map((m) => {
    const r = results.filter((x) => x.mode === m && x.kind === k)
    return r.length ? `${Math.round((100 * r.filter((x) => x.got === x.answer).length) / r.length)}% (${r.length})` : '-'
  })
  lines.push(`| ${k} | ${chance[k]} | ${cells.join(' | ')} |`)
}
const all = modes.map((m) => { const r = results.filter((x) => x.mode === m); return `${Math.round((100 * r.filter((x) => x.got === x.answer).length) / r.length)}%` })
lines.push(`| all | | ${all.join(' | ')} |`)
console.log(lines.join('\n'))
mkdirSync('out', { recursive: true })
writeFileSync('out/quiz-results.json', JSON.stringify(results, null, 1))
writeFileSync('out/quiz-summary.md', lines.join('\n') + '\n')
console.log(costLine())
