import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGasEnv,
  DEFAULT_API_ENDPOINT,
  TEST_API_ENDPOINT,
  UPSTREAM_API_ENDPOINT,
  LICENSE_SECRET,
  TEST_SUB,
  VALID_LICENSE_KEY,
} from './gas-env.mjs'
import { createUrlFetchApp, liveHandler } from './gas-mocks.mjs'
import { issueLicenseKey, verifyLicenseKey } from '../scripts/license-core.mjs'

const FN = 'NORMALIZE_JPN_ADDRESS'
const OLD_FN = 'NORMALZE_JPN_ADDRESS'
const MENU_ONLY = /メニュー「拡張機能 › 選択範囲を正規化」（ライセンス版）/
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
    env = createGasEnv({ cacheStore: store })
  })

  test('旧名 NORMALZE_JPN_ADDRESS でも同じ結果', () => {
    assert.equal(env.call(OLD_FN, '岩手県盛岡市内丸10-1', 3), '岩手県盛岡市内丸10-1')
    assert.equal(env.call(OLD_FN, ''), '')
  })

  test('既定（3）は町丁目まで。番地・号のデータが無い住所でも通る', () => {
    assert.equal(
      env.call(FN, '東京都千代田区千代田１−１'),
      '東京都千代田区千代田1-1',
    )
    assert.equal(env.call(FN, '千代田区千代田1-1'), '東京都千代田区千代田1-1')
    // 番地・号は「残り」として連結されるので、町丁目までの正規化でも見た目は番地込みになる
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1'), '岩手県盛岡市内丸10-1')
    assert.equal(env.call(FN, '大阪府大阪市北区梅田1-1-3'), '大阪府大阪市北区梅田一丁目1-3')
  })

  test('レベル 4〜8 はカスタム関数では使えず、メニューへの案内になる（ライセンスの有無によらない）', () => {
    for (const level of [4, 8, '8']) {
      assert.throws(() => env.call(FN, '岩手県盛岡市内丸10-1', level), MENU_ONLY)
    }
    // 範囲入力でも呼び出し全体がエラー（行ごとの文字列ではない）
    assert.throws(() => env.call(FN, [['岩手県盛岡市内丸10-1']], 8), MENU_ONLY)
    const licensed = createGasEnv({ cacheStore: store, licensed: true })
    assert.throws(() => licensed.call(FN, '岩手県盛岡市内丸10-1', 8), MENU_ONLY)
    // 判定に ID トークンもプロパティも要らないので、カスタム関数は ScriptApp に触らない
    assert.equal(licensed.fetchLog.filter((c) => !c.url.includes('.json')).length, 0)
  })

  test('レベル不足なら例外（単セルは #ERROR! になる）', () => {
    assert.throws(
      () => env.call(FN, '千代田区', 3),
      new RegExp(LEVEL_ERR(2, 3)),
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
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1', '3'), '岩手県盛岡市内丸10-1')
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1', ''), '岩手県盛岡市内丸10-1')
    assert.equal(env.call(FN, '岩手県盛岡市内丸10-1', 0), '岩手県盛岡市内丸10-1')
    for (const bad of ['abc', 9, -1, 2.5, [[3]]]) {
      assert.throws(() => env.call(FN, '岩手県盛岡市内丸10-1', bad), /第2引数/)
    }
  })

  test('範囲（1 列）: 形を保ち、失敗した行だけ文字列エラーになる', () => {
    const input = [
      ['大阪府大阪市北区梅田1-1-3'],
      [''],
      ['千代田区'],
      ['存在しない住所です'],
      ['大阪府大阪市北区梅田1-1-3'], // 重複（メモ化される）
    ]
    assert.deepEqual(plain(env.call(FN, input, 3)), [
      ['大阪府大阪市北区梅田一丁目1-3'],
      [''],
      [`#LEVEL ${LEVEL_ERR(2, 3)}`],
      [`#LEVEL ${LEVEL_ERR(0, 3)}`],
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

describe('ライセンス', () => {
  const store = new Map()
  const OTHER_SUB = '999999999999999999999'
  const OTHER_KEY = issueLicenseKey(LICENSE_SECRET, OTHER_SUB)

  test('キーの発行と検証: Node 側とアドオン側で一致し、sub に紐づく', () => {
    const env = createGasEnv({ cacheStore: store })
    assert.match(VALID_LICENSE_KEY, /^NJA-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/)
    assert.ok(verifyLicenseKey(LICENSE_SECRET, TEST_SUB, VALID_LICENSE_KEY))
    assert.ok(env.NJA.verifyLicenseKey(TEST_SUB, VALID_LICENSE_KEY))
    // 書式のゆれ（小文字、区切り無し、空白）は許容
    assert.ok(env.NJA.verifyLicenseKey(TEST_SUB, VALID_LICENSE_KEY.toLowerCase()))
    assert.ok(env.NJA.verifyLicenseKey(TEST_SUB, ' ' + VALID_LICENSE_KEY.replace(/-/g, '') + ' '))
    // 別のアカウント（sub）では通らない。逆も同じ
    assert.equal(env.NJA.verifyLicenseKey(OTHER_SUB, VALID_LICENSE_KEY), false)
    assert.equal(env.NJA.verifyLicenseKey(TEST_SUB, OTHER_KEY), false)
    assert.ok(env.NJA.verifyLicenseKey(OTHER_SUB, OTHER_KEY))
    assert.notEqual(VALID_LICENSE_KEY, OTHER_KEY)
    // 1 文字違い、別の秘密鍵、空、不正な sub は不可
    const tampered = VALID_LICENSE_KEY.slice(0, -1) + (VALID_LICENSE_KEY.endsWith('A') ? 'B' : 'A')
    assert.equal(env.NJA.verifyLicenseKey(TEST_SUB, tampered), false)
    assert.equal(env.NJA.verifyLicenseKey(TEST_SUB, issueLicenseKey('another-secret-another-secret-xx', TEST_SUB)), false)
    assert.equal(env.NJA.verifyLicenseKey(TEST_SUB, ''), false)
    assert.equal(env.NJA.verifyLicenseKey(TEST_SUB, null), false)
    assert.equal(env.NJA.verifyLicenseKey('', VALID_LICENSE_KEY), false)
    assert.equal(env.NJA.verifyLicenseKey('abc', VALID_LICENSE_KEY), false)
    assert.throws(() => issueLicenseKey(LICENSE_SECRET, 'not-a-sub'), /sub は数字だけ/)
    assert.equal(env.NJA.maskLicenseKey(VALID_LICENSE_KEY), 'NJA-' + VALID_LICENSE_KEY.slice(4, 9) + '-•••••-•••••-' + VALID_LICENSE_KEY.slice(-5))
  })

  test('状態: 未登録なら購入 URL に自分の sub が付く。ID トークンが取れなければ素の URL', () => {
    const env = createGasEnv({ cacheStore: store })
    const status = env.call('njaGetLicenseStatus')
    assert.equal(status.licensed, false)
    assert.equal(status.maskedKey, '')
    assert.equal(status.userId, TEST_SUB)
    assert.equal(status.purchaseUrl, env.NJA.purchaseUrl + '?client_reference_id=' + TEST_SUB)

    const noToken = createGasEnv({ cacheStore: store, sub: null })
    const s2 = noToken.call('njaGetLicenseStatus')
    assert.equal(s2.licensed, false)
    assert.equal(s2.userId, '')
    assert.equal(s2.purchaseUrl, env.NJA.purchaseUrl)
  })

  test('状態: 保存されたキーは、いまのアカウントの sub で照合される', () => {
    const mine = createGasEnv({ cacheStore: store, licensed: true })
    const status = mine.call('njaGetLicenseStatus')
    assert.equal(status.licensed, true)
    assert.equal(status.maskedKey, mine.NJA.maskLicenseKey(VALID_LICENSE_KEY))
    // 他人のキーが入っていても（あり得ないが）未ライセンス扱い
    const others = createGasEnv({ cacheStore: store, userProperties: { NJA_LICENSE_KEY: OTHER_KEY } })
    assert.equal(others.call('njaGetLicenseStatus').licensed, false)
    // 自分のキーでも、アカウントを確認できなければ未ライセンス扱い
    const noToken = createGasEnv({ cacheStore: store, licensed: true, sub: null })
    assert.equal(noToken.call('njaGetLicenseStatus').licensed, false)
  })

  test('サイドバーからの登録・削除: 自分の sub 用のキーだけ保存される', () => {
    const env = createGasEnv({ cacheStore: store })
    assert.throws(() => env.call('njaSetLicenseKey', 'NJA-XXXXX'), /正しくないか/)
    assert.throws(() => env.call('njaSetLicenseKey', OTHER_KEY), /この Google アカウント用のキーではありません/)
    assert.equal(env.properties.user.has('NJA_LICENSE_KEY'), false)

    const status = env.call('njaSetLicenseKey', ' ' + VALID_LICENSE_KEY.toLowerCase() + ' ')
    assert.equal(status.licensed, true)
    // 正規化した形で UserProperties にだけ保存される
    assert.equal(env.properties.user.get('NJA_LICENSE_KEY'), VALID_LICENSE_KEY.replace(/-/g, ''))
    assert.equal(env.properties.document.size, 0)

    const cleared = env.call('njaClearLicenseKey')
    assert.equal(cleared.licensed, false)
    assert.equal(env.properties.user.has('NJA_LICENSE_KEY'), false)

    // ID トークンが取れない環境では登録できない（理由を示す）
    const noToken = createGasEnv({ cacheStore: store, sub: null })
    assert.throws(() => noToken.call('njaSetLicenseKey', VALID_LICENSE_KEY), /Google アカウントを確認できませんでした/)
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
      ['njaMenuNormalize', 'njaMenuMapLinks', 'njaMenuLatLng', 'njaShowSidebar'],
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

  test('地図リンクと緯度経度: 未ライセンスは購入案内（sub 付き URL）だけで書き込まない', () => {
    for (const fn of ['njaMenuMapLinks', 'njaMenuLatLng']) {
      const env = createGasEnv({ cacheStore: store, spreadsheet: { values, selection } })
      env.call(fn)
      assert.equal(env.sheet.alerts.length, 1)
      assert.match(env.sheet.alerts[0], /ライセンス版の機能/)
      assert.match(env.sheet.alerts[0], new RegExp('client_reference_id=' + TEST_SUB))
      assert.equal(cell(env, 2, 2), '')
    }
    // 他人のキーが保存されていても同じ
    const others = createGasEnv({
      cacheStore: store,
      spreadsheet: { values, selection },
      userProperties: { NJA_LICENSE_KEY: issueLicenseKey(LICENSE_SECRET, '999999999999999999999') },
    })
    others.call('njaMenuMapLinks')
    assert.match(others.sheet.alerts[0], /ライセンス版の機能/)
  })

  test('緯度経度（ライセンスあり）: 右隣 3 列に緯度、経度、到達レベル', () => {
    const env = createGasEnv({ cacheStore: store, licensed: true, spreadsheet: { values, selection } })
    env.call('njaMenuLatLng')
    assert.ok(cell(env, 2, 2) > 39 && cell(env, 2, 2) < 40, 'lat')
    assert.ok(cell(env, 2, 3) > 141 && cell(env, 2, 3) < 142, 'lng')
    assert.equal(cell(env, 2, 4), 8)
    assert.deepEqual([cell(env, 3, 2), cell(env, 3, 3), cell(env, 3, 4)], ['', '', ''])
    assert.equal(cell(env, 4, 4), 3, '千代田は町丁目の代表点')
    assert.ok(cell(env, 4, 2) > 35 && cell(env, 4, 2) < 36)
    assert.match(cell(env, 5, 2), /^#ERROR .*位置情報がありません/)
    assert.deepEqual([cell(env, 5, 3), cell(env, 5, 4)], ['', ''])
    assert.equal(cell(env, 2, 5), '', '4 列目には書かない')
    assert.match(env.sheet.alerts[0], /5 行を処理しました（エラー 1 行）/)
    assert.match(env.sheet.alerts[0], /右隣の 3 列に緯度、経度、到達レベル/)
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
    // 番地・号まで（メニューと同じ経路）。カスタム関数は町丁目までなので NJA を直接呼ぶ
    const deep = (env) => env.NJA.normalize('岩手県盛岡市内丸10-1', { level: 8 })
    const first = createGasEnv({ cacheStore: freshStore })
    assert.equal(deep(first).level, 8)
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

    const second = createGasEnv({ cacheStore: freshStore })
    assert.equal(deep(second).level, 8)
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
    assert.equal(env.NJA.normalize('岩手県盛岡市内丸10-1', { level: 8 }).level, 8)
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
