// Test photos: a macOS wallpaper plus damaged copies with a known answer.
// The damage is reversible with the edits Jev can pick, so the distance back to
// the original measures how well it fixed them.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import sharp from 'sharp'

const source = process.argv[2] ?? '/System/Library/Desktop Pictures/Sonoma.heic'
mkdirSync('samples', { recursive: true })
if (!existsSync('samples/sonoma.jpg')) {
  execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '1024', source, '--out', 'samples/sonoma.jpg'], { stdio: 'ignore' })
}
await sharp('samples/sonoma.jpg').modulate({ brightness: 0.55, saturation: 0.55 }).jpeg({ quality: 92 }).toFile('samples/sonoma-dark-dull.jpg')
await sharp('samples/sonoma.jpg').recomb([[0.85, 0, 0], [0, 0.97, 0], [0, 0, 1.15]]).linear(0.75, 128 * 0.25).jpeg({ quality: 92 }).toFile('samples/sonoma-cold-flat.jpg')
console.log('samples/sonoma.jpg, samples/sonoma-dark-dull.jpg, samples/sonoma-cold-flat.jpg')
