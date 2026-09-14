/**
 * NORMALIZE_JPN_ADDRESS — Google スプレッドシート用カスタム関数
 *
 * 正規化本体はビルド生成物 dist/normalize-japanese-addresses.js（src/main-gas.ts 由来）で、
 * グローバル `NJA` として読み込まれる。ここではセル入出力、エラー処理、ライセンス判定だけを行う。
 *
 * このファイルは import/export を持たない「スクリプト」として書く。Apps Script は
 * トップレベルの関数をそのままカスタム関数やメニューのハンドラとして認識するため、
 * モジュールにするとセルから呼べなくなる（ビルド時に検査している）。
 * ビルドでは型注釈だけを取り除いて dist/Code.js にする（JSDoc の @customfunction は残る）。
 *
 * 命名規則: 末尾が `_` の関数は Apps Script の非公開関数（セルやメニューから呼べない）。
 *
 * 無料と有料の境界:
 *   無料 … カスタム関数 NORMALIZE_JPN_ADDRESS（レベル 0〜3、町丁目まで）。ライブラリの機能そのまま
 *   有料 … メニューの一括処理のうち、番地・号までの正規化、地図リンク、緯度経度
 *   カスタム関数にはライセンス判定を置かない。カスタム関数は利用者の権限なしで動くため
 *   Google アカウントを確認できず、アカウント単位のライセンスと相性が悪い。
 *   メニューとサイドバーは利用者の権限で動くので、ID トークンの sub とキーを突き合わせられる。
 */

/** ビルド生成物 normalize-japanese-addresses.js が定義するグローバル（同期化済みの形） */
declare const NJA: import('./main-gas').NjaGlobal
/** テストからの上書き用（test/gas-env.mjs が与える。本番では未定義） */
declare const NJA_TEST_OPTIONS:
  | { batchBudgetMs?: number; menuBudgetMs?: number }
  | undefined

type NormalizeResult = import('./main-gas').NormalizeResult

/** セルから渡ってくる値 */
type CellValue = string | number | boolean | Date | null | undefined
/** 単セル、または範囲（行の配列） */
type CellArg = CellValue | CellValue[][]
/** 1 件の結果を並べるセル（1 列なら長さ 1） */
type Cells = Array<string | number>
/** 結果オブジェクトからセルを作る */
type Formatter = (result: NormalizeResult) => Cells

type RowErrorCode = 'LEVEL' | 'ERROR' | 'TIMEOUT'

/** 1 件の正規化の結果。例外にせず値として返す */
type Outcome =
  | { value: Cells; error?: undefined }
  | { value?: undefined; error: { code: RowErrorCode; message: string } }

type LicenseStatus = {
  licensed: boolean
  maskedKey: string
  /** 購入ページ。Google アカウントが分かっていれば client_reference_id に sub が付く */
  purchaseUrl: string
  /** Google アカウントの sub（サポートや手動発行の照合用）。確認できなければ空 */
  userId: string
}

/** 第2引数省略時の許容レベル（町丁目まで。市区町村ごとに 1 回の通信で済む） */
const NJA_DEFAULT_LEVEL = 3
/** ライブラリが返す最大レベル（番地・号） */
const NJA_MAX_LEVEL = 8
/** 町丁目レベル。カスタム関数はここまで。これを超える正規化はメニュー（有料）だけ */
const NJA_TOWN_LEVEL = 3
/** カスタム関数の上限（30 秒）に対して余裕を持たせた処理時間の目安 */
const NJA_BATCH_BUDGET_MS = 22000
/** メニューから実行するスクリプトの上限（6 分）に対する目安 */
const NJA_MENU_BUDGET_MS = 5 * 60 * 1000
/** メニュー処理で途中結果を書き込む間隔（行数）。上限で止まっても直前までは残る */
const NJA_MENU_FLUSH_ROWS = 100
/** ライセンスキーを保存する UserProperties のキー（利用者の Google アカウント単位） */
const NJA_LICENSE_PROPERTY = 'NJA_LICENSE_KEY'

// ---------------------------------------------------------------------------
// カスタム関数
// ---------------------------------------------------------------------------

/**
 * 日本の住所を町丁目まで正規化します（Geolonia normalize-japanese-addresses を使用）。番地・号までの正規化はメニュー「選択範囲を正規化」（ライセンス版）で行えます。
 *
 * @param {"東京都千代田区千代田１−１"} address 住所の文字列、または 1 列か 1 行のセル範囲（例: A2:A1000）。
 * @param {3} level 省略可。許容する最小の正規化レベル（0〜3）。結果がこのレベルに満たない場合はエラー。省略時は 3（町丁目まで）。
 * @return 正規化した住所（都道府県 + 市区町村 + 町丁目 + 番地・号 + その他）。
 * @customfunction
 */
function NORMALIZE_JPN_ADDRESS(address: CellArg, level?: CellArg): string | string[][] {
  const required = njaParseLevel_(level)
  return njaRun_(address, required, njaFormatAddress_, 1) as string | string[][]
}

/**
 * NORMALIZE_JPN_ADDRESS の旧名です（綴りの誤りを修正する前の名前。互換のために残しています）。
 *
 * @param {"東京都千代田区千代田１−１"} address 住所の文字列、または 1 列か 1 行のセル範囲。
 * @param {3} level 省略可。許容する最小の正規化レベル（0〜3）。
 * @return 正規化した住所。
 * @customfunction
 */
function NORMALZE_JPN_ADDRESS(address: CellArg, level?: CellArg): string | string[][] {
  return NORMALIZE_JPN_ADDRESS(address, level)
}

// ---------------------------------------------------------------------------
// 引数の解釈
// ---------------------------------------------------------------------------

/**
 * カスタム関数の第2引数。0〜3 だけを受け付ける。
 * 4〜8 は書式としては正しいので、エラーではなくメニューへの案内にする。
 */
function njaParseLevel_(level: CellArg): number {
  if (level === undefined || level === null || level === '') {
    return NJA_DEFAULT_LEVEL
  }
  if (Array.isArray(level)) {
    throw new Error('第2引数（level）には範囲ではなく数値を指定してください')
  }
  const n = typeof level === 'number' ? level : Number(String(level).trim())
  if (!isFinite(n) || Math.floor(n) !== n || n < 0 || n > NJA_MAX_LEVEL) {
    throw new Error('第2引数（level）は 0〜3 の整数で指定してください')
  }
  if (n > NJA_TOWN_LEVEL) {
    throw new Error(
      '番地・号までの正規化（レベル ' +
        n +
        '）は、メニュー「拡張機能 › 選択範囲を正規化」（ライセンス版）で行えます。数式では 0〜3 を指定してください',
    )
  }
  return n
}

/**
 * ライブラリに渡す正規化の深さ。
 * 0〜3 は町丁目まで（市区町村ごとに 1 回の通信で済む）、それ以上は番地・号まで試みる。
 */
function njaLibraryLevel_(required: number): number {
  return required <= NJA_TOWN_LEVEL ? NJA_TOWN_LEVEL : NJA_MAX_LEVEL
}

function njaToText_(value: CellValue): string {
  if (value === undefined || value === null) {
    return ''
  }
  return String(value).trim()
}

// ---------------------------------------------------------------------------
// 正規化
// ---------------------------------------------------------------------------

/**
 * 単セルと範囲の振り分け。
 * 単セル: 空なら ''、成功なら width 1 は文字列、それ以外は 1 行の 2 次元配列。失敗は例外。
 * 範囲: 行ごとの結果（失敗した行は '#CODE …' の文字列）。
 */
function njaRun_(
  address: CellArg,
  required: number,
  format: Formatter,
  width: number,
): string | Array<Array<string | number>> {
  if (Array.isArray(address)) {
    return njaNormalizeRange_(address, required, format, width)
  }
  const text = njaToText_(address)
  if (text === '') {
    return ''
  }
  const r = njaNormalizeOne_(text, required, format)
  if (r.error) {
    throw new Error(r.error.message)
  }
  return width === 1 ? String(r.value[0]) : [r.value]
}

/**
 * 1 件正規化する。例外は投げない（範囲処理で 1 行の失敗が全体を止めないようにするため）。
 */
function njaNormalizeOne_(
  text: string,
  required: number,
  format: Formatter,
  libraryLevel: number = njaLibraryLevel_(required),
): Outcome {
  try {
    const result = NJA.normalize(text, { level: libraryLevel })
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new Error('内部エラー: 正規化処理が同期化されていません（ビルドを確認してください）')
    }
    if (result.level < required) {
      return {
        error: {
          code: 'LEVEL',
          message: njaLevelMessage_(result.level, required),
        },
      }
    }
    return { value: format(result) }
  } catch (e) {
    return {
      error: {
        code: 'ERROR',
        message: e instanceof Error ? e.message : String(e),
      },
    }
  }
}

function njaLevelMessage_(got: number, required: number): string {
  return '正規化レベルが不足しています（結果 ' + got + ' < 指定 ' + required + '）'
}

/**
 * 結果オブジェクトを 1 つの住所文字列にする。
 *   都道府県 + 市区町村 + 町丁目 + 番地・号 + その他
 * 「その他」（正規化できなかった残り）は、番地・号が確定していれば半角スペースで区切り、
 * そうでなければ数字で始まる場合のみ直結する（例: 町丁目 + "8-1 ビル名"）。
 */
function njaFormatAddress_(result: NormalizeResult): Cells {
  const head = [result.pref, result.city, result.town, result.addr]
    .filter((p) => !!p)
    .join('')
  const other = njaToText_(result.other)
  if (!other) {
    return [head]
  }
  if (!head) {
    return [other]
  }
  if (result.addr) {
    return [head + ' ' + other]
  }
  return [/^[0-9]/.test(other) ? head + other : head + ' ' + other]
}

function njaPoint_(result: NormalizeResult): { lat: number; lng: number } {
  const p = result.point
  if (!p || typeof p.lat !== 'number' || typeof p.lng !== 'number') {
    throw new Error('この住所には位置情報がありません')
  }
  return { lat: p.lat, lng: p.lng }
}

/** Google マップで位置を開く URL（Maps URLs の search） */
function njaFormatMapUrl_(result: NormalizeResult): Cells {
  const p = njaPoint_(result)
  return ['https://www.google.com/maps/search/?api=1&query=' + p.lat + '%2C' + p.lng]
}

function njaFormatLatLng_(result: NormalizeResult): Cells {
  const p = njaPoint_(result)
  return [p.lat, p.lng]
}

/** メニュー用: 住所と到達レベル */
function njaFormatAddressWithLevel_(result: NormalizeResult): Cells {
  return [njaFormatAddress_(result)[0], result.level]
}

/** メニュー用: 地図 URL と到達レベル */
function njaFormatMapUrlWithLevel_(result: NormalizeResult): Cells {
  return [njaFormatMapUrl_(result)[0], result.level]
}

/** メニュー用: 緯度、経度、到達レベル */
function njaFormatLatLngWithLevel_(result: NormalizeResult): Cells {
  const p = njaFormatLatLng_(result)
  return [p[0], p[1], result.level]
}

/** 範囲入力の行に埋めるエラー表記（Sheets のエラーではなく文字列） */
function njaRowError_(code: RowErrorCode, message: string): string {
  return '#' + code + ' ' + message
}

function njaRangeShape_(values: CellValue[][]): 'column' | 'row' {
  if (values.length === 0) {
    return 'column'
  }
  const isColumn = values.every((row) => Array.isArray(row) && row.length === 1)
  if (isColumn) {
    return 'column'
  }
  if (values.length === 1 && Array.isArray(values[0])) {
    return 'row'
  }
  throw new Error('範囲は 1 列または 1 行で指定してください（例: A2:A1000）')
}

function njaPad_(cells: Cells, width: number): Cells {
  const out = cells.slice(0, width)
  while (out.length < width) {
    out.push('')
  }
  return out
}

/**
 * 範囲入力。入力と同じ向き（列なら下へ、行なら右へ）に展開する。
 * width が 2 以上のとき、列入力は行ごとに width 列、行入力は width 行になる。
 */
function njaNormalizeRange_(
  values: CellValue[][],
  required: number,
  format: Formatter,
  width: number,
): Array<Array<string | number>> {
  const shape = njaRangeShape_(values)
  const inputs = shape === 'column' ? values.map((row) => row[0]) : values[0]

  const budgetMs = njaBatchBudgetMs_()
  const started = Date.now()
  const memo: { [text: string]: Cells } = {}
  const out: Cells[] = []

  for (let i = 0; i < inputs.length; i++) {
    const text = njaToText_(inputs[i])
    if (text === '') {
      out.push(njaPad_([], width))
      continue
    }
    if (Object.prototype.hasOwnProperty.call(memo, text)) {
      out.push(memo[text])
      continue
    }
    if (Date.now() - started > budgetMs) {
      out.push(
        njaPad_(
          [
            njaRowError_(
              'TIMEOUT',
              '制限時間内に処理できませんでした。範囲を分割して再実行してください',
            ),
          ],
          width,
        ),
      )
      continue
    }
    const r = njaNormalizeOne_(text, required, format)
    const cells = njaPad_(
      r.error ? [njaRowError_(r.error.code, r.error.message)] : r.value,
      width,
    )
    memo[text] = cells
    out.push(cells)
  }

  if (shape === 'column') {
    return out
  }
  // 行入力: 転置して width 行 × n 列
  const rows: Array<Array<string | number>> = []
  for (let c = 0; c < width; c++) {
    rows.push(out.map((cells) => cells[c]))
  }
  return rows
}

function njaBatchBudgetMs_(): number {
  // テストからの上書き用（typeof で見るのは、本番では宣言自体が無いため）
  if (
    typeof NJA_TEST_OPTIONS !== 'undefined' &&
    NJA_TEST_OPTIONS &&
    typeof NJA_TEST_OPTIONS.batchBudgetMs === 'number'
  ) {
    return NJA_TEST_OPTIONS.batchBudgetMs
  }
  return NJA_BATCH_BUDGET_MS
}

function njaMenuBudgetMs_(): number {
  if (
    typeof NJA_TEST_OPTIONS !== 'undefined' &&
    NJA_TEST_OPTIONS &&
    typeof NJA_TEST_OPTIONS.menuBudgetMs === 'number'
  ) {
    return NJA_TEST_OPTIONS.menuBudgetMs
  }
  return NJA_MENU_BUDGET_MS
}

// ---------------------------------------------------------------------------
// メニューからの一括処理
// ---------------------------------------------------------------------------

type MenuMode = 'normalize' | 'map' | 'latlng'

/** モードごとの設定。cellWidth は内部で持つセル数、width は実際に書く列数（地図は 1 列のリンク） */
const NJA_MENU_MODES: {
  [M in MenuMode]: { format: Formatter; cellWidth: number; width: number; label: string }
} = {
  normalize: { format: njaFormatAddressWithLevel_, cellWidth: 2, width: 2, label: '正規化した住所と到達レベル' },
  map: { format: njaFormatMapUrlWithLevel_, cellWidth: 2, width: 1, label: '地図リンク' },
  latlng: { format: njaFormatLatLngWithLevel_, cellWidth: 3, width: 3, label: '緯度、経度、到達レベル' },
}

/** メニュー「選択範囲を正規化」: 右隣 2 列に住所とレベルを書く（無料。ライセンスがあれば番地・号まで） */
function njaMenuNormalize(): void {
  njaMenuRun_('normalize')
}

/** メニュー「選択範囲に地図リンクを付ける」: 右隣 1 列にリンク付きテキストを書く（ライセンス） */
function njaMenuMapLinks(): void {
  njaMenuRun_('map')
}

/** メニュー「選択範囲に緯度経度を付ける」: 右隣 3 列に緯度、経度、レベルを書く（ライセンス） */
function njaMenuLatLng(): void {
  njaMenuRun_('latlng')
}

/**
 * 選択した 1 列の住所を処理し、右隣の列に結果を書く。
 * カスタム関数と違い、しきい値は設けず「できるところまで」正規化して到達レベルを併記する。
 * ライセンスがあれば番地・号まで、無ければ町丁目まで試みる（地図と緯度経度はライセンス必須）。
 * NJA_MENU_FLUSH_ROWS 行ごとに書き込むので、実行時間の上限で止まっても直前までは残る。
 */
function njaMenuRun_(mode: MenuMode): void {
  const ui = SpreadsheetApp.getUi()
  const selection = SpreadsheetApp.getActiveRange()
  if (!selection || selection.getNumColumns() !== 1) {
    ui.alert('住所が入った 1 列（例: A2:A100）を選択してから実行してください')
    return
  }
  const license = njaLicenseStatus_()
  if (mode !== 'normalize' && !license.licensed) {
    ui.alert(
      '地図リンクと緯度経度はライセンス版の機能です',
      '「使い方とライセンス」からキーを登録してください。\n購入: ' + license.purchaseUrl,
      ui.ButtonSet.OK,
    )
    return
  }

  const sheet = selection.getSheet()
  const row = selection.getRow()
  const column = selection.getColumn()
  const rows = selection.getNumRows()
  const { format, cellWidth, width, label } = NJA_MENU_MODES[mode]
  const target = sheet.getRange(row, column + 1, rows, width)
  const hasExisting = target
    .getValues()
    .some((line) => line.some((v) => v !== '' && v !== null && v !== undefined))
  if (hasExisting) {
    const answer = ui.alert(
      '右隣の列に既に値があります',
      target.getA1Notation() + ' を上書きしますか？',
      ui.ButtonSet.OK_CANCEL,
    )
    if (answer !== ui.Button.OK) {
      return
    }
  }

  const libraryLevel = license.licensed ? NJA_MAX_LEVEL : NJA_TOWN_LEVEL
  const inputs = selection.getValues().map((line) => line[0] as CellValue)
  const budgetMs = njaMenuBudgetMs_()
  const started = Date.now()
  const memo: { [text: string]: Cells } = {}
  let pending: Cells[] = []
  let pendingStart = 0
  let processed = 0
  let errors = 0

  const flush = () => {
    if (pending.length === 0) {
      return
    }
    const out = sheet.getRange(row + pendingStart, column + 1, pending.length, width)
    if (mode === 'map') {
      out.setRichTextValues(pending.map((cells) => [njaMapLinkCell_(cells)]))
    } else {
      out.setValues(pending)
    }
    pendingStart += pending.length
    pending = []
  }

  for (let i = 0; i < inputs.length; i++) {
    if (Date.now() - started > budgetMs) {
      break
    }
    const text = njaToText_(inputs[i])
    let cells: Cells
    if (text === '') {
      cells = njaPad_([], cellWidth)
    } else if (Object.prototype.hasOwnProperty.call(memo, text)) {
      cells = memo[text]
    } else {
      const r = njaNormalizeOne_(text, 0, format, libraryLevel)
      cells = njaPad_(r.error ? [njaRowError_(r.error.code, r.error.message)] : r.value, cellWidth)
      memo[text] = cells
    }
    if (text !== '' && typeof cells[0] === 'string' && cells[0].charAt(0) === '#') {
      errors++
    }
    pending.push(cells)
    processed++
    if (pending.length >= NJA_MENU_FLUSH_ROWS) {
      flush()
    }
  }
  flush()

  const summary =
    processed + ' 行を処理しました（エラー ' + errors + ' 行）。' +
    '右隣の ' + width + ' 列に' + label + 'を書きました。' +
    (license.licensed ? '' : '\nライセンス版では番地・号まで正規化されます。')
  if (processed < inputs.length) {
    ui.alert(
      '時間切れで中断しました',
      summary + '\n残り ' + (inputs.length - processed) + ' 行は、その部分を選択して再実行してください。',
      ui.ButtonSet.OK,
    )
  } else {
    ui.alert('完了', summary, ui.ButtonSet.OK)
  }
}

/**
 * 地図モードの 1 セル: [url, level] → リンク付きテキスト。
 * レベル 8 なら「地図」、それ未満（町丁目の代表点など）は「地図（概略）」。エラーはそのまま文字列。
 */
function njaMapLinkCell_(cells: Cells): GoogleAppsScript.Spreadsheet.RichTextValue {
  const first = cells[0]
  const builder = SpreadsheetApp.newRichTextValue()
  if (typeof first === 'string' && first.indexOf('https://') === 0) {
    const level = typeof cells[1] === 'number' ? cells[1] : 0
    return builder
      .setText(level >= NJA_MAX_LEVEL ? '地図' : '地図（概略）')
      .setLinkUrl(first)
      .build()
  }
  return builder.setText(first === undefined || first === null ? '' : String(first)).build()
}

// ---------------------------------------------------------------------------
// ライセンス
// ---------------------------------------------------------------------------
//
// キーは購入者の Google アカウント（ID トークンの sub）から導出されている。
// ここでは「いまのアカウントの sub で同じ計算をして一致するか」だけを見る（NJA.verifyLicenseKey）。
// この節の関数はすべて利用者の権限で動く文脈（メニュー、サイドバー、スクリプトエディタ）からしか
// 呼ばない。カスタム関数からは ScriptApp.getIdentityToken() が使えない。

/** 1 回の実行内での判定結果のメモ（ID トークンの取得とプロパティの読み取りを繰り返さない） */
let njaLicenseMemo_: LicenseStatus | null = null

/**
 * いまの利用者の Google アカウントの sub。ID トークン（JWT）の payload から読む。
 * 自分の実行文脈で Google から直接受け取ったトークンなので、署名検証は要らない。
 * openid スコープが無い・認可されていないなどで取れなければ例外。
 */
function njaGoogleSub_(): string {
  let token: string
  try {
    token = ScriptApp.getIdentityToken()
  } catch (e) {
    throw new Error(
      'Google アカウントを確認できませんでした。アドオンの権限を確認（再認可）してから、もう一度お試しください',
    )
  }
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3) {
    throw new Error('Google アカウントを確認できませんでした（ID トークンの形式が不正です）')
  }
  let sub: unknown
  try {
    const json = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[1])).getDataAsString()
    sub = JSON.parse(json).sub
  } catch (e) {
    throw new Error('Google アカウントを確認できませんでした（ID トークンを読めません）')
  }
  if (!NJA.isGoogleSub(sub)) {
    throw new Error('Google アカウントを確認できませんでした（sub がありません）')
  }
  return sub
}

/** 購入ページ。sub を client_reference_id に載せると、決済完了ページがそのアカウント用のキーを出す */
function njaPurchaseUrl_(sub: string): string {
  const base = NJA.purchaseUrl
  return base + (base.indexOf('?') >= 0 ? '&' : '?') + 'client_reference_id=' + encodeURIComponent(sub)
}

function njaLicenseStatus_(): LicenseStatus {
  if (njaLicenseMemo_) {
    return njaLicenseMemo_
  }
  // アカウントを確認できなくても無料の範囲（メニューの町丁目まで）は動かす
  let sub = ''
  try {
    sub = njaGoogleSub_()
  } catch (e) {
    sub = ''
  }
  let key = ''
  try {
    key = PropertiesService.getUserProperties().getProperty(NJA_LICENSE_PROPERTY) || ''
  } catch (e) {
    key = ''
  }
  const licensed = sub !== '' && key !== '' && NJA.verifyLicenseKey(sub, key)
  njaLicenseMemo_ = {
    licensed,
    maskedKey: licensed ? NJA.maskLicenseKey(key) : '',
    purchaseUrl: sub ? njaPurchaseUrl_(sub) : NJA.purchaseUrl,
    userId: sub,
  }
  return njaLicenseMemo_
}

/** サイドバー用: 現在の状態 */
function njaGetLicenseStatus(): LicenseStatus {
  njaLicenseMemo_ = null
  return njaLicenseStatus_()
}

/**
 * サイドバー用: キーがこのアカウント用なら UserProperties に保存する。
 * 他人のキーは sub が違うので値が一致せず、ここで弾かれる。
 */
function njaSetLicenseKey(key: string): LicenseStatus {
  const normalized = NJA.normalizeLicenseKey(key)
  const sub = njaGoogleSub_()
  if (!NJA.verifyLicenseKey(sub, normalized)) {
    throw new Error(
      'ライセンスキーが正しくないか、この Google アカウント用のキーではありません。' +
        '購入時に表示されたキーを、購入したときと同じアカウントで貼り付けてください',
    )
  }
  PropertiesService.getUserProperties().setProperty(NJA_LICENSE_PROPERTY, normalized)
  njaLicenseMemo_ = null
  return njaLicenseStatus_()
}

/** サイドバー用: 保存したキーを消す */
function njaClearLicenseKey(): LicenseStatus {
  PropertiesService.getUserProperties().deleteProperty(NJA_LICENSE_PROPERTY)
  njaLicenseMemo_ = null
  return njaLicenseStatus_()
}

// ---------------------------------------------------------------------------
// アドオン UI（メニューとサイドバー）
// ---------------------------------------------------------------------------

function onOpen(
  _e?: GoogleAppsScript.Events.SheetsOnOpen | GoogleAppsScript.Events.AddonOnInstall,
): void {
  SpreadsheetApp.getUi()
    .createAddonMenu()
    .addItem('選択範囲を正規化', 'njaMenuNormalize')
    .addItem('選択範囲に地図リンクを付ける', 'njaMenuMapLinks')
    .addItem('選択範囲に緯度経度を付ける', 'njaMenuLatLng')
    .addSeparator()
    .addItem('使い方とライセンス', 'njaShowSidebar')
    .addToUi()
}

function onInstall(e?: GoogleAppsScript.Events.AddonOnInstall): void {
  onOpen(e)
}

function njaShowSidebar(): void {
  const html = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('日本の住所正規化関数')
  SpreadsheetApp.getUi().showSidebar(html)
}

// ---------------------------------------------------------------------------
// 動作確認（スクリプトエディタから実行する）
// ---------------------------------------------------------------------------

/** スクリプトエディタで実行し、ログで環境と結果を確認する */
function njaSelfTest(): void {
  const samples: Array<[string, number]> = [
    ['岩手県盛岡市内丸10-1', 3],
    ['大阪府大阪市北区梅田1-1-3', 3],
    ['東京都千代田区千代田１−１', 3],
    ['東京都新宿区西新宿2-8-1 都庁第一本庁舎', 3],
  ]
  Logger.log('library %s / add-on %s', NJA.libraryVersion, NJA.addonVersion)
  Logger.log(
    'api=%s (default=%s, upstream=%s; Script Properties の NJA_API_ENDPOINT で切り替え)',
    NJA.apiEndpoint,
    NJA.defaultApiEndpoint,
    NJA.upstreamApiEndpoint,
  )
  const license = njaGetLicenseStatus()
  Logger.log(
    'license: %s (userId=%s, key=%s, secret=%s)',
    license.licensed ? 'OK' : 'なし',
    license.userId || '(取得できず)',
    license.maskedKey,
    NJA.licenseSecretIsDev ? 'DEV' : 'production',
  )
  for (const [address, level] of samples) {
    const started = Date.now()
    let value: string | Array<Array<string | number>>
    try {
      value = NORMALIZE_JPN_ADDRESS(address, level)
    } catch (e) {
      value = 'ERROR: ' + (e instanceof Error ? e.message : String(e))
    }
    Logger.log('%s -> %s (%sms)', address, value, Date.now() - started)
  }
  // 番地・号まで（メニューと同じ経路）
  const deep = njaNormalizeOne_(samples[0][0], 0, njaFormatLatLngWithLevel_, NJA_MAX_LEVEL)
  Logger.log('latlng(level 8): %s', deep.error ? 'ERROR: ' + deep.error.message : deep.value)
  Logger.log('network=%s cacheHits=%s', NJA.stats.network, NJA.stats.cacheHits)
}
