import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGasEnv,
  DEFAULT_API_ENDPOINT,
  TEST_API_ENDPOINT,
  UPSTREAM_API_ENDPOINT,
  LICENSE_SECRET,
  VALID_LICENSE_KEY,
} from './gas-env.mjs'
import { createUrlFetchApp, liveHandler } from './gas-mocks.mjs'
import { issueLicenseKey, verifyLicenseKey } from '../scripts/license-core.mjs'

const FN = 'NORMALIZE_JPN_ADDRESS'
const OLD_FN = 'NORMALZE_JPN_ADDRESS'
const MAP_FN = 'NORMALIZE_JPN_ADDRESS_MAP'
const LATLNG_FN = 'NORMALIZE_JPN_ADDRESS_LATLNG'
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

  test('取得先: 既定は自前配信、Script Properties の NJA_API_ENDPOINT で上書きできる', () => {
    const plainEnv = createGasEnv({ scriptProperties: null })
    assert.equal(plainEnv.NJA.defaultApiEndpoint, DEFAULT_API_ENDPOINT)
    assert.equal(plainEnv.NJA.upstreamApiEndpoint, UPSTREAM_API_ENDPOINT)
    assert.equal(plainEnv.NJA.apiEndpoint, DEFAULT_API_ENDPOINT)
    assert.equal(plainEnv.NJA.config.japaneseAddressesApi, DEFAULT_API_ENDPOINT)

    const overridden = createGasEnv({
      scriptProperties: { NJA_API_ENDPOINT: UPSTREAM_API_ENDPOINT + '/' },
    })
    assert.equal(overridden.NJA.apiEndpoint, UPSTREAM_API_ENDPOINT)
    assert.equal(overridden.NJA.config.japaneseAddressesApi, UPSTREAM_API_ENDPOINT)

    // 不正な値（https 以外・空）は無視して既定に戻る
    for (const bad of ['', 'http://example.com/api/ja', 'not a url']) {
      const env = createGasEnv({ scriptProperties: { NJA_API_ENDPOINT: bad } })
      assert.equal(env.NJA.apiEndpoint, DEFAULT_API_ENDPOINT, JSON.stringify(bad))
    }
  })

  test('通信は Script Properties で指定した取得先に向く', () => {
    const env = createGasEnv({ cacheStore: new Map() })
    env.call(FN, '岩手県盛岡市内丸10-1')
    assert.ok(env.fetchLog.length > 0)
    for (const c of env.fetchLog) {
      assert.ok(c.url.startsWith(TEST_API_ENDPOINT), c.url)
    }
  })
})

describe(FN, () => {
  // 1 つの store を共有して、テスト間の重複通信を避ける
  const store = new Map()
  let env
  before(() => {
    env = createGasEnv({ cacheStore: store, licensed: true })
  })

  test('旧名 NORMALZE_JPN_ADDRESS でも同じ結果', () => {
    assert.equal(env.call(OLD_FN, '岩手県盛岡市内丸10-1', 8), '岩手県盛岡市内丸10-1')
    assert.equal(env.call(OLD_FN, ''), '')
  })

  test('レベル 8 を指定すると番地・号まで正規化する', () => {
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1', 8), '岩手県盛岡市内丸10-1')
    assert.equal(
      env.call(FN, '大阪府大阪市北区梅田1-1-3', 8),
      '大阪府大阪市北区梅田一丁目1-3',
    )
  })

  test('既定（3）は町丁目まで。番地・号のデータが無い住所でも通る', () => {
    assert.equal(
      env.call(FN, '東京都千代田区千代田１−１'),
      '東京都千代田区千代田1-1',
    )
    assert.equal(env.call(FN, '千代田区千代田1-1'), '東京都千代田区千代田1-1')
    // 既定でも番地・号が残りとして連結されるので、出力の見た目は 8 と同じになることが多い
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1'), '岩手県盛岡市内丸10-1')
  })

  test('8 を指定してレベル不足なら例外（単セルは #ERROR! になる）', () => {
    assert.throws(
      () => env.call(FN, '東京都千代田区千代田１−１', 8),
      new RegExp(LEVEL_ERR(3, 8)),
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
      new RegExp(LEVEL_ERR(0, 3)),
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
    assert.deepEqual(plain(env.call(FN, input, 8)), [
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

describe('ライセンスと有料機能', () => {
  const store = new Map()
  const MORIOKA = '岩手県盛岡市内丸10-1'
  const MAP_URL = /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=39\.\d+%2C141\.\d+$/

  test('キーの発行と検証: Node 側とアドオン側で一致する', () => {
    const env = createGasEnv({ cacheStore: store })
    assert.ok(verifyLicenseKey(LICENSE_SECRET, VALID_LICENSE_KEY))
    assert.ok(env.NJA.verifyLicenseKey(VALID_LICENSE_KEY))
    assert.match(VALID_LICENSE_KEY, /^NJA-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/)
    // 書式のゆれ（小文字、区切り無し、空白）は許容
    assert.ok(env.NJA.verifyLicenseKey(VALID_LICENSE_KEY.toLowerCase()))
    assert.ok(env.NJA.verifyLicenseKey(' ' + VALID_LICENSE_KEY.replace(/-/g, '') + ' '))
    // 1 文字違い、別の秘密鍵、空は不可
    const tampered = VALID_LICENSE_KEY.slice(0, -1) + (VALID_LICENSE_KEY.endsWith('A') ? 'B' : 'A')
    assert.equal(env.NJA.verifyLicenseKey(tampered), false)
    assert.equal(env.NJA.verifyLicenseKey(issueLicenseKey('another-secret-another-secret-xx', 'TESTKEY2')), false)
    assert.equal(env.NJA.verifyLicenseKey(''), false)
    assert.equal(env.NJA.verifyLicenseKey(null), false)
    // 10 個作って全部通る（ランダム ID）
    for (let i = 0; i < 10; i++) {
      assert.ok(env.NJA.verifyLicenseKey(issueLicenseKey(LICENSE_SECRET)))
    }
    assert.equal(env.NJA.maskLicenseKey(VALID_LICENSE_KEY), 'NJA-TESTK-•••••-•••••-' + VALID_LICENSE_KEY.slice(-5))
  })

  test('未ライセンス: レベル 3 までは使え、レベル 4 以上と位置情報関数は購入案内つきのエラー', () => {
    const env = createGasEnv({ cacheStore: store })
    assert.equal(env.call(FN, MORIOKA), MORIOKA)
    assert.equal(env.call(FN, MORIOKA, 3), MORIOKA)
    for (const level of [4, 8, '8']) {
      assert.throws(() => env.call(FN, MORIOKA, level), /ライセンスキーが必要です.*https:\/\//)
    }
    // 範囲入力でも呼び出し全体がエラー（行ごとの文字列ではない）
    assert.throws(() => env.call(FN, [[MORIOKA]], 8), /ライセンスキーが必要です/)
    assert.throws(() => env.call(MAP_FN, MORIOKA), /ライセンスキーが必要です/)
    assert.throws(() => env.call(LATLNG_FN, MORIOKA), /ライセンスキーが必要です/)
    // 未ライセンスの判定では通信しない
    assert.equal(env.fetchLog.filter((c) => !c.url.includes('.json')).length, 0)
    const status = env.call('njaGetLicenseStatus')
    assert.equal(status.licensed, false)
    assert.equal(status.source, null)
    assert.equal(status.purchaseUrl, env.NJA.purchaseUrl)
  })

  test('ライセンスあり: UserProperties でも DocumentProperties でも有効', () => {
    const byUser = createGasEnv({ cacheStore: store, licensed: true })
    assert.equal(byUser.call(FN, MORIOKA, 8), MORIOKA)
    assert.equal(byUser.call('njaGetLicenseStatus').source, 'user')

    const byDocument = createGasEnv({
      cacheStore: store,
      documentProperties: { NJA_LICENSE_KEY: VALID_LICENSE_KEY },
    })
    assert.equal(byDocument.call(FN, MORIOKA, 8), MORIOKA)
    assert.equal(byDocument.call('njaGetLicenseStatus').source, 'document')

    // 不正なキーが保存されていても未ライセンス扱い
    const bogus = createGasEnv({
      cacheStore: store,
      userProperties: { NJA_LICENSE_KEY: 'NJA-AAAAA-AAAAA-AAAAA-AAAAA' },
    })
    assert.throws(() => bogus.call(FN, MORIOKA, 8), /ライセンスキーが必要です/)
  })

  test('サイドバーからの登録・削除', () => {
    const env = createGasEnv({ cacheStore: store })
    assert.throws(() => env.call('njaSetLicenseKey', 'NJA-XXXXX'), /正しくありません/)
    const status = env.call('njaSetLicenseKey', ' ' + VALID_LICENSE_KEY.toLowerCase() + ' ')
    assert.equal(status.licensed, true)
    assert.equal(status.source, 'user')
    // 正規化した形で両方に保存される
    const normalized = VALID_LICENSE_KEY.replace(/-/g, '')
    assert.equal(env.properties.user.get('NJA_LICENSE_KEY'), normalized)
    assert.equal(env.properties.document.get('NJA_LICENSE_KEY'), normalized)
    // 同じ実行内で有料機能が使えるようになる
    assert.equal(env.call(FN, MORIOKA, 8), MORIOKA)

    const cleared = env.call('njaClearLicenseKey')
    assert.equal(cleared.licensed, false)
    assert.equal(env.properties.user.has('NJA_LICENSE_KEY'), false)
    assert.throws(() => env.call(FN, MORIOKA, 8), /ライセンスキーが必要です/)
  })

  test('地図 URL と緯度経度', () => {
    const env = createGasEnv({ cacheStore: store, licensed: true })
    const url = env.call(MAP_FN, MORIOKA)
    assert.match(url, MAP_URL)
    const latlng = plain(env.call(LATLNG_FN, MORIOKA))
    assert.equal(latlng.length, 1)
    assert.equal(latlng[0].length, 2)
    assert.ok(latlng[0][0] > 39 && latlng[0][0] < 40, 'lat')
    assert.ok(latlng[0][1] > 141 && latlng[0][1] < 142, 'lng')
    assert.equal(url, `https://www.google.com/maps/search/?api=1&query=${latlng[0][0]}%2C${latlng[0][1]}`)

    // 既定はレベル 8 なので、番地・号が無い住所はエラー。3 を指定すると町丁目の代表点
    assert.throws(() => env.call(MAP_FN, '東京都千代田区千代田１−１'), /正規化レベルが不足/)
    assert.match(env.call(MAP_FN, '東京都千代田区千代田１−１', 3), /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=35\./)

    assert.equal(env.call(MAP_FN, ''), '')
    assert.equal(env.call(LATLNG_FN, ''), '')
  })

  test('地図 URL と緯度経度の範囲入力', () => {
    const env = createGasEnv({ cacheStore: store, licensed: true })
    const column = [[MORIOKA], [''], ['存在しない住所です']]
    const urls = plain(env.call(MAP_FN, column))
    assert.equal(urls.length, 3)
    assert.match(urls[0][0], MAP_URL)
    assert.deepEqual(urls[1], [''])
    assert.match(urls[2][0], /^#LEVEL /)

    // 列入力 → 行ごとに 2 列。エラー行は 1 列目にメッセージ、2 列目は空
    const latlng = plain(env.call(LATLNG_FN, column))
    assert.equal(latlng.length, 3)
    assert.equal(latlng[0].length, 2)
    assert.equal(typeof latlng[0][0], 'number')
    assert.deepEqual(latlng[1], ['', ''])
    assert.match(latlng[2][0], /^#LEVEL /)
    assert.equal(latlng[2][1], '')

    // 行入力 → 2 行（緯度の行、経度の行）
    const rows = plain(env.call(LATLNG_FN, [[MORIOKA, '']]))
    assert.equal(rows.length, 2)
    assert.equal(rows[0].length, 2)
    assert.equal(typeof rows[0][0], 'number')
    assert.equal(typeof rows[1][0], 'number')
    assert.deepEqual([rows[0][1], rows[1][1]], ['', ''])
  })
})

describe('メニューの一括処理', () => {
  const store = new Map()
  const MORIOKA = '岩手県盛岡市内丸10-1'
  const CHIYODA = '東京都千代田区千代田１−１'
  // A 列に見出し + 住所。選択は A2:A6
  const values = [['住所'], [MORIOKA], [''], [CHIYODA], ['存在しない住所です'], [MORIOKA]]
  const selection = { row: 2, column: 1, rows: 5, columns: 1 }
  const cell = (env, r, c) => (env.sheet.cells.has(`${r},${c}`) ? env.sheet.cells.get(`${r},${c}`) : '')

  test('メニュー項目が登録される', () => {
    const env = createGasEnv({ cacheStore: store })
    env.call('onOpen')
    assert.deepEqual(
      plain(env.sheet.menuItems.map((m) => m.fn)),
      ['njaMenuNormalize', 'njaMenuMapLinks', 'njaShowSidebar'],
    )
  })

  test('正規化（未ライセンス）: 右隣 2 列に町丁目までの住所とレベル', () => {
    const env = createGasEnv({ cacheStore: store, spreadsheet: { values, selection } })
    env.call('njaMenuNormalize')
    assert.equal(cell(env, 2, 2), MORIOKA)
    assert.equal(cell(env, 2, 3), 3) // 未ライセンスは町丁目まで
    assert.deepEqual([cell(env, 3, 2), cell(env, 3, 3)], ['', ''])
    assert.equal(cell(env, 4, 2), '東京都千代田区千代田1-1')
    assert.equal(cell(env, 4, 3), 3)
    assert.equal(cell(env, 5, 2), '存在しない住所です')
    assert.equal(cell(env, 5, 3), 0)
    assert.equal(cell(env, 6, 2), MORIOKA)
    assert.equal(cell(env, 1, 2), '', '見出し行（選択外）には書かない')
    assert.equal(env.sheet.alerts.length, 1)
    assert.match(env.sheet.alerts[0], /5 行を処理しました（エラー 0 行）/)
    assert.match(env.sheet.alerts[0], /ライセンス版では/)
  })

  test('正規化（ライセンスあり）: 番地・号まで', () => {
    const env = createGasEnv({ cacheStore: store, licensed: true, spreadsheet: { values, selection } })
    env.call('njaMenuNormalize')
    assert.equal(cell(env, 2, 3), 8)
    assert.equal(cell(env, 4, 3), 3) // 千代田は番地データが無いので 3 のまま（エラーではない）
    assert.doesNotMatch(env.sheet.alerts[0], /ライセンス版では/)
  })

  test('地図リンク: 未ライセンスは案内だけで書き込まない', () => {
    const env = createGasEnv({ cacheStore: store, spreadsheet: { values, selection } })
    env.call('njaMenuMapLinks')
    assert.equal(env.sheet.alerts.length, 1)
    assert.match(env.sheet.alerts[0], /ライセンス版の機能/)
    assert.equal(cell(env, 2, 2), '')
  })

  test('地図リンク（ライセンスあり）: リンク付きテキスト。町丁目までなら「概略」、判別不能はエラー文字列', () => {
    const env = createGasEnv({ cacheStore: store, licensed: true, spreadsheet: { values, selection } })
    env.call('njaMenuMapLinks')
    const link = env.sheet.rich.get('2,2')
    assert.equal(link.text, '地図')
    assert.match(link.url, /^https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=39\./)
    assert.deepEqual(env.sheet.rich.get('3,2'), { text: '', url: null })
    assert.equal(env.sheet.rich.get('4,2').text, '地図（概略）')
    assert.match(env.sheet.rich.get('4,2').url, /query=35\./)
    assert.match(env.sheet.rich.get('5,2').text, /^#ERROR .*位置情報がありません/)
    assert.equal(env.sheet.rich.get('5,2').url, null)
    assert.equal(cell(env, 2, 3), '', '地図は 1 列だけ')
    assert.match(env.sheet.alerts[0], /5 行を処理しました（エラー 1 行）/)
  })

  test('選択が 1 列でなければ案内だけ', () => {
    const env = createGasEnv({
      cacheStore: store,
      spreadsheet: { values, selection: { row: 2, column: 1, rows: 2, columns: 2 } },
    })
    env.call('njaMenuNormalize')
    assert.match(env.sheet.alerts[0], /1 列/)
    assert.equal(cell(env, 2, 2), '')
    const none = createGasEnv({ cacheStore: store, spreadsheet: { values, selection: null } })
    none.call('njaMenuNormalize')
    assert.match(none.sheet.alerts[0], /1 列/)
  })

  test('右隣に値があれば確認し、キャンセルなら書かない', () => {
    const withB = values.map((r, i) => (i === 3 ? [r[0], 'メモ'] : r))
    const cancel = createGasEnv({
      cacheStore: store,
      spreadsheet: { values: withB, selection, alertResponse: 'CANCEL' },
    })
    cancel.call('njaMenuNormalize')
    assert.match(cancel.sheet.alerts[0], /上書き/)
    assert.equal(cancel.sheet.alerts.length, 1)
    assert.equal(cell(cancel, 2, 2), '')
    assert.equal(cell(cancel, 4, 2), 'メモ')

    const ok = createGasEnv({
      cacheStore: store,
      spreadsheet: { values: withB, selection, alertResponse: 'OK' },
    })
    ok.call('njaMenuNormalize')
    assert.equal(cell(ok, 4, 2), '東京都千代田区千代田1-1')
    assert.equal(ok.sheet.alerts.length, 2)
  })

  test('時間切れ: 処理できた分だけ書いて中断を知らせる', () => {
    const env = createGasEnv({
      cacheStore: store,
      spreadsheet: { values, selection },
      testOptions: { menuBudgetMs: -1 },
    })
    env.call('njaMenuNormalize')
    assert.equal(cell(env, 2, 2), '')
    assert.match(env.sheet.alerts[0], /時間切れ/)
    assert.match(env.sheet.alerts[0], /残り 5 行/)
  })
})

describe('I/O 層（UrlFetchApp + CacheService）', () => {
  test('2 回目の実行はキャッシュから読み、通信しない。大きい値は分割保存される', () => {
    const freshStore = new Map()
    const first = createGasEnv({ cacheStore: freshStore, licensed: true })
    assert.equal(first.call(FN, '岩手県盛岡市内丸10-1', 8), '岩手県盛岡市内丸10-1')
    // ja.json + 盛岡市.json + 地番/住居表示の Range 取得（レベル 8 のときだけ）
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

    const second = createGasEnv({ cacheStore: freshStore, licensed: true })
    assert.equal(second.call(FN, '岩手県盛岡市内丸10-1', 8), '岩手県盛岡市内丸10-1')
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
    const env = createGasEnv({ cacheStore: new Map(), urlFetchApp, licensed: true })
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1', 8), '岩手県盛岡市内丸10-1')
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
