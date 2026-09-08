import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { createGasEnv } from './gas-env.mjs'
import { createUrlFetchApp, liveHandler } from './gas-mocks.mjs'

const FN = 'NORMALZE_JPN_ADDRESS'
const LEVEL_ERR = (got, required) =>
  `正規化レベルが不足しています（結果 ${got} < 指定 ${required}）`
/** vm コンテキスト由来の配列は Array.prototype が別物なので、比較前に素の値へ戻す */
const plain = (value) => JSON.parse(JSON.stringify(value))

describe('環境とビルド', () => {
  test('ブラウザ/Node のグローバルが無いコンテキストで読み込める', () => {
    const env = createGasEnv()
    assert.equal(typeof env.NJA.normalize, 'function')
    assert.equal(env.NJA.libraryVersion, '3.1.3')
  })

  test('normalize() は同期で結果オブジェクトを返す（Promise ではない）', () => {
    const env = createGasEnv()
    const r = env.NJA.normalize('岩手県盛岡市内丸10-1', { level: 8 })
    assert.equal(typeof r.then, 'undefined')
    assert.equal(r.level, 8)
    assert.equal(r.pref, '岩手県')
    assert.equal(r.addr, '10-1')
  })
})

describe(FN, () => {
  // 1 つの store を共有して、テスト間の重複通信を避ける
  const store = new Map()
  let env
  before(() => {
    env = createGasEnv({ cacheStore: store })
  })

  test('レベル 8 まで正規化できる住所', () => {
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1'), '岩手県盛岡市内丸10-1')
    assert.equal(
      env.call(FN, '大阪府大阪市北区梅田1-1-3'),
      '大阪府大阪市北区梅田一丁目1-3',
    )
  })

  test('既定（8）でレベル不足なら例外（単セルは #ERROR! になる）', () => {
    assert.throws(
      () => env.call(FN, '東京都千代田区千代田１−１'),
      new RegExp(LEVEL_ERR(3, 8)),
    )
  })

  test('第2引数 3 なら町丁目まででも通る', () => {
    assert.equal(
      env.call(FN, '東京都千代田区千代田１−１', 3),
      '東京都千代田区千代田1-1',
    )
    assert.equal(
      env.call(FN, '千代田区千代田1-1', 3),
      '東京都千代田区千代田1-1',
    )
  })

  test('正規化できなかった残り（建物名など）の連結', () => {
    assert.equal(
      env.call(FN, '東京都新宿区西新宿2-8-1 都庁第一本庁舎', 3),
      '東京都新宿区西新宿二丁目8-1 都庁第一本庁舎',
    )
    assert.equal(
      env.call(FN, '北海道札幌市中央区北1条西2丁目', 3),
      '北海道札幌市中央区北一条西二丁目',
    )
  })

  test('判別不能な文字列', () => {
    assert.throws(
      () => env.call(FN, '存在しない住所です'),
      new RegExp(LEVEL_ERR(0, 8)),
    )
    assert.equal(env.call(FN, '存在しない住所です', 0), '存在しない住所です')
  })

  test('空セルは空文字', () => {
    assert.equal(env.call(FN, ''), '')
    assert.equal(env.call(FN, '   '), '')
    assert.equal(env.call(FN, null), '')
    assert.equal(env.call(FN, undefined), '')
  })

  test('第2引数の検証', () => {
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1', '8'), '岩手県盛岡市内丸10-1')
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1', ''), '岩手県盛岡市内丸10-1')
    // 4〜7 は 8 と同じ扱い（番地まで試み、閾値として比較）
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1', 5), '岩手県盛岡市内丸10-1')
    assert.throws(
      () => env.call(FN, '東京都千代田区千代田１−１', 5),
      new RegExp(LEVEL_ERR(3, 5)),
    )
    for (const bad of ['abc', 9, -1, 2.5, [[3]]]) {
      assert.throws(() => env.call(FN, '岩手県盛岡市内丸10-1', bad), /第2引数/)
    }
  })

  test('範囲（1 列）: 形を保ち、失敗した行だけ文字列エラーになる', () => {
    const input = [
      ['大阪府大阪市北区梅田1-1-3'],
      [''],
      ['東京都千代田区千代田１−１'],
      ['存在しない住所です'],
      ['大阪府大阪市北区梅田1-1-3'], // 重複（メモ化される）
    ]
    assert.deepEqual(plain(env.call(FN, input)), [
      ['大阪府大阪市北区梅田一丁目1-3'],
      [''],
      [`#LEVEL ${LEVEL_ERR(3, 8)}`],
      [`#LEVEL ${LEVEL_ERR(0, 8)}`],
      ['大阪府大阪市北区梅田一丁目1-3'],
    ])
  })

  test('範囲（1 行）', () => {
    assert.deepEqual(
      plain(env.call(FN, [['岩手県盛岡市内丸10-1', '', '大阪府大阪市北区梅田1-1-3']])),
      [['岩手県盛岡市内丸10-1', '', '大阪府大阪市北区梅田一丁目1-3']],
    )
  })

  test('範囲: 複数列は例外', () => {
    assert.throws(
      () => env.call(FN, [['a', 'b'], ['c', 'd']]),
      /1 列または 1 行/,
    )
  })

  test('範囲: 制限時間を超えた行は #TIMEOUT', () => {
    const slow = createGasEnv({
      cacheStore: store,
      testOptions: { batchBudgetMs: -1 },
    })
    const out = slow.call(FN, [['岩手県盛岡市内丸10-1'], [''], ['大阪府大阪市北区梅田1-1-3']])
    assert.equal(out.length, 3)
    assert.match(out[0][0], /^#TIMEOUT /)
    assert.equal(out[1][0], '')
    assert.match(out[2][0], /^#TIMEOUT /)
  })
})

describe('I/O 層（UrlFetchApp + CacheService）', () => {
  test('2 回目の実行はキャッシュから読み、通信しない。大きい値は分割保存される', () => {
    const freshStore = new Map()
    const first = createGasEnv({ cacheStore: freshStore })
    assert.equal(first.call(FN, '岩手県盛岡市内丸10-1'), '岩手県盛岡市内丸10-1')
    // ja.json + 盛岡市.json + 地番/住居表示の Range 取得
    assert.ok(first.fetchLog.length >= 3, `network calls: ${first.fetchLog.length}`)
    const rangeCall = first.fetchLog.find((c) => c.headers.Range)
    assert.ok(rangeCall, 'Range ヘッダ付きの取得があること')
    assert.match(rangeCall.headers.Range, /^bytes=\d+-\d+$/)

    // ja.json（約 314KB）は gzip+base64 でも 90KB を超えるので分割される
    const heads = [...freshStore.values()].filter((v) => /^M\d+$/.test(v))
    assert.ok(heads.length >= 1, '分割保存のヘッダがあること')
    for (const [k, v] of freshStore) {
      assert.ok(k.length <= 250)
      assert.ok(Buffer.byteLength(v, 'utf8') <= 100 * 1024)
    }

    const second = createGasEnv({ cacheStore: freshStore })
    assert.equal(second.call(FN, '岩手県盛岡市内丸10-1'), '岩手県盛岡市内丸10-1')
    assert.equal(second.fetchLog.length, 0)
    assert.ok(second.NJA.stats.cacheHits >= 3)
  })

  test('Range を無視して 200 で全体を返すサーバーでも正しく切り出す', () => {
    const log = []
    const urlFetchApp = createUrlFetchApp({
      log,
      handler: (url, headers) => {
        const { Range, ...rest } = headers
        const res = liveHandler(url, rest)
        return { ...res, status: 200 }
      },
    })
    const env = createGasEnv({ cacheStore: new Map(), urlFetchApp })
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1'), '岩手県盛岡市内丸10-1')
    assert.ok(log.some((c) => c.headers.Range))
  })

  test('HTTP エラー: 単セルは例外、範囲は #ERROR 行', () => {
    const urlFetchApp = createUrlFetchApp({
      handler: () => ({ status: 503, headers: {}, body: Buffer.from('') }),
    })
    const env = createGasEnv({ cacheStore: new Map(), urlFetchApp })
    assert.throws(() => env.call(FN, '岩手県盛岡市内丸10-1'), /HTTP 503/)
    const out = env.call(FN, [['岩手県盛岡市内丸10-1'], ['']])
    assert.match(out[0][0], /^#ERROR .*HTTP 503/)
    assert.equal(out[1][0], '')
  })

  test('CacheService が使えなくても動く', () => {
    const env = createGasEnv({ cacheStore: new Map() })
    env.ctx.CacheService = {
      getScriptCache: () => {
        throw new Error('no cache')
      },
    }
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1'), '岩手県盛岡市内丸10-1')
  })
})
