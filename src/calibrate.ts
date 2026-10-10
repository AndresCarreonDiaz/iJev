// What real photos measure like, from a separate set (samples/calibration) so
// the benchmark photos stay unseen. The describer uses these percentiles to say
// "darker than most photos" instead of thresholds tuned on one wallpaper.
//
//   node src/fetch-photos.ts 40 --page 3 --dir samples/calibration
//   node src/calibrate.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { load, measure } from './editor.ts'

const PERCENTILES = [5, 10, 20, 35, 50, 65, 80, 90, 95]
const files: { file: string }[] = JSON.parse(readFileSync('samples/calibration/manifest.json', 'utf8'))
const all = await Promise.all(files.map(async (f) => measure(await load(`samples/calibration/${f.file}`))))
const result: Record<string, Record<string, number>> = {}
for (const metric of ['brightness', 'contrast', 'saturation', 'warmth'] as const) {
  const values = all.map((m) => m[metric]).sort((a, b) => a - b)
  result[metric] = Object.fromEntries(PERCENTILES.map((p) => {
    const v = values[Math.min(values.length - 1, Math.round((p / 100) * (values.length - 1)))]
    return [`p${p}`, +v.toFixed(metric === 'saturation' ? 3 : 1)]
  }))
}
writeFileSync('calibration.json', JSON.stringify({ photos: all.length, source: 'samples/calibration (picsum page 3)', ...result }, null, 2) + '\n')
console.log(JSON.stringify(result, null, 1))
