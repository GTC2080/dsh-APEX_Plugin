import assert from 'node:assert/strict'
import test from 'node:test'

import {
  apply,
  DENIAL_REASON,
  guardExecution,
  isBroadProcessTermination,
} from '../presets/apex-v04/execution-guard.mjs'

const blocked = [
  'pkill -f Chromium',
  '  pkill -f Chromium',
  'sudo -n /usr/bin/pkill node',
  'killall Google Chrome',
  '/usr/bin/killall -9 node',
  '(killall node)',
  'taskkill /IM chrome.exe /F',
  'C:\\Windows\\System32\\taskkill.exe /F /IM chrome.exe',
  'Stop-Process -Name chrome -Force',
  'Get-Process chrome | Stop-Process -Force',
  'kill $(pgrep -f chromium)',
  'pgrep node | xargs kill',
]

const allowed = [
  'kill -TERM 12345',
  'taskkill /PID 12345 /F',
  'Stop-Process -Id 12345',
  "rg 'pkill -f' README.md",
  "printf '%s\\n' killall",
]

test('execution guard detects known broad name-based termination forms', () => {
  for (const command of blocked) {
    assert.equal(isBroadProcessTermination(command), true, command)
    assert.equal(
      guardExecution({ name: 'bash', arguments: { command } }),
      DENIAL_REASON,
      command,
    )
  }
})

test('execution guard preserves exact-PID cleanup and ordinary inspection', () => {
  for (const command of allowed) {
    assert.equal(isBroadProcessTermination(command), false, command)
    assert.equal(guardExecution({ name: 'bash', arguments: { command } }), undefined, command)
  }
  assert.equal(
    guardExecution({ name: 'str_replace_editor', arguments: { command: blocked[0] } }),
    undefined,
  )
  assert.equal(guardExecution({ name: 'bash', arguments: {} }), undefined)
})

test('execution guard registers one monotonic tools guard', () => {
  let registered
  const dispose = () => {}
  apply({
    tools: {
      guard(value) {
        registered = value
        return dispose
      },
    },
  })
  assert.equal(registered, guardExecution)
  assert.equal(registered({ name: 'pwsh', arguments: { command: blocked[5] } }), DENIAL_REASON)
})
