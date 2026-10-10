// Drawing benchmark: does feedback help, and can Jev pick its best picture?
// For each subject: one picture without feedback (the first version), one with
// feedback (Jev's top choices), and 3 more with feedback sampled from Jev's
// probabilities. Jev picks the best of the 4 feedback pictures from their
// descriptions. Claude then scores all 5 images blind, in shuffled order, as an
// independent judge that can actually see them.
//
//   node src/bench-draw.ts [--rounds 1]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import sharp from 'sharp'
import { costLine } from './jev.ts'
import { draw, judge, render, seeded, slugify, type Element } from './draw-shapes.ts'
import { look } from './see.ts'

const SUBJECTS = [
  'a house with a sun in the sky',
  'a sailboat on the sea at sunset',
  'a tree on a green hill',
  'a snowman',
  'a red car on a road',
  'a flower in a pot',
]
const SAMPLED = 3
const args = process.argv.slice(2)
const rounds = Number(args.includes('--rounds') ? args[args.indexOf('--rounds') + 1] : 1)

type Row = { subject: string; round: number; scores: Record<string, number>; jevPick: number; claudeBest: number }
const rows: Row[] = []
mkdirSync('out/bench-draw', { recursive: true })

async function runSubject(subject: string, round: number) {
  const rand = seeded(round * 100 + SUBJECTS.indexOf(subject) + 1)
  const baseline = await draw(subject, { feedback: false })
  const withFeedback: Element[][] = [await draw(subject, { feedback: true })]
  for (let i = 0; i < SAMPLED; i++) withFeedback.push(await draw(subject, { feedback: true, temperature: 1, rand }))
  const pick = await judge(subject, withFeedback)

  const named: [string, Element[]][] = [['no feedback', baseline], ...withFeedback.map((p, i) => [i === 0 ? 'feedback' : `sampled ${i}`, p] as [string, Element[]])]
  const images = await Promise.all(named.map(([, p]) => render(p)))
  const slug = `${slugify(subject)}-r${round}`
  await Promise.all(images.map((img, i) => sharp(img).toFile(`out/bench-draw/${slug}-${slugify(named[i][0])}.png`)))
  // The first version's picture (saved from an earlier run), judged in the same batch.
  const before = `out/bench-draw-v1/${slug}-no-feedback.png`
  if (existsSync(before)) {
    named.push(['first version', []])
    images.push(readFileSync(before))
  }

  // Blind: shuffled, numbered only by position.
  const order = named.map((_, i) => i).sort(() => rand() - 0.5)
  const answer = await look(
    order.map((i) => images[i]),
    'You grade simple flat-shape drawings. Answer with JSON only.',
    `These ${order.length} images are numbered 1 to ${order.length} in the order given. For each, score from 1 to 10 how clearly it shows "${subject}": ` +
      `recognizable parts, sensible sizes, proportions and positions. Answer like {"1": 6, "2": 3, ...}.`,
  )
  const byPosition: Record<string, number> = JSON.parse(answer.slice(answer.indexOf('{'), answer.lastIndexOf('}') + 1))
  const scores: Record<string, number> = {}
  order.forEach((original, position) => (scores[named[original][0]] = Number(byPosition[String(position + 1)])))
  const feedbackScores = withFeedback.map((_, i) => scores[named[i + 1][0]])
  rows.push({ subject, round, scores, jevPick: pick.index, claudeBest: feedbackScores.indexOf(Math.max(...feedbackScores)) })
  console.log(`${subject.padEnd(34)} ${named.map(([n]) => `${n} ${scores[n]}`).join(', ')}  | jev picks ${named[pick.index + 1][0]}`)
}

for (let round = 1; round <= rounds; round++) {
  await Promise.all(SUBJECTS.map((s) => runSubject(s, round)))
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1)
const of = (name: string) => mean(rows.map((r) => r.scores[name]))
const feedbackNames = ['feedback', ...Array.from({ length: SAMPLED }, (_, i) => `sampled ${i + 1}`)]
const pickScore = mean(rows.map((r) => r.scores[feedbackNames[r.jevPick]]))
const bestScore = mean(rows.map((r) => Math.max(...feedbackNames.map((n) => r.scores[n]))))
const randomScore = mean(rows.map((r) => mean(feedbackNames.map((n) => r.scores[n]))))
const agree = rows.filter((r) => r.scores[feedbackNames[r.jevPick]] === Math.max(...feedbackNames.map((n) => r.scores[n]))).length
const summary = [
  `Claude's blind score, 1-10, mean over ${rows.length} drawings:`,
  ...(rows.every((r) => 'first version' in r.scores) ? [`  first version (before fixes)    ${of('first version').toFixed(1)}`] : []),
  `  no feedback                     ${of('no feedback').toFixed(1)}`,
  `  feedback, Jev's top choices     ${of('feedback').toFixed(1)}`,
  `  feedback, any of the 4 (random) ${randomScore.toFixed(1)}`,
  `  Jev's pick of the 4             ${pickScore.toFixed(1)}  (picked one of Claude's top-scored in ${agree}/${rows.length})`,
  `  best of the 4 (by Claude)       ${bestScore.toFixed(1)}`,
].join('\n')
console.log(`\n${summary}`)
writeFileSync('out/bench-draw/summary.txt', summary + '\n')
writeFileSync('out/bench-draw/report.json', JSON.stringify(rows, null, 2))
console.log(costLine())
