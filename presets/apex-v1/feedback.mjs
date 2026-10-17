import { Search, canonical, digest, randomSource } from './search-core.mjs'

/** Reuse the search runner's validation and scoring, without its parent sampler. */
export function scoreCandidate(cases, source, outcomes) {
  const search = new Search(cases, { mode: 'program', seed: 0, initialCandidates: 1, maxCandidates: 1 })
  const result = search.accept(source, outcomes)
  return { id: result.submitted, source, outcomes, checks: result.checks,
    passed: result.passed, group: result.pool[0].group }
}

/** Select complete executed facts. Metadata is kept out of the model's feedback text. */
export function selectFeedback({ cases, candidates, parentId, suiteHash, mode, maxBytes, maxItems, seed }) {
  if (!['signature', 'random'].includes(mode) || !Number.isInteger(maxBytes) || maxBytes < 2
    || !Number.isInteger(maxItems) || maxItems < 1 || maxItems > 8
    || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff
    || !/^[a-f0-9]{64}$/.test(suiteHash)) throw new Error('Invalid feedback selection configuration')
  if (!Array.isArray(candidates) || !candidates.length || candidates.length > 5) throw new Error('Require 1..5 feedback candidates')
  const pool = []
  for (const candidate of candidates) {
    const row = scoreCandidate(cases, candidate.source, candidate.outcomes)
    if (row.id !== candidate.id) throw new Error('Feedback source fingerprint mismatch')
    const previous = pool.find(p => p.id === row.id)
    if (previous && previous.group !== row.group) throw new Error('Feedback source changed its public behavior')
    if (!previous) pool.push(row)
  }
  const parent = pool.find(p => p.id === parentId)
  if (!parent) throw new Error('Feedback parent is missing')
  // Measure each fact once; matching repeatedly scans the same bounded pool.
  const lengths = new Map()
  const bytes = entry => lengths.get(entry)
  const bin = entry => Math.floor(bytes(entry) / 256)
  const packetBytes = entries => 2 + entries.reduce((total, entry) => total + bytes(entry), 0) + Math.max(0, entries.length - 1)
  const groups = new Map(), eligible = []
  cases.forEach((c, index) => {
    if (typeof c.expectedSource !== 'string' || !c.expectedSource.trim()) throw new Error('Public cases require expectedSource')
    if (parent.checks[index]) return
    const entry = { index, input: c.input, expected: c.expected, expectedSource: c.expectedSource,
      actual: parent.outcomes[index], sourceHash: parentId, suiteHash, caseHash: digest(canonical(c)) }
    lengths.set(entry, Buffer.byteLength(JSON.stringify(entry)))
    const signature = pool.map(p => p.checks[index] ? '1' : '0').join('')
    if (!groups.has(signature)) groups.set(signature, [])
    groups.get(signature).push(entry)
    if (packetBytes([entry]) <= maxBytes) eligible.push(entry)
  })
  const ordered = [...groups.keys()].sort().map(key => groups.get(key).slice()
    .sort((a, b) => bytes(a) - bytes(b) || a.index - b.index))
  const signaturePacket = []
  while (signaturePacket.length < maxItems) {
    let added = false
    for (const group of ordered) {
      const next = group.findIndex(entry => packetBytes([...signaturePacket, entry]) <= maxBytes)
      if (next < 0) continue
      signaturePacket.push(group.splice(next, 1)[0]); added = true
      if (signaturePacket.length === maxItems) break
    }
    if (!added) break
  }
  const selectedIds = new Set(signaturePacket.map(e => e.index))
  const distinctFeasiblePackage = signaturePacket.some(old => eligible.some(next =>
    !selectedIds.has(next.index) && bin(next) === bin(old)
    && packetBytes(signaturePacket) - bytes(old) + bytes(next) <= maxBytes))
  const random = randomSource(seed), randomPacket = [], remaining = [...eligible]
  const slots = signaturePacket.map(bin)
  // ponytail: at most 256 checks and 8 slots; bounded scans keep feasible sampling explicit.
  for (let i = 0; i < slots.length; i++) {
    const feasible = remaining.filter(entry => {
      if (bin(entry) !== slots[i]) return false
      const needed = new Map()
      for (const slot of slots.slice(i + 1)) needed.set(slot, (needed.get(slot) ?? 0) + 1)
      const tail = []
      for (const [slot, count] of needed) {
        const choices = remaining.filter(e => e !== entry && bin(e) === slot).sort((a, b) => bytes(a) - bytes(b))
        if (choices.length < count) return false
        tail.push(...choices.slice(0, count))
      }
      return packetBytes([...randomPacket, entry, ...tail]) <= maxBytes
    })
    if (!feasible.length) throw new Error('No feasible matched feedback package')
    const chosen = feasible[Math.floor(random() * feasible.length)]
    randomPacket.push(chosen); remaining.splice(remaining.indexOf(chosen), 1)
  }
  // Both arms present facts in the same public-case order. Never resample identical packets.
  const sort = entries => [...entries].sort((a, b) => a.index - b.index)
  const selected = sort(mode === 'signature' ? signaturePacket : randomPacket)
  const ids = entries => sort(entries).map(e => e.index)
  const reasons = []
  if (pool.length < 2) reasons.push('fewer-than-two-distinct-sources')
  if (groups.size < 2) reasons.push('fewer-than-two-failure-signatures')
  if (!distinctFeasiblePackage) reasons.push('no-distinct-length-matched-package')
  return { feedback: selected, metadata: { mode, seed, parentId, suiteHash,
    poolIds: pool.map(p => p.id), failureSignatures: groups.size, eligibleCases: eligible.length,
    selectedIds: ids(selected), signatureIds: ids(signaturePacket), randomIds: ids(randomPacket),
    bytes: packetBytes(selected), maxBytes, maxItems, lengthBinBytes: 256,
    identicalPackages: JSON.stringify(ids(signaturePacket)) === JSON.stringify(ids(randomPacket)),
    researchEligible: reasons.length === 0, reasons } }
}
