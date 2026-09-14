/**
 * 決済完了ページ（functions/license/thanks.js、Cloudflare Pages Functions）のテスト。
 * Stripe API は fetch を差し替えて偽装する。キーの計算が Node 側（scripts/license-core.mjs）と
 * 一致することを確認する（アドオン側との一致は normalize.test.mjs で見ている）。
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { issueLicenseKey as issueOnNode } from '../scripts/license-core.mjs'
import { issueLicenseKey, onRequestGet } from '../functions/license/thanks.js'

const SECRET = 'test-secret-test-secret-test-secret'
const SUB = '123456789012345678901'
const env = { NJA_LICENSE_SECRET: SECRET, STRIPE_SECRET_KEY: 'rk_test_dummy' }

const sessions = {
  cs_test_paid: { payment_status: 'paid', client_reference_id: SUB },
  cs_test_nosub: { payment_status: 'paid', client_reference_id: null },
  cs_test_badsub: { payment_status: 'paid', client_reference_id: 'not-a-sub' },
  cs_test_unpaid: { payment_status: 'unpaid', client_reference_id: SUB },
}

const get = async (query, e = env) => {
  const res = await onRequestGet({
    request: new Request('https://normalize-jpn-address.pizzabunlab.com/license/thanks' + query),
    env: e,
  })
  const html = await res.text()
  return {
    status: res.status,
    cacheControl: res.headers.get('cache-control'),
    title: html.match(/<title>(.*?)<\/title>/)[1],
    key: (html.match(/<code>(NJA-[^<]+)<\/code>/) || [])[1],
    html,
  }
}

describe('決済完了ページ', () => {
  const realFetch = globalThis.fetch
  const calls = []
  before(() => {
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init })
      const id = decodeURIComponent(String(url).split('/').pop())
      const session = sessions[id]
      return session
        ? new Response(JSON.stringify(session), { status: 200 })
        : new Response('{"error":{}}', { status: 404 })
    }
  })
  after(() => {
    globalThis.fetch = realFetch
  })

  test('キーの計算は Node 側と一致する', async () => {
    assert.equal(await issueLicenseKey(SECRET, SUB), issueOnNode(SECRET, SUB))
    assert.notEqual(await issueLicenseKey(SECRET, '999'), issueOnNode(SECRET, SUB))
  })

  test('支払い済みで sub 付きならキーを表示する（同じ URL で同じキー）', async () => {
    const r = await get('?session_id=cs_test_paid')
    assert.equal(r.title, 'ご購入ありがとうございます')
    assert.equal(r.key, issueOnNode(SECRET, SUB))
    assert.equal(r.cacheControl, 'no-store')
    assert.match(calls.at(-1).url, /\/v1\/checkout\/sessions\/cs_test_paid$/)
    assert.equal(calls.at(-1).init.headers.Authorization, 'Bearer rk_test_dummy')
    const again = await get('?session_id=cs_test_paid')
    assert.equal(again.key, r.key)
  })

  test('sub が無い決済（サイドバー経由でない）にはキーを出さず、決済 ID を示して問い合わせへ', async () => {
    for (const id of ['cs_test_nosub', 'cs_test_badsub']) {
      const r = await get('?session_id=' + id)
      assert.equal(r.title, 'ライセンスキーを発行できません')
      assert.equal(r.key, undefined)
      assert.match(r.html, new RegExp(id))
      assert.match(r.html, /href="\/support\.html"/)
    }
  })

  test('未払い・存在しないセッション・不正な URL', async () => {
    assert.equal((await get('?session_id=cs_test_unpaid')).title, 'お支払いが確認できません')
    assert.equal((await get('?session_id=cs_test_missing')).title, 'お支払いが確認できません')
    const before = calls.length
    assert.equal((await get('')).title, 'ご購入の確認ができません')
    assert.equal((await get('?session_id=<script>')).title, 'ご購入の確認ができません')
    assert.equal(calls.length, before, '形式が不正なら Stripe を呼ばない')
  })

  test('秘密が未設定なら設定エラー（Stripe を呼ばない）', async () => {
    const before = calls.length
    assert.equal((await get('?session_id=cs_test_paid', {})).title, '設定エラー')
    assert.equal(calls.length, before)
  })
})
