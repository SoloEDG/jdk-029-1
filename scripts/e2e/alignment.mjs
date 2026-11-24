/**
 * End-to-end check of the alignment workbench in Chromium.
 *
 * Not part of `npm test` (it needs the bundle and a browser); run it with
 * `npm run test:e2e` after `npm run dev -- --port 5199` or point BASE at any
 * running instance.
 *
 * It drives the real UI: import two audio versions and an LRC, confirm
 * correspondence points on both versions, confirm a cut, publish, move one
 * anchor, record from the target clock, reload the page and check that both
 * the project and the published snapshot survive.
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const BASE = process.env.BASE ?? 'http://127.0.0.1:5199/'
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const assets = {
  reference: `${ROOT}public/samples/align-reference.wav`,
  target: `${ROOT}public/samples/align-rehearsal.wav`,
  lyrics: `${ROOT}scripts/fixtures/alignment-demo.lrc`,
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

const browser = await chromium.launch({
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
})
const context = await browser.newContext({
  viewport: { width: 1500, height: 1040 },
  permissions: ['microphone'],
})
const page = await context.newPage()
const errors = []
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
page.on('pageerror', error => errors.push(error.message))

async function setPosition(seconds) {
  await page.evaluate(value => {
    const input = document.querySelector('.scrubber input')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }, seconds)
  await page.waitForTimeout(130)
}

async function addCorrespondence(source, target) {
  const reference = page.locator('.version-switch button').nth(0)
  if (!(await reference.getAttribute('class'))?.includes('on')) await reference.click()
  await setPosition(source)
  await page.getByRole('button', { name: /在参考版选对应点/ }).click()
  await page.waitForTimeout(240)
  await setPosition(target)
  await page.getByRole('button', { name: /在目标版选同一点/ }).click()
  await page.waitForTimeout(240)
}

async function status() {
  return page.locator('.status-panel').innerText()
}

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: '导入', exact: true }).click()
const inputs = page.locator('.dialog input[type=file]')
await inputs.nth(0).setInputFiles(assets.reference)
await inputs.nth(1).setInputFiles(assets.target)
await inputs.nth(2).setInputFiles(assets.lyrics)
await page.getByRole('button', { name: '导入并比对' }).click()
await page.waitForSelector('.notice', { timeout: 120000 })
assert((await page.locator('.notice').first().innerText()).includes('22'), 'imported 22 lyics')

await addCorrespondence(8.0, 10.7)
await addCorrespondence(24.0, 27.84)
await addCorrespondence(40.0, 45.0)
await addCorrespondence(48.0, 53.57)
await page.waitForTimeout(500)

let text = await status()
assert(text.includes('对应点 4'), 'four correspondences recorded')
assert(text.includes('待确认\n4'), 'four unmatched bridge lines stay pending')
assert(text.includes('两端有对应点、尚未确认的段落'), 'pending span is surfaced')

// The second chorus must sit on its own occurrence, not on the first.
const chorusRows = await page.evaluate(() =>
  [...document.querySelectorAll('.phrase')]
    .map(button => button.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(text => text.includes('如果星光还在')))
assert(chorusRows.length === 2, 'both chorus occurrences are listed')
assert(chorusRows[1]?.includes('00:40.0'), 'second chorus keeps its lyric time')
assert(chorusRows[1]?.includes('→ 00:45.0'), 'second chorus maps to its own target occurrence')

// Confirm the bridge cut from the line inspector.
await page.getByRole('button', { name: /桥段的风/ }).click()
await page.getByRole('button', { name: /确认这段删减/ }).click()
await page.waitForTimeout(400)
text = await status()
assert(text.includes('已删\n4'), 'bridge lyrics marked deleted but kept')
assert(text.includes('待确认\n0'), 'nothing left pending after the cut')

// Drag the 45s anchor to 45.6s; the other anchors must not move.
await page.getByRole('button', { name: /如果星光还在/ }).first().click()
await page.waitForTimeout(200)
const before = await page.locator('.anchor-list .mono').allInnerTexts()
await page.locator('.version-switch button').nth(1).click()
await page.waitForTimeout(250)
const box = await page.locator('.timeline-canvas').boundingBox()
const xFor = time => box.x + 54 + (box.width - 68) * (time / 57.857)
await page.mouse.move(xFor(45), box.y + 40)
await page.mouse.down()
await page.mouse.move(xFor(45.6), box.y + 40, { steps: 8 })
await page.mouse.up()
await page.waitForTimeout(400)
const after = await page.locator('.anchor-list .mono').allInnerTexts()
assert(before[0] === after[0], 'the untouched anchor kept its time')

await page.getByRole('button', { name: /发布校对结果/ }).click()
await page.waitForTimeout(400)
assert((await page.locator('.snapshot-list').innerText()).includes('22 句'), 'snapshot published')

// Record a take on the target clock.
await page.getByRole('button', { name: /如果星光还在/ }).first().click()
await page.waitForTimeout(200)
await page.getByRole('button', { name: /按目标版录这一句/ }).first().click()
await page.waitForTimeout(4500)
const stop = page.getByRole('button', { name: /停止并保存/ })
assert(await stop.count(), 'recording started')
await stop.click()
await page.waitForTimeout(1500)
assert((await page.locator('.take-list').innerText()).includes('如果星光还在'), 'take stored with its lyric')

await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
text = await status()
assert(text.includes('已删\n4'), 'cut survived the reload')
assert(text.includes('对应点 4'), 'correspondences survived the reload')
assert((await page.locator('.snapshot-list').innerText()).includes('22 句'), 'snapshot survived the reload')

if (errors.length) throw new Error(`console errors: ${errors.join(' | ')}`)
console.log('alignment e2e: ok')
await browser.close()
