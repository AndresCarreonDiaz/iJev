// Cut a photo into a few hundred regions that follow its edges (SLIC
// superpixels), and describe each one in words, so Jev can say which regions
// an instruction is about.
import sharp from 'sharp'

export type Region = { id: number; x: number; y: number; size: number; rgb: [number, number, number]; texture: number; neighbors: Set<number>; edges: string[] }
export type Segmentation = { width: number; height: number; labels: Int32Array; regions: Region[] }

export function toLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const [R, G, B] = [lin(r), lin(g), lin(b)]
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.9505), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.089)
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)]
}

/** SLIC on a small copy of the photo: k-means over color and position, with a local search window. */
export async function segment(path: string, { width = 240, count = 350, compactness = 12 } = {}): Promise<Segmentation> {
  const { data, info } = await sharp(path).rotate().resize({ width }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const W = info.width, H = info.height, N = W * H
  const lab = new Float32Array(N * 3)
  for (let i = 0; i < N; i++) lab.set(toLab(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]), i * 3)
  const S = Math.sqrt(N / count)
  const centers: number[][] = []
  for (let y = S / 2; y < H; y += S) for (let x = S / 2; x < W; x += S) {
    const i = Math.floor(y) * W + Math.floor(x)
    centers.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2], x, y])
  }
  const labels = new Int32Array(N).fill(-1)
  const dist = new Float32Array(N)
  for (let iter = 0; iter < 10; iter++) {
    dist.fill(Infinity)
    centers.forEach(([L, A, B, cx, cy], k) => {
      for (let y = Math.max(0, Math.floor(cy - 2 * S)); y < Math.min(H, cy + 2 * S); y++) {
        for (let x = Math.max(0, Math.floor(cx - 2 * S)); x < Math.min(W, cx + 2 * S); x++) {
          const i = y * W + x
          const dc = (lab[i * 3] - L) ** 2 + (lab[i * 3 + 1] - A) ** 2 + (lab[i * 3 + 2] - B) ** 2
          const ds = ((x - cx) ** 2 + (y - cy) ** 2) / (S * S)
          const d = dc + ds * compactness * compactness
          if (d < dist[i]) { dist[i] = d; labels[i] = k }
        }
      }
    })
    const sums = centers.map(() => [0, 0, 0, 0, 0, 0])
    for (let i = 0; i < N; i++) {
      const s = sums[labels[i]]
      s[0] += lab[i * 3]; s[1] += lab[i * 3 + 1]; s[2] += lab[i * 3 + 2]; s[3] += i % W; s[4] += Math.floor(i / W); s[5]++
    }
    sums.forEach((s, k) => { if (s[5]) centers[k] = [s[0] / s[5], s[1] / s[5], s[2] / s[5], s[3] / s[5], s[4] / s[5]] })
  }

  // Renumber the labels that survived and describe each region.
  const used = [...new Set(labels)]
  const remap = new Map(used.map((k, i) => [k, i]))
  for (let i = 0; i < N; i++) labels[i] = remap.get(labels[i])!
  const acc = used.map(() => ({ x: 0, y: 0, n: 0, r: 0, g: 0, b: 0, l: 0, l2: 0, top: false, bottom: false, left: false, right: false, neighbors: new Set<number>() }))
  for (let i = 0; i < N; i++) {
    const a = acc[labels[i]], x = i % W, y = Math.floor(i / W), l = lab[i * 3]
    a.x += x; a.y += y; a.n++; a.r += data[i * 3]; a.g += data[i * 3 + 1]; a.b += data[i * 3 + 2]; a.l += l; a.l2 += l * l
    if (y === 0) a.top = true
    if (y === H - 1) a.bottom = true
    if (x === 0) a.left = true
    if (x === W - 1) a.right = true
    if (x + 1 < W && labels[i + 1] !== labels[i]) { a.neighbors.add(labels[i + 1]); acc[labels[i + 1]].neighbors.add(labels[i]) }
    if (y + 1 < H && labels[i + W] !== labels[i]) { a.neighbors.add(labels[i + W]); acc[labels[i + W]].neighbors.add(labels[i]) }
  }
  const regions: Region[] = acc.map((a, id) => ({
    id,
    x: a.x / a.n / W,
    y: a.y / a.n / H,
    size: a.n / N,
    rgb: [a.r / a.n, a.g / a.n, a.b / a.n],
    texture: Math.sqrt(Math.max(0, a.l2 / a.n - (a.l / a.n) ** 2)),
    neighbors: a.neighbors,
    edges: [a.top && 'top', a.bottom && 'bottom', a.left && 'left', a.right && 'right'].filter(Boolean) as string[],
  }))
  return { width: W, height: H, labels, regions }
}

export function nameColor(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255
  const l = (max + min) / 2, d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  if (s < 0.12 || d < 0.06) return l < 0.16 ? 'black' : l < 0.3 ? 'dark gray' : l < 0.6 ? 'gray' : l < 0.85 ? 'light gray' : 'white'
  const tone = l < 0.2 ? 'very dark ' : l < 0.38 ? 'dark ' : l < 0.65 ? '' : l < 0.85 ? 'light ' : 'very light '
  const muted = s < 0.3 ? 'grayish ' : ''
  const [R, G, B] = [r / 255, g / 255, b / 255]
  let h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  h = (h * 60 + 360) % 360
  const hue = h < 12 ? 'red' : h < 25 ? 'red-orange' : h < 40 ? 'orange' : h < 52 ? 'amber' : h < 68 ? 'yellow' : h < 90 ? 'yellow-green' : h < 150 ? 'green' : h < 185 ? 'teal' : h < 205 ? 'cyan' : h < 250 ? 'blue' : h < 285 ? 'purple' : h < 330 ? 'magenta' : 'red'
  return tone + muted + hue
}

const where = (x: number, y: number) => `${y < 0.33 ? 'top' : y < 0.67 ? 'middle' : 'bottom'} ${x < 0.33 ? 'left' : x < 0.67 ? 'center' : 'right'}`

/** One region in words: what Jev reads to decide whether an instruction is about it. */
export function describeRegion(r: Region, all: Region[]): string {
  const texture = r.texture < 3 ? 'smooth, flat color' : r.texture < 8 ? 'some texture' : 'busy, detailed'
  const around = [...r.neighbors]
    .map((n) => all[n])
    .sort((a, b) => b.size - a.size)
    .slice(0, 4)
    .map((n) => {
      const dx = n.x - r.x, dy = n.y - r.y
      const dir = Math.abs(dy) > Math.abs(dx) ? (dy < 0 ? 'above' : 'below') : dx < 0 ? 'left' : 'right'
      return `${dir}: ${nameColor(...n.rgb)}`
    })
  return [
    `${nameColor(...r.rgb)}, ${texture}`,
    `at ${Math.round(r.x * 100)}% from the left and ${Math.round(r.y * 100)}% from the top (${where(r.x, r.y)})`,
    r.edges.length ? `touches the ${r.edges.join(' and ')} edge` : '',
    `next to it, ${around.join('; ')}`,
  ].filter(Boolean).join('. ')
}

/** The whole photo as a 6x6 grid of color names, for context. */
export async function overview(path: string): Promise<string[]> {
  const { data } = await sharp(path).rotate().resize(6, 6, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const rows = []
  for (let y = 0; y < 6; y++) {
    const cells = []
    for (let x = 0; x < 6; x++) cells.push(nameColor(data[(y * 6 + x) * 3], data[(y * 6 + x) * 3 + 1], data[(y * 6 + x) * 3 + 2]))
    rows.push(cells.join(' | '))
  }
  return rows
}
