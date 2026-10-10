// The retina: an image as text, made by plain code (no models), so Jev can "see" it.
// 1. SLIC cuts the image into small patches; neighbors of similar color merge
//    into 20-40 segments.
// 2. A segment map: a grid of letters, one per segment, so the layout reads as text.
// 3. A legend per letter: color, size, where, shape numbers, what it touches and
//    contains, and a small silhouette in # and . for Jev to read the shape from.
import { nameColor, segment, toLab, type Segmentation } from './regions.ts'

export type Seg = {
  letter: string
  id: number
  regions: number[]
  rgb: [number, number, number]
  area: number // share of the image, 0-1
  box: [number, number, number, number] // in map cells: left, top, right, bottom (inclusive)
  center: [number, number] // 0-1
  fill: number // share of its bounding box it fills
  texture: number
  edges: string[]
  inside?: string // letter of the segment around it
  contains: string[]
  touches: string[]
  silhouette: string[]
}
export type Sight = { seg: Segmentation; segs: Seg[]; segOf: Int32Array; map: string[]; cols: number; rows: number }

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export async function see(path: string, { cols = 48, maxSegments = 36, slicWidth = 240, slicCount = 320 } = {}): Promise<Sight> {
  const seg = await segment(path, { width: slicWidth, count: slicCount })
  const lab = seg.regions.map((r) => toLab(...r.rgb))
  const edgesList: [number, number, number][] = []
  for (const r of seg.regions) for (const n of r.neighbors) if (n > r.id) edgesList.push([r.id, n, dist(lab[r.id], lab[n])])
  edgesList.sort((a, b) => a[2] - b[2])

  // Merge neighbors whose (running) mean colors are close; raise the bar until few enough remain.
  let parent: number[] = []
  let mean: number[][] = []
  let size: number[] = []
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const union = (a: number, b: number) => {
    const [ra, rb] = [find(a), find(b)]
    if (ra === rb) return
    const s = size[ra] + size[rb]
    mean[ra] = mean[ra].map((v, c) => (v * size[ra] + mean[rb][c] * size[rb]) / s)
    size[ra] = s
    parent[rb] = ra
  }
  for (const threshold of [8, 11, 14, 18, 23, 29, 36, 45, 60]) {
    parent = seg.regions.map((r) => r.id)
    mean = lab.map((v) => [...v])
    size = seg.regions.map((r) => r.size)
    for (const [a, b] of edgesList) { const [ra, rb] = [find(a), find(b)]; if (ra !== rb && dist(mean[ra], mean[rb]) < threshold) union(a, b) }
    // Specks join their closest neighbor.
    for (let pass = 0; pass < 3; pass++) {
      for (const r of seg.regions) {
        const root = find(r.id)
        if (size[root] >= 0.004) continue
        let best = -1, bd = Infinity
        for (const n of r.neighbors) { const rn = find(n); if (rn !== root && dist(mean[root], mean[rn]) < bd) { bd = dist(mean[root], mean[rn]); best = rn } }
        if (best >= 0) union(best, root)
      }
    }
    if (new Set(seg.regions.map((r) => find(r.id))).size <= maxSegments) break
  }

  // Segments, biggest first, lettered A, B, C...
  const roots = [...new Set(seg.regions.map((r) => find(r.id)))].sort((a, b) => size[b] - size[a]).slice(0, LETTERS.length)
  const indexOf = new Map(roots.map((r, i) => [r, i]))
  const segOf = new Int32Array(seg.labels.length)
  for (let i = 0; i < seg.labels.length; i++) segOf[i] = indexOf.get(find(seg.labels[i])) ?? 0

  // The map: each cell shows the segment most of its pixels belong to.
  const rows = Math.max(4, Math.round((cols * seg.height) / seg.width / 2)) // text cells are about twice as tall as wide
  const cellOf = new Int32Array(cols * rows)
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const counts = new Map<number, number>()
    for (let y = Math.floor((cy * seg.height) / rows); y < Math.floor(((cy + 1) * seg.height) / rows); y++)
      for (let x = Math.floor((cx * seg.width) / cols); x < Math.floor(((cx + 1) * seg.width) / cols); x++) {
        const s = segOf[y * seg.width + x]
        counts.set(s, (counts.get(s) ?? 0) + 1)
      }
    cellOf[cy * cols + cx] = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0
  }
  const map = Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => LETTERS[cellOf[y * cols + x]]).join(''))

  // Who borders whom, counted along pixel edges.
  const border = roots.map(() => new Map<number, number>())
  for (let y = 0; y < seg.height; y++) for (let x = 0; x < seg.width; x++) {
    const a = segOf[y * seg.width + x]
    for (const [nx, ny] of [[x + 1, y], [x, y + 1]]) {
      if (nx >= seg.width || ny >= seg.height) continue
      const b = segOf[ny * seg.width + nx]
      if (a === b) continue
      border[a].set(b, (border[a].get(b) ?? 0) + 1)
      border[b].set(a, (border[b].get(a) ?? 0) + 1)
    }
  }

  const segs: Seg[] = roots.map((root, i) => {
    const regions = seg.regions.filter((r) => find(r.id) === root).map((r) => r.id)
    const w = regions.reduce((a, id) => a + seg.regions[id].size, 0)
    const rgb = [0, 1, 2].map((c) => regions.reduce((a, id) => a + seg.regions[id].rgb[c] * seg.regions[id].size, 0) / w) as [number, number, number]
    const cells: [number, number][] = []
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (cellOf[y * cols + x] === i) cells.push([x, y])
    let [l, t, r, b] = [cols, rows, -1, -1]
    for (const [x, y] of cells) { l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y) }
    if (!cells.length) [l, t, r, b] = [0, 0, 0, 0]
    // Fill and edges from the pixels, not the coarse map.
    let px = 0, minX = seg.width, minY = seg.height, maxX = 0, maxY = 0, sx = 0, sy = 0
    for (let y = 0; y < seg.height; y++) for (let x = 0; x < seg.width; x++) if (segOf[y * seg.width + x] === i) {
      px++; sx += x; sy += y
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
    }
    const fill = px / ((maxX - minX + 1) * (maxY - minY + 1))
    const edges = [minY === 0 && 'top', maxY === seg.height - 1 && 'bottom', minX === 0 && 'left', maxX === seg.width - 1 && 'right'].filter(Boolean) as string[]
    const total = [...border[i].values()].reduce((a, v) => a + v, 0)
    const [around, share] = [...border[i]].sort((a, b) => b[1] - a[1])[0] ?? [-1, 0]
    return {
      letter: LETTERS[i],
      id: i,
      regions,
      rgb,
      area: w,
      box: [l, t, r, b],
      center: [sx / px / seg.width, sy / px / seg.height],
      fill,
      texture: regions.reduce((a, id) => a + seg.regions[id].texture * seg.regions[id].size, 0) / w,
      edges,
      inside: !edges.length && total && share / total > 0.75 ? LETTERS[around] : undefined,
      contains: [],
      touches: [...border[i]].filter(([, n]) => n / (total || 1) > 0.08).sort((a, b) => b[1] - a[1]).map(([s]) => LETTERS[s]),
      silhouette: silhouette(segOf, seg.width, i, minX, minY, maxX, maxY),
    }
  })
  for (const s of segs) if (s.inside) segs.find((o) => o.letter === s.inside)?.contains.push(s.letter)
  return { seg, segs, segOf, map, cols, rows }
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** The segment's shape in its bounding box, at most 20 wide and 10 tall, # inside and . outside. */
function silhouette(segOf: Int32Array, width: number, id: number, minX: number, minY: number, maxX: number, maxY: number): string[] {
  const w = maxX - minX + 1, h = maxY - minY + 1
  if (w <= 0 || h <= 0) return []
  // Keep proportions, remembering text cells are about twice as tall as wide.
  const scale = Math.max(w / 20, h / 20)
  const cw = Math.max(1, Math.round(w / scale)), ch = Math.max(1, Math.round(h / scale / 2))
  const rows: string[] = []
  for (let cy = 0; cy < ch; cy++) {
    let row = ''
    for (let cx = 0; cx < cw; cx++) {
      let inside = 0, all = 0
      for (let y = minY + Math.floor((cy * h) / ch); y < minY + Math.floor(((cy + 1) * h) / ch); y++)
        for (let x = minX + Math.floor((cx * w) / cw); x < minX + Math.floor(((cx + 1) * w) / cw); x++) { all++; if (segOf[y * width + x] === id) inside++ }
      row += all && inside / all >= 0.5 ? '#' : '.'
    }
    rows.push(row)
  }
  return rows
}

const where = ([x, y]: [number, number]) => `${y < 0.33 ? 'top' : y < 0.67 ? 'middle' : 'bottom'} ${x < 0.33 ? 'left' : x < 0.67 ? 'center' : 'right'}`

/** The whole picture as text: the letter map plus one legend line per segment. */
export function describe(sight: Sight, { silhouettes = true } = {}) {
  return {
    how_to_read: `The image is drawn as a ${sight.cols} x ${sight.rows} grid of letters. Each letter is one segment of similar color; the legend says what each looks like. Row 1 is the top. Letters go from the biggest segment (A) to the smallest. A silhouette shows a segment's shape: # is the segment, . is not, and each character is about twice as tall as wide.`,
    map: sight.map,
    legend: Object.fromEntries(sight.segs.map((s) => [s.letter, legendLine(s, silhouettes)])),
  }
}

export function legendLine(s: Seg, silhouettes = true) {
  const background = s.edges.length >= 3 && s.area > 0.3
  return {
    ...(background && { looks_like: 'the background' }),
    color: `${nameColor(...s.rgb)} (rgb ${s.rgb.map(Math.round).join(', ')})`,
    size: `${(s.area * 100).toFixed(s.area < 0.01 ? 1 : 0)}% of the image`,
    where: where(s.center),
    box_in_map: `columns ${s.box[0] + 1}-${s.box[2] + 1}, rows ${s.box[1] + 1}-${s.box[3] + 1}`,
    fills_its_box: `${Math.round(s.fill * 100)}%`,
    texture: s.texture < 3 ? 'smooth' : s.texture < 8 ? 'some texture' : 'busy',
    ...(s.edges.length && { touches_image_edge: s.edges.join(', ') }),
    ...(s.inside && { inside: s.inside }),
    ...(s.contains.length && { contains: s.contains.join(', ') }),
    borders: s.touches.join(', '),
    ...(silhouettes && s.silhouette.length && { silhouette: s.silhouette }),
  }
}
