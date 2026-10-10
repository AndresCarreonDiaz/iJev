// Smallest possible client for TypeSafe's System One API (Jev).
// Jev reads text only, so every caller turns its image into words before asking.
import { readFileSync } from 'node:fs'

const URL = process.env.TYPESAFE_API_URL ?? 'https://api.typesafe.ai/v1/systemone'
const MODEL = process.env.JEV_MODEL ?? 'jev-latest'
const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000

export type Choice = { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> }
export type Noul = { type: 'noul'; instructions: unknown; criteria?: { true: unknown; false: unknown } }
export type Score = { type: 'score'; instructions: unknown; criteria: unknown[] }
export type Question = Choice | Noul | Score

export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export type NoulAnswer = { type: 'noul'; noul: number }
export type ScoreAnswer = { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> }

export const usage = { requests: 0, inputTokens: 0, ms: 0 }

function apiKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY
  try {
    const line = readFileSync(new globalThis.URL('../.env', import.meta.url), 'utf8').match(/^TYPESAFE_API_KEY=(.+)$/m)
    if (line) return line[1].trim().replace(/^["']|["']$/g, '')
  } catch {}
  throw new Error('Set TYPESAFE_API_KEY or put it in .env')
}

export async function ask<Q extends Record<string, Question>>(
  state: unknown,
  questions: Q,
): Promise<{ [K in keyof Q]: Q[K] extends Choice ? ChoiceAnswer : Q[K] extends Score ? ScoreAnswer : NoulAnswer }> {
  const body = JSON.stringify({ model: MODEL, state, questions })
  const key = apiKey()
  for (let attempt = 0; ; attempt++) {
    const started = performance.now()
    const response = await fetch(URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    })
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt))
      continue
    }
    const text = await response.text()
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}: ${text.slice(0, 300)}`)
    const json = JSON.parse(text)
    usage.requests++
    usage.inputTokens += json.usage?.input_tokens ?? 0
    usage.ms += performance.now() - started
    return json.answers
  }
}

export function costLine(): string {
  const usd = usage.inputTokens * USD_PER_INPUT_TOKEN
  const average = usage.requests ? Math.round(usage.ms / usage.requests) : 0
  return `${usage.requests} Jev requests, ${usage.inputTokens.toLocaleString()} input tokens, $${usd.toFixed(5)}, ~${average} ms average`
}
