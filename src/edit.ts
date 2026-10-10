// Edit one or more photos toward a goal. See editor.ts for how the loop works.
//
//   node src/edit.ts criteria/*.json [--mode checks|targets|jev]   # default: checks
//   node src/edit.ts <photo> "<goal>" [--mode targets|jev] [--reference <photo>] [--steps 10]   # default: targets
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import sharp from 'sharp'
import { costLine, usage } from './jev.ts'
import { distance, edit, failing, load, measure, pipe, type Mode, type Ranges } from './editor.ts'

type Criteria = { name: string; photo: string; goal: string; reference?: string; steps?: number; expect?: Ranges }

const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'))
const fromFiles = positional.length > 0 && positional.every((a) => a.endsWith('.json'))
const jobs: Criteria[] = fromFiles
  ? positional.map((file) => ({ name: basename(file, '.json'), ...JSON.parse(readFileSync(file, 'utf8')) }))
  : positional.length === 2
    ? [{
        name: `${basename(positional[0], extname(positional[0]))}-${positional[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}`,
        photo: positional[0],
        goal: positional[1],
        reference: flag('--reference'),
        steps: Number(flag('--steps')) || undefined,
      }]
    : []
const mode = (flag('--mode') ?? (fromFiles ? 'checks' : 'targets')) as Mode
if (!jobs.length || !['checks', 'targets', 'jev', 'oracle'].includes(mode)) {
  console.error('usage: node src/edit.ts criteria/*.json [--mode checks|targets|jev]  |  node src/edit.ts <photo> "<goal>" [--mode targets|jev] [--reference <photo>]')
  process.exit(1)
}

const results = []
for (const job of jobs) {
  const dir = `out/edit-${job.name}${mode === 'checks' ? '' : `-${mode}`}`
  mkdirSync(dir, { recursive: true })
  const original = await load(job.photo)
  const reference = job.reference ? await load(job.reference) : undefined
  const requestsBefore = usage.requests
  console.log(`\n== ${job.name} [${mode}]: "${job.goal}"`)
  if (mode === 'checks' && !job.expect) throw new Error(`${job.name} has no expect ranges for checks mode`)

  const result = await edit({
    photo: original,
    goal: job.goal,
    mode,
    ranges: job.expect,
    reference,
    maxSteps: job.steps,
    log: (line) => console.log(line),
    onStep: (img, step) =>
      pipe(img).jpeg({ quality: 88 }).toFile(`${dir}/step-${String(step.step).padStart(2, '0')}-${step.applied!.edit.replace(/ /g, '-')}.jpg`).then(() => {}),
  })
  if (result.picked) console.log(`   jev's targets: ${Object.entries(result.picked).map(([k, v]) => `${k} "${v}"`).join(', ')}`)

  await pipe(result.img).jpeg({ quality: 90 }).toFile(`${dir}/final.jpg`)
  const h = 384
  const [left, right] = await Promise.all([original, result.img].map((raw) => pipe(raw).resize({ height: h }).jpeg().toBuffer({ resolveWithObject: true })))
  await sharp({ create: { width: left.info.width + right.info.width + 12, height: h, channels: 3, background: '#ffffff' } })
    .composite([{ input: left.data, left: 0, top: 0 }, { input: right.data, left: left.info.width + 12, top: 0 }])
    .jpeg({ quality: 88 })
    .toFile(`${dir}/before-after.jpg`)

  const final = await measure(result.img)
  const still = result.ranges ? failing(final, result.ranges) : []
  const d = reference && { before: +(await distance(original, reference)).toFixed(1), after: +(await distance(result.img, reference)).toFixed(1) }
  console.log(`   ${result.outcome}${still.length ? `, failing: ${still.join(', ')}` : ''}${d ? `  |  distance to reference ${d.before} -> ${d.after}` : ''}`)
  const { img: _, ...rest } = result
  const summary = { ...job, mode, ...rest, requests: usage.requests - requestsBefore, distance_to_reference: d, final, failing: still }
  writeFileSync(`${dir}/trace.json`, JSON.stringify(summary, null, 2))
  results.push(summary)
}

if (results.length > 1) {
  console.log('\ncriteria'.padEnd(22) + 'outcome'.padEnd(14) + 'edits  overrides  distance')
  for (const r of results) {
    const d = r.distance_to_reference ? `${r.distance_to_reference.before} -> ${r.distance_to_reference.after}` : '-'
    console.log(r.name.padEnd(21) + r.outcome.padEnd(14) + String(r.applied.length).padEnd(7) + String(r.overrides).padEnd(11) + d)
  }
}
console.log(`\n${costLine()}`)
