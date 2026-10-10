// Benchmark: damage real photos in known ways, ask Jev to fix them, and
// measure how close each result gets back to the original.
//
//   node src/fetch-photos.ts 24     # once
//   node src/bench-edit.ts [--modes jev,fixed,targets,oracle] [--limit 24]
//
// Modes (see editor.ts): jev stops by itself; fixed uses one range set for
// every photo (typical real photos, from calibration.json); targets lets Jev pick the ranges per
// photo; oracle uses the original's own numbers (the best this edit set can do).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { costLine } from './jev.ts'
import { distance, edit, finish, load, pipe, typicalRanges, type Mode, type Raw, type Ranges } from './editor.ts'
import { see } from './see.ts'

const GOAL = 'Fix this photo so it looks natural.'
// One set of ranges for every photo: the middle 60% of real photos (calibration.json).
const FIXED: Ranges = typicalRanges()

/** Each damage gets a strength r in [0, 1) from a seeded generator. */
const DAMAGES: Record<string, (img: Raw, r: number) => Promise<Raw>> = {
  none: async (img) => img,
  dark: (img, r) => finish(pipe(img).modulate({ brightness: 0.55 + 0.15 * r })),
  bright: (img, r) => finish(pipe(img).modulate({ brightness: 1.3 + 0.15 * r })),
  dull: (img, r) => finish(pipe(img).modulate({ saturation: 0.35 + 0.2 * r })),
  oversaturated: (img, r) => finish(pipe(img).modulate({ saturation: 1.5 + 0.3 * r })),
  cold: (img, r) => { const k = 0.12 + 0.06 * r; return finish(pipe(img).recomb([[1 - k, 0, 0], [0, 0.98, 0], [0, 0, 1 + k]])) },
  warm: (img, r) => { const k = 0.12 + 0.06 * r; return finish(pipe(img).recomb([[1 + k, 0, 0], [0, 1.02, 0], [0, 0, 1 - k]])) },
  flat: (img, r) => { const a = 0.6 + 0.1 * r; return finish(pipe(img).linear(a, 128 * (1 - a))) },
  'dark+dull': (img, r) => finish(pipe(img).modulate({ brightness: 0.6 + 0.1 * r, saturation: 0.5 })),
}

function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
// A mode can add what Claude saw: "+scene" passes the scene and style only, "+seen" also what looks off.
const modes = (flag('--modes') ?? 'jev,targets,targets+scene,jev+seen,targets+seen,oracle').split(',')
const manifest: { file: string }[] = JSON.parse(readFileSync('samples/photos/manifest.json', 'utf8'))
const photos = manifest.slice(0, Number(flag('--limit')) || manifest.length)
mkdirSync('samples/bench', { recursive: true })
for (const m of modes) mkdirSync(`out/bench/${m}`, { recursive: true })

type Row = { photo: string; damage: string; mode: string; before: number; after: number; outcome: string; edits: string[]; requests: number; overrides: number; picked?: Record<string, string> }
const rows: Row[] = []
const names = Object.keys(DAMAGES)

async function runPhoto(index: number) {
  const id = photos[index].file.replace('.jpg', '')
  const damage = names[index % names.length]
  const original = await load(`samples/photos/${photos[index].file}`)
  // Saved and reloaded as JPEG, like a real damaged file, and so every mode sees the same input.
  const damagedPath = `samples/bench/${id}-${damage}.jpg`
  // Written once, so Claude's cached description of it stays valid across runs.
  if (!existsSync(damagedPath)) await pipe(await DAMAGES[damage](original, seeded(index + 1)())).jpeg({ quality: 92 }).toFile(damagedPath)
  const damaged = await load(damagedPath)
  const before = await distance(damaged, original)
  const caption = modes.some((m) => m.includes('+')) ? await see(damagedPath) : undefined
  for (const m of modes) {
    const [base, eyes] = m.split('+')
    const result = await edit({
      photo: damaged,
      goal: GOAL,
      mode: (base === 'fixed' ? 'checks' : base) as Mode,
      ranges: base === 'fixed' ? FIXED : undefined,
      reference: original,
      seen: eyes === 'seen' ? { ...caption! } : eyes === 'scene' ? { scene: caption!.scene, style: caption!.style } : undefined,
    })
    await pipe(result.img).jpeg({ quality: 88 }).toFile(`out/bench/${m}/${id}.jpg`)
    rows.push({
      photo: id,
      damage,
      mode: m,
      before: +before.toFixed(1),
      after: +(await distance(result.img, original)).toFixed(1),
      outcome: result.outcome,
      edits: result.applied.map((a) => `${a.edit} ${a.strength}`),
      requests: result.steps.length + (m.startsWith('targets') ? 1 : 0),
      overrides: result.overrides,
      picked: result.picked,
    })
  }
  process.stdout.write('.')
}

// A few photos at a time; each photo runs its modes one after another.
const queue = photos.map((_, i) => i)
await Promise.all(Array.from({ length: 6 }, async () => {
  for (let i = queue.shift(); i !== undefined; i = queue.shift()) await runPhoto(i)
}))
console.log()

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
const lines = ['| mode | mean distance before -> after | better | worse | passed | stuck | requests/photo | overrides |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
for (const m of modes) {
  const r = rows.filter((x) => x.mode === m)
  const better = r.filter((x) => x.after < x.before - 1).length
  const worse = r.filter((x) => x.after > x.before + 1).length
  lines.push(`| ${m} | ${mean(r.map((x) => x.before)).toFixed(1)} -> ${mean(r.map((x) => x.after)).toFixed(1)} | ${better}/${r.length} | ${worse}/${r.length} | ${r.filter((x) => x.outcome === 'passed').length} | ${r.filter((x) => x.outcome === 'stuck').length} | ${mean(r.map((x) => x.requests)).toFixed(1)} | ${r.reduce((a, x) => a + x.overrides, 0)} |`)
}
lines.push('', `| damage | before | ${modes.join(' | ')} |`, `| --- | --- | ${modes.map(() => '---').join(' | ')} |`)
for (const d of names) {
  const r = rows.filter((x) => x.damage === d)
  if (!r.length) continue
  lines.push(`| ${d} (${r.length / modes.length}) | ${mean(r.filter((x) => x.mode === modes[0]).map((x) => x.before)).toFixed(1)} | ${modes.map((m) => mean(r.filter((x) => x.mode === m).map((x) => x.after)).toFixed(1)).join(' | ')} |`)
}
const summary = lines.join('\n')
console.log(summary)
writeFileSync('out/bench/summary.md', summary + '\n')
writeFileSync('out/bench/report.json', JSON.stringify(rows.sort((a, b) => a.photo.localeCompare(b.photo, undefined, { numeric: true })), null, 2))

// Contact sheet: one row per photo, columns original, damaged, then each mode.
const T = 150, H = 100
const order = photos.map((p, i) => ({ id: p.file.replace('.jpg', ''), damage: names[i % names.length] }))
const tile = (path: string) => sharp(path).resize(T, H, { fit: 'cover' }).toBuffer()
const composites = []
for (const [row, p] of order.entries()) {
  const paths = [`samples/photos/${p.id}.jpg`, `samples/bench/${p.id}-${p.damage}.jpg`, ...modes.map((m) => `out/bench/${m}/${p.id}.jpg`)]
  for (const [col, path] of paths.entries()) composites.push({ input: await tile(path), left: col * (T + 4), top: row * (H + 4) })
}
await sharp({ create: { width: (modes.length + 2) * (T + 4), height: order.length * (H + 4), channels: 3, background: '#ffffff' } })
  .composite(composites)
  .jpeg({ quality: 85 })
  .toFile('out/bench/sheet.jpg')
console.log(`\nout/bench/summary.md, out/bench/report.json, out/bench/sheet.jpg (columns: original, damaged, ${modes.join(', ')})`)
console.log(costLine())
