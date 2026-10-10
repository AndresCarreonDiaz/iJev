// Jev sees and acts. Code draws a scene, the retina (retina.ts, plain code) turns
// it into text, Jev reads the text and picks which segment an instruction means,
// and code makes the edit. The instruction names the shape in one of three ways,
// so each needs a different kind of seeing:
//   by shape     "Remove the triangle"            (read the silhouettes)
//   by color     "Make the blue one yellow"       (read the colors)
//   by position  "Remove the shape in the top right" (read the map)
// Scored against the scene's known contents; a sheet of examples goes to watch/.
//
//   node src/act.ts [--scenes 30]
import { mkdirSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { ask, costLine } from './jev.ts'
import { describe, see } from './retina.ts'
import { COLORS, H, PLACES, SHAPES, W, makeScene, pickFrom, seeded, svg, type Shape } from './scenes.ts'

type Task = { instruction: string; by: 'shape' | 'color' | 'position'; action: 'remove' | 'recolor'; target: Shape; newColor?: string }

function task(shapes: Shape[], n: number, rand: () => number): Task {
  const action = n % 2 ? 'recolor' : 'remove'
  const unique = shapes.filter((s) => shapes.filter((o) => o.type === s.type).length === 1)
  const by = (['shape', 'color', 'position'] as const)[n % 3] === 'shape' && !unique.length ? 'color' : (['shape', 'color', 'position'] as const)[n % 3]
  const target = by === 'shape' ? pickFrom(unique, rand) : pickFrom(shapes, rand)
  const newColor = pickFrom(Object.keys(COLORS).filter((c) => !shapes.some((s) => s.color === c)), rand)
  const name = by === 'shape' ? `the ${target.type}` : by === 'color' ? `the ${target.color} one` : `the shape in the ${PLACES[target.cell]}`
  const instruction = action === 'remove' ? `Remove ${name}` : `Make ${name} ${newColor}`
  return { instruction, by, action, target, newColor: action === 'recolor' ? newColor : undefined }
}

const args = process.argv.slice(2)
const count = Number(args.includes('--scenes') ? args[args.indexOf('--scenes') + 1] : 30)
mkdirSync('samples/act', { recursive: true })
mkdirSync('watch', { recursive: true })
const rows: { n: number; by: string; action: string; instruction: string; right: boolean; colorRight?: boolean; before: Buffer; after: Buffer }[] = []

await Promise.all(Array.from({ length: count }, async (_, n) => {
  const scene = makeScene(seeded(5000 + n))
  const t = task(scene.shapes, n, seeded(6000 + n))
  const path = `samples/act/scene-${n}.png`
  await sharp(Buffer.from(svg(scene))).png().toFile(path)
  const sight = await see(path, { cols: 48, maxSegments: 12, slicWidth: W, slicCount: 400 })
  const letters = Object.fromEntries(sight.segs.map((s) => [s.letter, null]))
  const answers = await ask({ instruction: t.instruction, image: describe(sight) }, {
    target: { type: 'choice', instructions: `Which segment does "${t.instruction}" mean?`, criteria: letters },
    ...(t.action === 'recolor' && { color: { type: 'choice' as const, instructions: `Which color does "${t.instruction}" ask for?`, criteria: Object.fromEntries(Object.keys(COLORS).map((c) => [c, null])) } }),
  })
  const picked = sight.segs.find((s) => s.letter === answers.target.choice)!
  // Right if the picked segment sits where the target shape was drawn.
  const [cx, cy] = [((t.target.cell % 3) + 0.5) / 3, (Math.floor(t.target.cell / 3) + 0.5) / 3]
  const right = Math.hypot(picked.center[0] - cx, picked.center[1] - cy) < 0.08 && !picked.edges.length
  const color = t.action === 'recolor' ? answers.color.choice : undefined

  // The edit: the picked segment's pixels become the background color, or the new color.
  const { data } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const out = Buffer.from(data)
  const background = sight.segs[0].rgb.map(Math.round)
  const paint = color ? [1, 3, 5].map((k) => parseInt(COLORS[color].slice(k, k + 2), 16)) : background
  // Grown by 2 px over the background, so the shape's soft edge goes too.
  const mask = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) if (sight.segOf[i] === picked.id) mask[i] = 1
  for (let pass = 0; pass < 2; pass++) {
    const grown = mask.slice()
    for (let i = W; i < W * H - W; i++) if (!mask[i] && sight.segOf[i] === 0 && (mask[i - 1] || mask[i + 1] || mask[i - W] || mask[i + W])) grown[i] = 1
    mask.set(grown)
  }
  for (let i = 0; i < W * H; i++) if (mask[i]) out.set(paint, i * 3)
  rows.push({ n, by: t.by, action: t.action, instruction: t.instruction, right, colorRight: color ? color === t.newColor : undefined, before: await sharp(path).png().toBuffer(), after: await sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer() })
}))
rows.sort((a, b) => a.n - b.n)

const pct = (xs: boolean[]) => `${Math.round((100 * xs.filter(Boolean).length) / xs.length)}% (${xs.filter(Boolean).length}/${xs.length})`
const lines = ['| named by | right shape picked | chance |', '| --- | --- | --- |']
for (const by of ['shape', 'color', 'position']) {
  const r = rows.filter((x) => x.by === by)
  lines.push(`| ${by} | ${pct(r.map((x) => x.right))} | about ${Math.round(100 / 4)}% |`)
}
lines.push(`| all | ${pct(rows.map((x) => x.right))} | |`)
const recolors = rows.filter((x) => x.colorRight !== undefined)
lines.push('', `New color right in recolors: ${pct(recolors.map((x) => !!x.colorRight))}`)
console.log(lines.join('\n'))
writeFileSync('out/act-summary.md', lines.join('\n') + '\n')

// Sheet: 8 examples, before and after, with the instruction and whether Jev picked right.
const pick = rows.slice(0, 8)
const tileW = 240, tileH = 180, cap = 26
const tiles = []
for (const [i, r] of pick.entries()) {
  const x = (i % 2) * (2 * tileW + 30), y = Math.floor(i / 2) * (tileH + cap + 14)
  const label = `${r.instruction}  ${r.right ? '(right)' : '(WRONG)'}`.replace(/&/g, '&amp;')
  tiles.push(
    { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${2 * tileW + 6}" height="${cap}"><text x="2" y="18" font-family="Helvetica" font-size="15" fill="${r.right ? '#1a1a1a' : '#c00'}">${label}</text></svg>`), left: x, top: y },
    { input: await sharp(r.before).resize(tileW, tileH).toBuffer(), left: x, top: y + cap },
    { input: await sharp(r.after).resize(tileW, tileH).toBuffer(), left: x + tileW + 6, top: y + cap },
  )
}
await sharp({ create: { width: 2 * (2 * tileW + 30), height: 4 * (tileH + cap + 14), channels: 3, background: '#ffffff' } }).composite(tiles).jpeg({ quality: 90 }).toFile('watch/jev-sees-shapes.jpg')
console.log('watch/jev-sees-shapes.jpg')
console.log(costLine())
