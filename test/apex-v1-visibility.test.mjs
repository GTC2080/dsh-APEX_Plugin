import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { harnessAvailable, harnessRoot } from './helpers/harness-v1.mjs'
import { LAYOUT_DIAGNOSTICS_SOURCE, dispatchInteractions } from '../presets/apex-v1/validation.mjs'

test('real browser visibility and interaction regressions', { skip: !harnessAvailable, timeout: 30000 }, async t => {
  const resolver = createRequire(join(harnessRoot, 'packages/experimental/browser-use-playwright-mcp/package.json'))
  const { chromium } = createRequire(resolver.resolve('@playwright/mcp'))('playwright')
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  t.after(() => browser.close())
  async function fixture(sub, html) {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
    sub.after(() => page.close())
    await page.setContent(`<!doctype html>${html}<script>globalThis.clicks=0;
      for(const b of document.querySelectorAll('button'))b.addEventListener('click',()=>clicks++);</script>`)
    await page.evaluate(() => new Promise(requestAnimationFrame))
    const client = await page.context().newCDPSession(page)
    return { page,
      scan: () => page.evaluate(LAYOUT_DIAGNOSTICS_SOURCE),
      act: action => dispatchInteractions(client, { interactions: [action] }, sub.signal),
      click: selector => dispatchInteractions(client, { click_selector: selector }, sub.signal),
      clicks: () => page.evaluate(() => globalThis.clicks),
    }
  }

  await t.test('closed disclosures exclude hidden controls and reject every input path', async sub => {
    const f = await fixture(sub, `<details id="panel"><summary id="toggle">Open</summary>
      <button id="target">Click</button><textarea id="text"></textarea>
      <input id="range" type="range" value="0"><select id="select"><option>a</option><option>b</option></select></details>`)
    assert.deepEqual((await f.scan()).layoutErrors, [])
    for (const action of [{ click_selector: '#target' }, { selector: '#text', text: 'changed' },
      { input: { selector: '#range', value: 5 } }, { select: { selector: '#select', value: 'b' } }]) {
      await assert.rejects(f.act(action), /target is hidden/)
    }
    assert.equal(await f.clicks(), 0)
    assert.deepEqual(await f.page.locator('#text,#range,#select').evaluateAll(xs => xs.map(x => x.value)), ['', '0', 'a'])
    await f.click('#toggle'); await f.click('#target')
    await f.act({ selector: '#text', text: 'changed' })
    await f.act({ input: { selector: '#range', value: 5 } })
    await f.act({ select: { selector: '#select', value: 'b' } })
    assert.equal(await f.clicks(), 1)
    assert.deepEqual(await f.page.locator('#text,#range,#select').evaluateAll(xs => xs.map(x => x.value)), ['changed', '5', 'b'])
    await f.click('#toggle')
    assert.deepEqual((await f.scan()).layoutErrors, [])
    await assert.rejects(f.click('#target'), /target is hidden/)
    assert.equal(await f.clicks(), 1)
  })

  await t.test('nested summaries follow their actual disclosure visibility', async sub => {
    const f = await fixture(sub, `<details><summary id="outer">Outer</summary>
      <details open><summary id="inner">Inner</summary><button id="target">Click</button></details></details>`)
    await assert.rejects(f.click('#inner'), /target is hidden/)
    await assert.rejects(f.click('#target'), /target is hidden/)
    await f.click('#outer'); await f.click('#inner')
    await assert.rejects(f.click('#target'), /target is hidden/)
    await f.click('#inner'); await f.click('#target')
    assert.equal(await f.clicks(), 1)
  })

  await t.test('scan does not scroll and explicit actions restore skipped auto content', async sub => {
    const f = await fixture(sub, `<div style="height:100000px"></div><button id="ordinary">Ordinary</button>
      <div style="height:100000px"></div><section style="content-visibility:auto;contain-intrinsic-size:100px">
      <button id="target">Skipped</button><textarea id="text"></textarea>
      <input id="range" type="range" value="0"><select id="select"><option>a</option><option>b</option></select></section>`)
    assert.equal(await f.page.locator('#target').evaluate(e => e.checkVisibility({ contentVisibilityAuto: true })), false,
      'The browser must actually skip this subtree before testing recovery')
    await f.scan()
    assert.equal(await f.page.evaluate(() => scrollY), 0)
    await f.click('#ordinary'); await f.click('#target')
    assert.equal(await f.clicks(), 2)
    for (const action of [{ selector: '#text', text: 'changed' }, { input: { selector: '#range', value: 5 } },
      { select: { selector: '#select', value: 'b' } }]) {
      await f.page.evaluate(() => { document.activeElement.blur(); getSelection().removeAllRanges(); scrollTo(0, 0);
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))) })
      assert.equal(await f.page.locator('#target').evaluate(e => e.checkVisibility({ contentVisibilityAuto: true })), false)
      await f.act(action)
    }
    assert.deepEqual(await f.page.locator('#text,#range,#select').evaluateAll(xs => xs.map(x => x.value)), ['changed', '5', 'b'])
  })

  await t.test('fixed controls escape normal clipping but not a closed disclosure', async sub => {
    const f = await fixture(sub, `<div style="overflow:hidden;width:1px;height:1px">
      <button id="ordinary" style="position:fixed;left:200px;top:100px">Ordinary</button></div>
      <details><summary id="toggle">Open</summary><button id="target" style="position:fixed;left:200px;top:200px">Closed</button></details>`)
    assert.deepEqual((await f.scan()).layoutErrors, [])
    await f.click('#ordinary')
    await assert.rejects(f.click('#target'), /target is hidden/)
    assert.equal(await f.clicks(), 1)
    await f.click('#toggle'); await f.click('#target')
    assert.equal(await f.clicks(), 2)
  })

  await t.test('visible controls behind a real overlay still fail and receive no click', async sub => {
    const f = await fixture(sub, `<details open><summary>Open</summary><button id="target">Covered</button></details>
      <div id="overlay" style="position:fixed;inset:0;z-index:10"></div>`)
    assert.match((await f.scan()).layoutErrors.join('\n'), /#target:.*occluded/)
    await assert.rejects(f.click('#target'), /target is occluded/)
    assert.equal(await f.clicks(), 0)
    await f.page.locator('#overlay').evaluate(e => e.remove())
    await f.click('#target')
    assert.equal(await f.clicks(), 1)
  })

  await t.test('native visibility overrides remain usable while hidden and transparent controls fail', async sub => {
    const f = await fixture(sub, `<button id="hidden" style="display:none">Hidden</button>
      <div style="opacity:0"><button id="transparent">Transparent</button></div>
      <div style="visibility:hidden"><button id="visible" style="visibility:visible">Visible</button></div>`)
    assert.deepEqual((await f.scan()).layoutErrors, [])
    await assert.rejects(f.click('#hidden'), /target is hidden/)
    await assert.rejects(f.click('#transparent'), /target is hidden/)
    await f.click('#visible')
    assert.equal(await f.clicks(), 1)
  })
})
