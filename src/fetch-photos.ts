// Free Unsplash photos via picsum.photos (Unsplash License), saved (git-ignored)
// with a manifest of authors and links.
//
//   node src/fetch-photos.ts 24                                       # benchmark set
//   node src/fetch-photos.ts 40 --page 3 --dir samples/calibration    # separate set for calibration
import { mkdirSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const COUNT = Number(args[0]) || 24
const DIR = flag('--dir') ?? 'samples/photos'
type Photo = { id: string; author: string; width: number; height: number; url: string }
const list: Photo[] = await (await fetch(`https://picsum.photos/v2/list?page=${Number(flag('--page')) || 1}&limit=100`)).json()
// Spread the picks over the list so they aren't all from one photographer.
const picks = Array.from({ length: COUNT }, (_, i) => list[Math.floor((i * list.length) / COUNT)])
mkdirSync(DIR, { recursive: true })
const manifest = []
for (const p of picks) {
  const height = Math.round((1024 * p.height) / p.width)
  const response = await fetch(`https://picsum.photos/id/${p.id}/1024/${height}.jpg`)
  if (!response.ok) throw new Error(`photo ${p.id}: HTTP ${response.status}`)
  writeFileSync(`${DIR}/${p.id}.jpg`, Buffer.from(await response.arrayBuffer()))
  manifest.push({ file: `${p.id}.jpg`, author: p.author, source: p.url, license: 'Unsplash License' })
}
writeFileSync(`${DIR}/manifest.json`, JSON.stringify(manifest, null, 2))
console.log(`${manifest.length} photos in ${DIR}`)
