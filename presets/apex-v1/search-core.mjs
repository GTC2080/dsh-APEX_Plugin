import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export const digest = value => createHash('sha256').update(value).digest('hex')

/** Stable JSON key order; rejects values that JSON would silently discard. */
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + Array.from(value, canonical).join(',') + ']'
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  }
  throw new Error('Expected a finite JSON value')
}

/** Deterministic experiment randomness; not a security token generator. */
export function randomSource(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ t >>> 15, t | 1)
    t ^= t + Math.imul(t ^ t >>> 7, t | 61)
    return (((t ^ t >>> 14) >>> 0) + 0.5) / 4294967296
  }
}

/** Marsaglia–Tsang gamma sampler, restricted to the shapes >= 1 used here. */
function gamma(shape, random) {
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d)
  for (let attempt = 0; attempt < 10000; attempt++) {
    const x = Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random())
    const v = (1 + c * x) ** 3
    if (v <= 0) continue
    const u = random()
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < x * x / 2 + d * (1 - v + Math.log(v))) return d * v
  }
  throw new Error('Gamma sampler did not converge')
}

export function beta(alpha, b, random) {
  if (![alpha, b].every(x => Number.isFinite(x) && x >= 1)) throw new Error('Beta shapes must be >= 1')
  const x = gamma(alpha, random), y = gamma(b, random)
  return x / (x + y)
}

/** Both policies retain independent member failures and one restart entry. */
export function choose(pool, mode, random, restartFailures = 0) {
  if (!['program', 'behavior'].includes(mode)) throw new Error('Unknown search mode')
  const groups = new Map(), ordered = [...pool].sort((a, b) => a.id.localeCompare(b.id, 'en'))
  for (const p of ordered) {
    if (!groups.has(p.group)) groups.set(p.group, [])
    groups.get(p.group).push(p)
  }
  const nominees = mode === 'program' ? [...ordered]
    : [...groups.values()].map(g => g.length === 1 ? g[0] : g[Math.floor(random() * g.length)])
  nominees.push({ id: 'restart', h: 0, failures: restartFailures })
  const scores = nominees.map(p => ({ id: p.id, score: p.id === 'restart'
    ? beta(1, 1 + p.failures, random) : beta(1 + 5 * p.h, 1 + 5 * (1 - p.h) + p.failures, random) }))
  let winner = scores[0]
  for (const p of scores.slice(1)) if (p.score > winner.score) winner = p
  return { selected: winner.id, scores, groupSizes: [...groups.values()].map(g => g.length) }
}

/** Bounded live search state. I/O and serialized tool calls belong to the plugin. */
export class Search {
  constructor(cases, { mode, seed, initialCandidates, maxCandidates }) {
    if (!Array.isArray(cases) || !cases.length || cases.length > 256) throw new Error('Require 1..256 public cases')
    for (const c of cases) {
      if (!c || !Object.hasOwn(c, 'input') || !Object.hasOwn(c, 'expected')) throw new Error('Each case needs input and expected')
      canonical(c.input); canonical(c.expected)
    }
    if (!['program', 'behavior'].includes(mode) || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff
      || !Number.isSafeInteger(initialCandidates) || initialCandidates < 1
      || !Number.isSafeInteger(maxCandidates) || maxCandidates < initialCandidates || maxCandidates > 32) throw new Error('Invalid search configuration')
    this.cases = structuredClone(cases)
    this.mode = mode; this.seed = seed; this.random = randomSource(seed)
    this.initialCandidates = initialCandidates; this.maxCandidates = maxCandidates
    this.pool = []; this.attempts = 0; this.restartFailures = 0
    this.pending = 'restart'; this.done = false
  }

  accept(source, outcomes) {
    if (this.done) throw new Error('Search already finished')
    if (typeof source !== 'string' || Buffer.byteLength(source) > 131072 || !source.trim()) throw new Error('Invalid candidate source')
    if (!Array.isArray(outcomes) || outcomes.length !== this.cases.length) throw new Error('Incomplete execution results')
    for (const o of outcomes) {
      if (o?.kind === 'value') canonical(o.value)
      else if (!['runtime-error', 'syntax-error', 'invalid-result', 'timeout', 'process-error'].includes(o?.kind)) throw new Error('Invalid execution outcome')
    }
    const parent = this.pending, id = digest(source)
    const checks = outcomes.map((o, i) => o.kind === 'value' && isDeepStrictEqual(o.value, this.cases[i].expected))
    const passed = checks.filter(Boolean).length, h = passed / checks.length
    const group = digest(canonical(outcomes.map(o => o.kind === 'value' ? { kind:o.kind, value:o.value } : { kind:o.kind })))
    const duplicate = this.pool.find(p => p.id === id)
    if (duplicate && duplicate.group !== group) throw new Error('Identical source changed its public behavior; search is not deterministic')
    this.attempts++
    if (passed !== checks.length) {
      if (parent === 'restart') this.restartFailures++
      else this.pool.find(p => p.id === parent).failures++
    }
    if (!duplicate) this.pool.push({ id, source, group, h, failures: 0 })
    const finished = passed === checks.length || this.attempts >= this.maxCandidates
    let decision
    if (finished) {
      const best = [...this.pool].sort((a, b) => b.h - a.h || a.id.localeCompare(b.id, 'en'))[0]
      this.done = true; this.pending = best.id
      decision = { selected: best.id, scores: [], groupSizes: [] }
    } else if (this.attempts < this.initialCandidates) {
      this.pending = 'restart'; decision = { selected: 'restart', scores: [], groupSizes: [] }
    } else {
      decision = choose(this.pool, this.mode, this.random, this.restartFailures)
      this.pending = decision.selected
    }
    return { attempt: this.attempts, submitted: id, parent, duplicate: Boolean(duplicate), passed,
      total: checks.length, checks, outcomes, ...decision, done: this.done,
      reason: finished ? (passed === checks.length ? 'public-pass' : 'candidate-budget') : 'continue',
      pool: this.pool.map(({ source: _, ...p }) => p), restartFailures: this.restartFailures }
  }

  selectedSource() { return this.pending === 'restart' ? '' : this.pool.find(p => p.id === this.pending).source }
}
