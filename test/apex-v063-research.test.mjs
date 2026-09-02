import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APEX_RESEARCH_DESCRIPTION,
  apply as applyResearch,
  fetchResearchSource,
  isPublicIpv4,
  normalizeResearch,
  RESEARCH_CHILD_PERSONA,
  RESEARCH_CHILD_TOOLS,
  RESEARCH_OUTPUT_SCHEMA,
} from '../presets/apex-v063/apex-research.mjs'
import {
  enforceFlashWorkspace,
  RESEARCH_CHILD_SANDBOX_MODE,
} from '../presets/apex-v063/apex-policy.mjs'
import {
  deferResearchSearchExecution,
  guardExecution,
  researchPhaseDenial,
  RESEARCH_SEARCH_FAILURE_REASON,
  RESEARCH_SEARCH_PAUSED_REASON,
  RESEARCH_SEARCH_STAGNANT_REASON,
} from '../presets/apex-v063/execution-guard.mjs'
import {
  apply as applyGate,
  BOOTSTRAP_TOOLS,
  FLASH_MAX_MODEL,
  FLASH_MAX_PROVIDER,
  FLASH_MAX_REASONING_EFFORT,
  phaseFor,
  RESEARCH_CHILD_LABEL_PREFIX,
  RESEARCH_DEFERRED_SEARCH_PREFIX,
  RESEARCH_SOURCE_META_KIND,
  RESEARCH_SOURCE_TOOL,
  RESEARCH_CHILD_TOOLS as GATED_RESEARCH_TOOLS,
  RESEARCH_META_KIND,
  researchChildEvidenceState,
  UNLOCK_META_KIND,
} from '../presets/apex-v063/tool-gate.mjs'

function agent(events = [], delegationDepth = 0, options = {}) {
  const session = {
    events: [...events],
    header: { cwd: '/workspace', delegationDepth },
    append(type, data) {
      this.events.push({ type, data })
    },
  }
  return { options, session }
}

function successfulCall(name, callId = `${name}-1`) {
  return [
    { type: 'tool/call', data: { name, callId, arguments: '{}' } },
    {
      type: 'tool/result',
      data: {
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            isError: false,
            content: [{ type: 'text', text: 'ok' }],
          }],
        },
      },
    },
  ]
}

function unlockedResearch() {
  return {
    type: 'tool/result',
    data: {
      meta: {
        kind: UNLOCK_META_KIND,
        matchedTools: ['apex_research'],
        unlockedTools: ['apex_research'],
      },
    },
  }
}

const sufficientEvidence = {
  status: 'sufficient',
  answer: 'A fixed-step semi-implicit Euler update is more stable than explicit Euler for this bounded interactive case.',
  claims: [{
    claim: 'Semi-implicit Euler updates velocity before position.',
    evidence: 'The referenced numerical integration documentation defines the update order directly.',
    sources: [{
      title: 'Authoritative integration documentation',
      url: 'https://example.org/numerical-integration',
      kind: 'official-documentation',
    }],
    confidence: 0.92,
  }],
  implementation_constraints: ['Update velocity before position and keep the fixed step bounded.'],
  conflicts: [],
  remaining_gaps: [],
}

function researchRuntime(outputs = [sufficientEvidence], fetchSource = async (url) => ({
  url,
  content: 'Verified source content.',
  contentHash: 'a'.repeat(64),
  contentType: 'text/plain',
  truncated: false,
})) {
  const tools = new Map()
  const starts = []
  applyResearch({
    tools: {
      register(value) {
        tools.set(value.name, value)
        return () => {}
      },
    },
    subagents: {
      async start(provider, request) {
        starts.push({ provider, request })
        const structured = outputs[Math.min(starts.length - 1, outputs.length - 1)]
        return {
          result: Promise.resolve({ structured, stopReason: 'completed' }),
          async dispose() {},
        }
      },
    },
  }, { fetchSource })
  return {
    tool: tools.get('apex_research'),
    sourceTool: tools.get(RESEARCH_SOURCE_TOOL),
    starts,
    tools,
  }
}

function researchEvent(tool, args, value) {
  return {
    type: 'tool/result',
    data: { meta: tool.output.presentationMeta(args, value) },
  }
}

function successfulResult(callId, meta = {}, text = 'ok') {
  return {
    type: 'tool/result',
    data: {
      meta,
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          isError: false,
          content: [{ type: 'text', text }],
        }],
      },
    },
  }
}

function successfulSearch(callId, sources) {
  return [
    {
      type: 'tool/call',
      data: { name: 'web_search', callId, arguments: '{"query":"focused query"}' },
    },
    successfulResult(callId, { sources }),
  ]
}

function failedSearch(callId, code, message) {
  return [
    {
      type: 'tool/call',
      data: { name: 'web_search', callId, arguments: '{"query":"focused query"}' },
    },
    {
      type: 'tool/result',
      data: {
        error: { name: 'WebError', code },
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            isError: true,
            content: [{ type: 'text', text: `Error: ${message}` }],
          }],
        },
      },
    },
  ]
}

function successfulSourceRead(callId, url, contentHash = 'a'.repeat(64)) {
  return [
    {
      type: 'tool/call',
      data: { name: RESEARCH_SOURCE_TOOL, callId, arguments: JSON.stringify({ url }) },
    },
    successfulResult(callId, {
      kind: RESEARCH_SOURCE_META_KIND,
      url,
      contentHash,
      available: true,
    }),
  ]
}

function gateListener() {
  let listener
  applyGate({
    on(event, value) {
      if (event === 'system-prompt/assemble') listener = value
      return () => {}
    },
  })
  return listener
}

async function assemble(scopedAgent, tools) {
  return gateListener()(
    undefined,
    { agent: scopedAgent },
    async () => ({ sections: [], contexts: [], variables: {}, tools }),
  )
}

const parentCatalog = [
  { name: BOOTSTRAP_TOOLS[0], description: 'Run shell commands' },
  { name: 'str_replace_editor', description: 'Edit files' },
  { name: 'dev_tool_search', description: 'Discover optional tools' },
  { name: 'apex_research', description: APEX_RESEARCH_DESCRIPTION },
  ...GATED_RESEARCH_TOOLS.map(name => ({ name, description: name })),
]

test('research compiles one evidence gap for read-only Vision Flash and returns traceable claims', async () => {
  const runtime = researchRuntime()
  const args = {
    question: 'Which integration order is appropriate for a stable interactive suspension demo?',
    decision: 'Choose the state-update order and derive one regression invariant.',
    known_context: 'The browser demo uses a bounded fixed timestep.',
    source_requirements: ['Prefer authoritative numerical integration material.'],
  }

  const result = await runtime.tool.execute(args, {
    agent: agent(),
    signal: new AbortController().signal,
  })

  assert.equal(result.status, 'sufficient')
  assert.equal(result.claims.length, 1)
  assert.match(result.claims[0].claimId, /^research-[a-f0-9]{12}$/)
  assert.equal(runtime.starts.length, 1)
  const start = runtime.starts[0]
  assert.equal(start.provider, 'spawn')
  assert.deepEqual(start.request.agentOptions, {
    provider: FLASH_MAX_PROVIDER,
    model: FLASH_MAX_MODEL,
    reasoningEffort: FLASH_MAX_REASONING_EFFORT,
  })
  assert.equal(start.request.agentOptions.model, 'deepseek-v4-flash-vision-exp')
  assert.equal(start.request.persona, RESEARCH_CHILD_PERSONA)
  assert.deepEqual(start.request.toolFilter, { allow: [...RESEARCH_CHILD_TOOLS] })
  assert.deepEqual(start.request.outputSchema, RESEARCH_OUTPUT_SCHEMA)
  assert.equal(start.request.maxDepth, 1)
  assert.match(start.request.prompt[0].text, /integration order/i)
  assert.match(start.request.prompt[0].text, /engineering decision/i)
  assert.match(start.request.prompt[0].text, /Every reported claim must include/i)
  assert.match(start.request.prompt[0].text, /read at least one directly relevant source/i)
  assert.match(start.request.prompt[0].text, /only tools exposed in the current request/i)
  assert.match(start.request.prompt[0].text, /distinctive keywords/i)
  assert.match(start.request.prompt[0].text, /"confidence":0\.9/)
  assert.match(start.request.prompt[0].text, /not optional adjacent research topics/i)
  assert.doesNotMatch(start.request.prompt[0].text, /write code/i)
})

test('exact research evidence is cached while changed context permits another retrieval', async () => {
  const runtime = researchRuntime()
  const scopedAgent = agent()
  const args = {
    question: 'What does the canonical API require?',
    decision: 'Choose the compatible initialization call.',
  }

  const first = await runtime.tool.execute(args, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  scopedAgent.session.events.push(researchEvent(runtime.tool, args, first))
  const duplicate = await runtime.tool.execute(args, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(first.cached, false)
  assert.equal(duplicate.cached, true)
  assert.equal(runtime.starts.length, 1)

  const changed = await runtime.tool.execute({
    ...args,
    known_context: 'The target is version 2 of the API.',
  }, {
    agent: scopedAgent,
    signal: new AbortController().signal,
  })
  assert.equal(changed.cached, false)
  assert.equal(runtime.starts.length, 2)
  assert.match(runtime.tool.description, /without a task-wide call limit/i)
})

test('research normalization preserves conflicts and rejects untraceable sources', () => {
  const conflicted = normalizeResearch({
    ...sufficientEvidence,
    status: 'sufficient',
    conflicts: ['Two primary sources define different behavior for different API versions.'],
  })
  assert.equal(conflicted.status, 'conflicted')

  assert.throws(() => normalizeResearch({
    ...sufficientEvidence,
    status: 'unknown',
  }), /invalid evidence status/i)

  assert.throws(() => normalizeResearch({
    ...sufficientEvidence,
    claims: [{
      ...sufficientEvidence.claims[0],
      sources: [{ title: 'Local note', url: 'file:///tmp/note', kind: 'other' }],
    }],
  }), /traceable sources/i)

  assert.throws(() => normalizeResearch({
    ...sufficientEvidence,
    answer: 'x'.repeat(1_601),
  }), /invalid evidence packet/i)

  assert.throws(() => normalizeResearch({
    ...sufficientEvidence,
    claims: Array.from({ length: 11 }, () => sufficientEvidence.claims[0]),
  }), /at most 10 items/i)
})

test('research children are read-only and never use the text-only Flash route', () => {
  const researcher = agent([{
    type: 'subagent/descriptor',
    data: {
      version: 2,
      mode: 'one-shot',
      provider: 'spawn',
      label: `${RESEARCH_CHILD_LABEL_PREFIX} 01234567`,
    },
  }], 1, {
    provider: FLASH_MAX_PROVIDER,
    model: FLASH_MAX_MODEL,
    reasoningEffort: FLASH_MAX_REASONING_EFFORT,
  })
  assert.equal(researcher.options.reasoningEffort, FLASH_MAX_REASONING_EFFORT)
  assert.equal(enforceFlashWorkspace(researcher), true)
  assert.equal(researcher.session.events.at(-1).data.mode, RESEARCH_CHILD_SANDBOX_MODE)
  assert.notEqual(FLASH_MAX_MODEL, 'deepseek-v4-flash')
})

test('the tool gate preserves Minimal anchoring and isolates the research child tools', async () => {
  const anchored = await assemble(agent(), parentCatalog)
  assert.deepEqual(anchored.tools.map(tool => tool.name).sort(), [...BOOTSTRAP_TOOLS].sort())

  const parent = agent([...successfulCall(BOOTSTRAP_TOOLS[0]), unlockedResearch()])
  const promoted = await assemble(parent, parentCatalog)
  assert.equal(promoted.tools.some(tool => tool.name === 'apex_research'), true)

  const researcher = agent([{
    type: 'subagent/descriptor',
    data: {
      version: 2,
      mode: 'one-shot',
      provider: 'spawn',
      label: `${RESEARCH_CHILD_LABEL_PREFIX} 01234567`,
    },
  }], 1, { provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL })
  assert.equal(phaseFor(researcher).kind, 'research-child')
  const childCatalog = GATED_RESEARCH_TOOLS.map(name => ({ name, description: name }))
  const assembledResearcher = await assemble(researcher, childCatalog)
  assert.deepEqual(
    assembledResearcher.tools.map(tool => tool.name).sort(),
    ['structured_output', 'web_search'],
  )
  assert.equal(assembledResearcher.tools.some(tool => tool.name === RESEARCH_SOURCE_TOOL), false)
  assert.equal(assembledResearcher.tools.some(tool => tool.name === 'str_replace_editor'), false)

  const unpublished = agent([], 1, { provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL })
  assert.equal(phaseFor(unpublished).kind, 'child')
  const firstAssembly = await assemble(unpublished, childCatalog)
  assert.deepEqual(
    firstAssembly.tools.map(tool => tool.name).sort(),
    ['structured_output', 'web_search'],
  )
})

test('research evidence gating alternates new search evidence with bounded source reading', async () => {
  const urlA = 'https://example.org/a'
  const urlB = 'https://example.org/b#section'
  const researcher = agent([{
    type: 'subagent/descriptor',
    data: {
      version: 2,
      mode: 'one-shot',
      provider: 'spawn',
      label: `${RESEARCH_CHILD_LABEL_PREFIX} 01234567`,
    },
  }, ...successfulSearch('search-1', [
    { title: 'Source A', url: urlA },
    { title: 'Source B', url: urlB },
  ])], 1, { provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL })
  const childCatalog = GATED_RESEARCH_TOOLS.map(name => ({ name, description: name }))

  const awaitingRead = await assemble(researcher, childCatalog)
  assert.deepEqual(
    awaitingRead.tools.map(tool => tool.name).sort(),
    [RESEARCH_SOURCE_TOOL, 'structured_output'].sort(),
  )
  assert.deepEqual(researchChildEvidenceState(researcher).unreadSources.map(item => item.url), [
    urlA,
    'https://example.org/b',
  ])

  researcher.session.events.push(...successfulSourceRead('read-1', urlA))
  const afterRead = await assemble(researcher, childCatalog)
  assert.deepEqual(
    afterRead.tools.map(tool => tool.name).sort(),
    [RESEARCH_SOURCE_TOOL, 'structured_output', 'web_search'].sort(),
  )

  researcher.session.events.push(...successfulSearch('search-2', [{ title: 'Source A', url: urlA }]))
  researcher.session.events.push(...successfulSearch('search-3', [{ title: 'Source A', url: urlA }]))
  const stagnant = researchChildEvidenceState(researcher)
  assert.equal(stagnant.consecutiveNoNewSearches, 2)
  const converged = await assemble(researcher, childCatalog)
  assert.deepEqual(
    converged.tools.map(tool => tool.name).sort(),
    [RESEARCH_SOURCE_TOOL, 'structured_output'].sort(),
  )

  researcher.session.events.push(...successfulSearch('search-4', [{ title: 'Source C', url: 'https://example.org/c' }]))
  assert.equal(researchChildEvidenceState(researcher).consecutiveNoNewSearches, 0)
})

test('deterministic research provider failures stop search without retrying configuration errors', async () => {
  const descriptor = {
    type: 'subagent/descriptor',
    data: {
      version: 2,
      mode: 'one-shot',
      provider: 'spawn',
      label: `${RESEARCH_CHILD_LABEL_PREFIX} 01234567`,
    },
  }
  const childCatalog = GATED_RESEARCH_TOOLS.map(name => ({ name, description: name }))

  const aborted = agent([
    descriptor,
    ...failedSearch('search-aborted', 'WEB_ABORTED', 'DeepSeek web search was aborted'),
  ], 1, { provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL })
  assert.equal(researchChildEvidenceState(aborted).searchFailure, undefined)
  assert.equal((await assemble(aborted, childCatalog)).tools.some(tool => tool.name === 'web_search'), true)

  const missingCredential = agent([
    descriptor,
    ...failedSearch(
      'search-credential',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
      'DeepSeek search has no API key for "DEEPSEEK_API_KEY"',
    ),
  ], 1, { provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL })
  assert.deepEqual(researchChildEvidenceState(missingCredential).searchFailure, {
    code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    endpoint: undefined,
    status: undefined,
    attempts: 1,
    terminal: true,
  })
  assert.equal(researchChildEvidenceState(missingCredential).searchFailureBlocked, true)
  assert.deepEqual(
    (await assemble(missingCredential, childCatalog)).tools.map(tool => tool.name),
    ['structured_output'],
  )
  assert.equal(
    researchPhaseDenial({ name: 'web_search', agent: missingCredential, arguments: {} }),
    RESEARCH_SEARCH_FAILURE_REASON,
  )

  const badEndpoint = agent([
    descriptor,
    ...failedSearch(
      'search-404',
      'WEB_PROVIDER_ERROR',
      'DeepSeek API error (HTTP 404)\n\nThe web search request used endpoint "https://wrong.example/v1/messages". Search endpoint configuration is separate from chat.',
    ),
  ], 1, { provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL })
  assert.deepEqual(researchChildEvidenceState(badEndpoint).searchFailure, {
    code: 'WEB_PROVIDER_ERROR',
    endpoint: 'https://wrong.example/v1/messages',
    status: 404,
    attempts: 1,
    terminal: true,
  })
})

test('transient research failures allow one recovery but repeated endpoint evidence converges', async () => {
  const endpointA = 'https://search-a.example/v1/messages'
  const endpointB = 'https://search-b.example/v1/messages'
  const descriptor = {
    type: 'subagent/descriptor',
    data: {
      version: 2,
      mode: 'one-shot',
      provider: 'spawn',
      label: `${RESEARCH_CHILD_LABEL_PREFIX} 01234567`,
    },
  }
  const researcher = agent([
    descriptor,
    ...failedSearch(
      'search-1',
      'WEB_PROVIDER_ERROR',
      `DeepSeek API error (HTTP 503)\n\nThe web search request used endpoint ${JSON.stringify(endpointA)}. Search endpoint configuration is separate from chat.`,
    ),
  ], 1, { provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL })
  const childCatalog = GATED_RESEARCH_TOOLS.map(name => ({ name, description: name }))

  assert.equal(researchChildEvidenceState(researcher).searchFailureBlocked, false)
  assert.equal((await assemble(researcher, childCatalog)).tools.some(tool => tool.name === 'web_search'), true)

  researcher.session.events.push(...failedSearch(
    'search-2',
    'WEB_PROVIDER_ERROR',
    `DeepSeek API error (HTTP 503)\n\nThe web search request used endpoint ${JSON.stringify(endpointB)}. Search endpoint configuration is separate from chat.`,
  ))
  assert.equal(researchChildEvidenceState(researcher).searchFailure.attempts, 1)
  assert.equal(researchChildEvidenceState(researcher).searchFailureBlocked, false)

  researcher.session.events.push(...failedSearch(
    'search-3',
    'WEB_PROVIDER_ERROR',
    `DeepSeek API error (HTTP 503)\n\nThe web search request used endpoint ${JSON.stringify(endpointB)}. Search endpoint configuration is separate from chat.`,
  ))
  assert.equal(researchChildEvidenceState(researcher).searchFailure.attempts, 2)
  assert.equal(researchChildEvidenceState(researcher).searchFailureBlocked, true)
  assert.deepEqual(
    (await assemble(researcher, childCatalog)).tools.map(tool => tool.name),
    ['structured_output'],
  )

  const recalledSearch = { name: 'web_search', agent: researcher, arguments: {} }
  const deferred = await deferResearchSearchExecution(
    recalledSearch,
    async () => assert.fail('repeated provider failure must stay deferred'),
  )
  assert.equal(deferred.isError, false)
  assert.match(deferred.value.content, /provider failure is deterministic or one recovery attempt repeated/i)

  const recovered = agent([
    descriptor,
    ...failedSearch(
      'search-transient',
      'WEB_PROVIDER_ERROR',
      `DeepSeek API error (HTTP 503)\n\nThe web search request used endpoint ${JSON.stringify(endpointA)}. Search endpoint configuration is separate from chat.`,
    ),
    ...successfulSearch('search-recovered', [{ title: 'Recovered', url: 'https://example.org/recovered' }]),
  ], 1, { provider: FLASH_MAX_PROVIDER, model: FLASH_MAX_MODEL })
  assert.equal(researchChildEvidenceState(recovered).searchFailure, undefined)
  assert.equal(researchChildEvidenceState(recovered).searchFailureBlocked, false)
  assert.equal(researchChildEvidenceState(recovered).awaitingSourceRead, true)
})

test('execution-time research deferral contains a recalled hidden search without a tool error', async () => {
  const url = 'https://example.org/a'
  const researcher = agent([{
    type: 'subagent/descriptor',
    data: {
      version: 2,
      mode: 'one-shot',
      provider: 'spawn',
      label: `${RESEARCH_CHILD_LABEL_PREFIX} 01234567`,
    },
  }, ...successfulSearch('search-1', [{ title: 'Source A', url }])], 1, {
    provider: FLASH_MAX_PROVIDER,
    model: FLASH_MAX_MODEL,
  })

  const recalledSearch = { name: 'web_search', callId: 'hidden-search', agent: researcher, arguments: {} }
  assert.equal(researchPhaseDenial(recalledSearch), RESEARCH_SEARCH_PAUSED_REASON)
  assert.equal(guardExecution(recalledSearch), undefined)
  assert.equal(researchPhaseDenial({ name: RESEARCH_SOURCE_TOOL, agent: researcher, arguments: { url } }), undefined)
  assert.equal(researchPhaseDenial({ name: 'structured_output', agent: researcher, arguments: {} }), undefined)

  let executed = false
  const deferred = await deferResearchSearchExecution(recalledSearch, async () => {
    executed = true
    return { isError: false, value: {}, content: [] }
  })
  assert.equal(executed, false)
  assert.equal(deferred.isError, false)
  assert.match(deferred.value.content, new RegExp(`^${RESEARCH_DEFERRED_SEARCH_PREFIX}`))
  assert.deepEqual(deferred.value.sources, [{ title: 'Source A', url }])

  researcher.session.events.push({
    type: 'tool/call',
    data: { name: 'web_search', callId: 'hidden-search', arguments: '{}' },
  }, successfulResult('hidden-search', {
    sources: [],
    truncated: false,
    answer: deferred.value.content,
  }))
  assert.equal(researchChildEvidenceState(researcher).awaitingSourceRead, true)
  assert.equal(researchChildEvidenceState(researcher).consecutiveNoNewSearches, 0)

  researcher.session.events.push(...successfulSourceRead('read-1', url))
  assert.equal(researchPhaseDenial(recalledSearch), undefined)

  researcher.session.events.push(...successfulSearch('search-2', [{ title: 'Source A', url }]))
  researcher.session.events.push(...successfulSearch('search-3', [{ title: 'Source A', url }]))
  assert.equal(researchPhaseDenial(recalledSearch), RESEARCH_SEARCH_STAGNANT_REASON)
  const stagnant = await deferResearchSearchExecution(recalledSearch, async () => assert.fail('search must stay deferred'))
  assert.equal(stagnant.isError, false)
  assert.deepEqual(stagnant.value.sources, [])
})

test('the internal source reader accepts only discovered public HTTP sources for research children', async () => {
  let fetchCalls = 0
  const runtime = researchRuntime([sufficientEvidence], async (url) => {
    fetchCalls += 1
    return {
      url,
      content: 'Verified source content.',
      contentHash: 'a'.repeat(64),
      contentType: 'text/plain',
      truncated: false,
    }
  })
  const url = 'https://example.org/reference#details'
  const researcher = agent([{
    type: 'subagent/descriptor',
    data: {
      version: 2,
      mode: 'one-shot',
      provider: 'spawn',
      label: `${RESEARCH_CHILD_LABEL_PREFIX} 01234567`,
    },
  }, ...successfulSearch('search-1', [{ title: 'Reference', url }])], 1, {
    provider: FLASH_MAX_PROVIDER,
    model: FLASH_MAX_MODEL,
  })

  const result = await runtime.sourceTool.execute({ url }, {
    agent: researcher,
    signal: new AbortController().signal,
  })
  assert.equal(result.url, 'https://example.org/reference')
  assert.equal(result.available, true)
  assert.equal(result.contentHash, 'a'.repeat(64))
  assert.match(result.text, /UNTRUSTED_EXTERNAL_SOURCE/)
  assert.equal(fetchCalls, 1)

  researcher.session.events.push(...successfulSourceRead('read-1', result.url, result.contentHash))
  await assert.rejects(
    runtime.sourceTool.execute({ url }, {
      agent: researcher,
      signal: new AbortController().signal,
    }),
    /already read/i,
  )
  const undiscovered = await runtime.sourceTool.execute({
    url: 'https://example.org/not-returned',
  }, {
    agent: researcher,
    signal: new AbortController().signal,
  })
  assert.equal(undiscovered.available, false)
  assert.equal(undiscovered.content, '')
  assert.match(undiscovered.unavailableReason, /not returned by web_search/i)
  assert.match(undiscovered.unavailableReason, /No network request was made/i)
  assert.equal(fetchCalls, 1)
  await assert.rejects(
    runtime.sourceTool.execute({ url }, {
      agent: agent(),
      signal: new AbortController().signal,
    }),
    /research child/i,
  )
})

test('bounded source fetching blocks private networks and cross-origin redirects', async () => {
  assert.equal(isPublicIpv4('93.184.216.34'), true)
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '224.0.0.1']) {
    assert.equal(isPublicIpv4(address), false)
  }

  await assert.rejects(
    fetchResearchSource('http://127.0.0.1/private', new AbortController().signal),
    /public IPv4/i,
  )
  await assert.rejects(
    fetchResearchSource('https://user:secret@example.org/', new AbortController().signal),
    /credentials/i,
  )
  await assert.rejects(
    fetchResearchSource('https://example.org/', new AbortController().signal, {
      resolve4: async () => ['10.0.0.1'],
      request: async () => assert.fail('private DNS result must not be requested'),
    }),
    /public IPv4/i,
  )
  const abortedDns = new AbortController()
  const pendingDns = fetchResearchSource('https://example.org/', abortedDns.signal, {
    resolve4: async () => await new Promise(() => {}),
    request: async () => assert.fail('aborted DNS must not be requested'),
  })
  abortedDns.abort(new Error('test DNS cancellation'))
  await assert.rejects(pendingDns, /test DNS cancellation/i)
  await assert.rejects(
    fetchResearchSource('https://example.org/', new AbortController().signal, {
      resolve4: async () => ['93.184.216.34'],
      request: async () => ({
        statusCode: 302,
        headers: { location: 'https://other.example.org/' },
        body: Buffer.alloc(0),
      }),
    }),
    /same-origin/i,
  )

  const fetched = await fetchResearchSource('https://example.org/reference', new AbortController().signal, {
    resolve4: async () => ['93.184.216.34'],
    request: async () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Buffer.from('<html><style>ignored</style><body><h1>Canonical heading</h1><p>Required fact.</p></body></html>'),
    }),
  })
  assert.equal(fetched.url, 'https://example.org/reference')
  assert.equal(fetched.contentType, 'text/html')
  assert.match(fetched.content, /Canonical heading/)
  assert.doesNotMatch(fetched.content, /ignored/)
  assert.match(fetched.contentHash, /^[a-f0-9]{64}$/)
})

test('bounded source fetching extracts targeted evidence from an authorized large document', async () => {
  const body = Buffer.from([
    '<html><body>',
    'Unrelated preface.\n'.repeat(40_000),
    '<section>timestamp-query is optional. Check requiredFeatures before createQuerySet.</section>',
    'Unrelated appendix.\n'.repeat(8_000),
    '</body></html>',
  ].join(''))
  assert.equal(body.length > 512 * 1_024, true)
  let observedLimit = 0

  const fetched = await fetchResearchSource('https://example.org/large-spec', new AbortController().signal, {
    keywords: ['timestamp-query', 'requiredFeatures', 'createQuerySet'],
    resolve4: async () => ['93.184.216.34'],
    request: async (_url, _address, _signal, maxBytes) => {
      observedLimit = maxBytes
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length) },
        body,
      }
    },
  })

  assert.equal(observedLimit >= body.length, true)
  assert.match(fetched.content, /timestamp-query/)
  assert.match(fetched.content, /requiredFeatures/)
  assert.match(fetched.content, /createQuerySet/)
  assert.equal(fetched.content.length < 48_000, true)
  assert.equal(fetched.truncated, true)
})

test('nested callers cannot start another research child', async () => {
  const runtime = researchRuntime()
  await assert.rejects(
    runtime.tool.execute({ question: 'What is required?', decision: 'Choose one invariant.' }, {
      agent: agent([], 1),
      signal: new AbortController().signal,
    }),
    /top-level Pro parent/,
  )
  assert.equal(runtime.starts.length, 0)
})
