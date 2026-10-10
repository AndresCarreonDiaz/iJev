// Random scenes of flat shapes with known contents, for testing whether Jev sees.
export const W = 320, H = 240
export const SHAPES = ['circle', 'square', 'triangle'] as const
export const COLORS: Record<string, string> = { red: '#d82828', blue: '#2850d0', green: '#2a9a3a', yellow: '#f0cc20', purple: '#8a3cb8', orange: '#f08020', black: '#202020' }
export const BACKGROUNDS: Record<string, string> = { white: '#ffffff', 'light gray': '#d8d8d8', beige: '#efe2c4', 'light blue': '#bcd8f0' }
export const PLACES = ['top left', 'top center', 'top right', 'middle left', 'middle center', 'middle right', 'bottom left', 'bottom center', 'bottom right']

export type Shape = { type: (typeof SHAPES)[number]; color: string; cell: number; size: number }
export type Scene = { background: string; shapes: Shape[] }

export function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export const pickFrom = <T>(xs: readonly T[], rand: () => number) => xs[Math.floor(rand() * xs.length)]
export const shuffle = <T>(xs: T[], rand: () => number) => xs.map((x) => [rand(), x] as const).sort((a, b) => a[0] - b[0]).map(([, x]) => x)

/** 2-4 shapes, each in its own ninth of the canvas (so "where" has one answer), sizes clearly different. */
export function makeScene(rand: () => number): Scene {
  const n = 2 + Math.floor(rand() * 3)
  const cells = shuffle([...Array(9).keys()], rand).slice(0, n)
  const colors = shuffle(Object.keys(COLORS), rand).slice(0, n)
  const sizes = shuffle([30, 42, 56, 70].slice(0, n), rand)
  return {
    background: pickFrom(Object.keys(BACKGROUNDS), rand),
    shapes: cells.map((cell, i) => ({ type: pickFrom(SHAPES, rand), color: colors[i], cell, size: sizes[i] })),
  }
}

export function svg(scene: Scene): string {
  const parts = scene.shapes.map(({ type, color, cell, size }) => {
    const cx = ((cell % 3) + 0.5) * (W / 3), cy = (Math.floor(cell / 3) + 0.5) * (H / 3), r = size / 2, fill = COLORS[color]
    if (type === 'circle') return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`
    if (type === 'square') return `<rect x="${cx - r}" y="${cy - r}" width="${size}" height="${size}" fill="${fill}"/>`
    return `<polygon points="${cx - r},${cy + r * 0.87} ${cx},${cy - r * 0.87} ${cx + r},${cy + r * 0.87}" fill="${fill}"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${BACKGROUNDS[scene.background]}"/>${parts.join('')}</svg>`
}

