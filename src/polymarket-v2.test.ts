// Tests for reading Polymarket V2 requests, run offline:
//
//   nub src/polymarket-v2.test.ts   (part of nub run test)
//
// The fixture is voter-dapp-v2's tests/helpers/voting/projects/
// polymarket-v2-fixture.json, copied unchanged: a live Central Park request
// (time 1790096754, round 10359) that reached a DVM vote. V2 resolved text is a
// JSON object followed by the reporter stamp; the old title regex cannot read
// it, so a V2 vote lost its title and with it the Discord thread and AI summary.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parsePolymarketV2, titleFromText, titleFromAncillary } from './common'

const fixture = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'polymarket-v2-central-park.json'), 'utf8')) as
    { identifier: string; time: number; ancillaryData: `0x${string}`; resolved: `0x${string}`; text: string }
const TITLE = 'Will Central Park’s daily maximum temperature be at least 75°F on September 21, 2026?'
const STAMP = ',ooRequester:53703dd6129d723066b6362510e5ae2fecd48218,childRequester:2c0367a9db231ddebd88a94b4f6461a6e47c58b1,childChainId:137'

test('a live V2 request yields its JSON title, rules and market id', () => {
    assert.equal(Buffer.from(fixture.resolved.slice(2), 'hex').toString('utf8'), fixture.text, 'the fixture text is the resolved bytes')
    assert.equal(titleFromText(fixture.text), TITLE)
    const v2 = parsePolymarketV2(fixture.text)!
    assert.equal(v2.title, TITLE)
    assert.ok(v2.description?.startsWith('This mar'))
    assert.equal(typeof v2.marketId, 'string')
    assert.equal(typeof v2.resData, 'string', 'live data has res_data as a string')
})

test('the L1 ancillary data of a V2 request is a hash and has no title', () => {
    assert.equal(titleFromAncillary(fixture.ancillaryData), undefined)
})

test('JSON is V2 only with the exact reporter stamp', () => {
    const json = JSON.stringify({ title: 'T', description: 'D' })
    assert.equal(parsePolymarketV2(json), undefined, 'no stamp')
    assert.equal(parsePolymarketV2(`${json},childRequester:2c0367a9db231ddebd88a94b4f6461a6e47c58b1,childChainId:137`), undefined, 'a MOOV2 childRequester alone is not V2')
    assert.equal(parsePolymarketV2(`${json},ooRequester:0000000000000000000000000000000000000001${STAMP.slice(STAMP.indexOf(',childRequester'))}`), undefined, 'another ooRequester')
    assert.equal(parsePolymarketV2(`{not json${STAMP}`), undefined, 'broken JSON')
    assert.equal(parsePolymarketV2(`${json}${STAMP}`)?.title, 'T')
})

test('the spec shape (res_data array, integration_id) is read too', () => {
    const resData = [{ value: '0', outcome: 'No' }, { value: '1', outcome: 'Yes' }]
    const v2 = parsePolymarketV2(`${JSON.stringify({ type: 1, title: 'T', integration_id: '42', res_data: resData })}${STAMP}`)!
    assert.equal(v2.marketId, '42')
    assert.deepEqual(v2.resData, resData)
})

test('a V2 title drops U+202F as the dApp does, and control codes as everywhere', () => {
    assert.equal(titleFromText(`${JSON.stringify({ title: 'Will X win?\u001b[2J' })}${STAMP}`), 'Will Xwin?[2J')
})

test('legacy text keeps its title', () => {
    assert.equal(titleFromText('q: title: Will it rain?, description: Rules here.'), 'Will it rain?')
})
