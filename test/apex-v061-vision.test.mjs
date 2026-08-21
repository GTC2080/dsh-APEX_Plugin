import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APEX_VISION_DESCRIPTION,
  apply,
  MAX_VISION_IMAGES,
  parseVisionArguments,
  parseVisualReport,
  renderVisionPrompt,
  VISUAL_META_KIND,
  VISION_CHILD_PERSONA,
} from '../presets/apex-v061/apex-vision.mjs'
import {
  FLASH_MAX_PROVIDER,
  FLASH_VISION_MODEL,
} from '../presets/apex-v061/tool-gate.mjs'

function parent(depth = 0) {
  return { session: { header: { cwd: '/workspace', delegationDepth: depth }, events: [] } }
}

function captureTool(result = {
  output: [{
    type: 'text',
    text: [
      'APEX_VISUAL_VERDICT: pass',
      'Blocking defects:',
      '- None.',
      'Quality observations:',
      '- screens/final.png: aligned pool edges.',
      'Requested answer:',
      '- No visible clipping.',
      'Uncertainty:',
      '- None.',
    ].join('\n'),
  }],
  stopReason: 'completed',
}) {
  let tool
  let start
  let disposed = false
  apply({
    tools: {
      register(value) {
        tool = value
        return () => {}
      },
    },
    subagents: {
      async start(provider, request) {
        start = { provider, request }
        return {
          id: 'vision-child',
          result: Promise.resolve(result),
          async dispose() {
            disposed = true
          },
        }
      },
    },
  })
  return { tool, start: () => start, disposed: () => disposed }
}

test('visual inspection accepts only bounded workspace-relative image paths', () => {
  assert.deepEqual(parseVisionArguments({
    image_paths: ['./screens/home.PNG', 'screens/detail.webp'],
    question: '  Are the pool edges aligned?  ',
  }), {
    ok: true,
    value: {
      imagePaths: ['screens/home.PNG', 'screens/detail.webp'],
      question: 'Are the pool edges aligned?',
    },
  })
  for (const imagePath of [
    '/tmp/view.png',
    '../outside.png',
    'screens/**',
    'screens/view.svg',
    'C:\\outside.png',
  ]) {
    assert.equal(parseVisionArguments({ image_paths: [imagePath], question: 'Inspect it' }).ok, false)
  }
  assert.equal(parseVisionArguments({
    image_paths: Array.from({ length: MAX_VISION_IMAGES + 1 }, (_, index) => `shot-${index}.png`),
    question: 'Compare them',
  }).ok, false)
})

test('visual inspection compiles one fixed read-only brief', () => {
  const text = renderVisionPrompt({ imagePaths: ['shots/final.png'], question: 'Find layout defects' })
  assert.match(text, /Call read_image once for every listed path/)
  assert.match(text, /observable evidence from inference/)
  assert.match(text, /blocking render artifacts/)
  assert.match(text, /APEX_VISUAL_VERDICT: pass/)
  assert.match(text, /read-only visual reviewer/)
  assert.doesNotMatch(text, /bash|powershell/i)
})

test('visual inspection runs one foreground official vision child and returns a structured verdict', async () => {
  const runtime = captureTool()
  const signal = new AbortController().signal
  const value = await runtime.tool.execute({
    image_paths: ['screens/final.png'],
    question: 'Check visible clipping',
  }, { agent: parent(), signal })

  assert.equal(runtime.tool.name, 'apex_inspect_image')
  assert.equal(runtime.tool.description, APEX_VISION_DESCRIPTION)
  assert.equal(value.verdict, 'pass')
  assert.match(value.report, /^APEX_VISUAL_VERDICT: pass/)
  assert.equal(runtime.disposed(), true)
  assert.equal(runtime.start().provider, 'spawn')
  assert.deepEqual(runtime.start().request.agentOptions, {
    provider: FLASH_MAX_PROVIDER,
    model: FLASH_VISION_MODEL,
  })
  assert.equal(runtime.start().request.persona, VISION_CHILD_PERSONA)
  assert.deepEqual(runtime.start().request.toolFilter, { allow: ['read_image'] })
  assert.equal(runtime.start().request.maxDepth, 1)
  assert.equal(runtime.start().request.parent.session.header.cwd, '/workspace')
  assert.equal(runtime.start().request.signal, signal)
  assert.match(runtime.start().request.label, /^APEX visual inspection/)
  assert.deepEqual(runtime.tool.output.presentationMeta({
    image_paths: ['./screens/final.png'],
    question: 'Check visible clipping',
  }, value), {
    kind: VISUAL_META_KIND,
    imagePaths: ['screens/final.png'],
    verdict: 'pass',
  })
})

test('visual inspection never guesses acceptance from an unstructured report', () => {
  const parsed = parseVisualReport('Visible: the frame may be loading.')
  assert.equal(parsed.verdict, 'inconclusive')
  assert.match(parsed.report, /^APEX_VISUAL_VERDICT: inconclusive/)
  assert.match(parsed.report, /do not claim visual acceptance/)
})

test('visual inspection disposes failed children and refuses nested callers', async () => {
  const failed = captureTool({ output: [], stopReason: 'error', diagnostic: 'route failed' })
  await assert.rejects(
    failed.tool.execute(
      { image_paths: ['screens/final.png'], question: 'Inspect it' },
      { agent: parent(), signal: new AbortController().signal },
    ),
    /vision subagent ended with error; diagnostic: route failed/,
  )
  assert.equal(failed.disposed(), true)

  const nested = captureTool()
  await assert.rejects(
    nested.tool.execute(
      { image_paths: ['screens/final.png'], question: 'Inspect it' },
      { agent: parent(1), signal: new AbortController().signal },
    ),
    /requires a top-level parent agent/,
  )
  assert.equal(nested.start(), undefined)
})
