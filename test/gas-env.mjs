/**
 * Apps Script 実行環境の再現。
 *
 * Node の vm で「素の V8 コンテキスト」を作る。そこには ECMAScript の組み込み
 * （Promise, RegExp, JSON など）しか無く、setTimeout / fetch / URL / window /
 * TextDecoder / AbortController / process といったホスト提供の API は存在しない。
 * これは Apps Script の V8 ランタイムとほぼ同じ条件なので、バンドルがブラウザや
 * Node の API に依存していればここで落ちる。
 *
 * 1 つの createGasEnv() が Apps Script の 1 回の実行（カスタム関数 1 回）に相当する。
 * CacheService の store を共有すると、実行をまたいだキャッシュの挙動を試せる。
 */
import vm from 'node:vm'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createCacheService,
  createHtmlService,
  createPropertiesService,
  createSpreadsheetApp,
  createUrlFetchApp,
  createUtilities,
} from './gas-mocks.mjs'
import { issueLicenseKey } from '../scripts/license-core.mjs'
import { readLicenseSecret } from '../scripts/license-secret.mjs'

const GAS_DIR = fileURLToPath(new URL('../dist/', import.meta.url))
const BUNDLE_PATH = `${GAS_DIR}normalize-japanese-addresses.js`
const CODE_PATH = `${GAS_DIR}Code.js`
const pkg = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
)

/**
 * テストが住所データを取りに行く先。
 * 既定は Geolonia の公開 API（nja.upstreamEndpoint）。自前配信（nja.apiEndpoint）を
 * 試すときは環境変数 NJA_TEST_API_ENDPOINT で指定する:
 *   NJA_TEST_API_ENDPOINT=https://normalize-jpn-address.pizzabun-lab.com/api/ja npm test
 * .cache/http/ は URL ごとにキャッシュされるので、取得先を変えると初回は再取得になる。
 */
export const TEST_API_ENDPOINT =
  process.env.NJA_TEST_API_ENDPOINT || pkg.nja.upstreamEndpoint
export const DEFAULT_API_ENDPOINT = pkg.nja.apiEndpoint
export const UPSTREAM_API_ENDPOINT = pkg.nja.upstreamEndpoint

/** ビルドと同じ秘密鍵で作った、有効なライセンスキー */
export const LICENSE_SECRET = readLicenseSecret().secret
export const VALID_LICENSE_KEY = issueLicenseKey(LICENSE_SECRET, 'TESTKEY2')

const HOST_GLOBALS_THAT_MUST_BE_ABSENT = [
  'setTimeout',
  'setInterval',
  'fetch',
  'URL',
  'window',
  'document',
  'self',
  'TextDecoder',
  'AbortController',
  'process',
  'require',
  'Buffer',
]

/**
 * @param {{
 *   cacheStore?: Map<string,string>,
 *   urlFetchApp?: object,
 *   testOptions?: object,
 *   scriptProperties?: Record<string,string> | null,
 *   logger?: (…args:any[]) => void,
 * }} options
 *   scriptProperties: Script Properties の初期値。省略時は NJA_API_ENDPOINT に
 *   TEST_API_ENDPOINT を入れる。null を渡すと空（ビルド時の既定の取得先が使われる）。
 *   licensed: true なら UserProperties に有効なライセンスキーを入れる（既定 false）。
 *   spreadsheet: SpreadsheetApp モックの初期状態（values / selection / alertResponse）。
 *   userProperties / documentProperties: それぞれの初期値（licensed より優先）。
 */
export function createGasEnv({
  cacheStore,
  urlFetchApp,
  testOptions,
  scriptProperties,
  licensed = false,
  userProperties,
  documentProperties,
  spreadsheet,
  logger = () => {},
} = {}) {
  const fetchLog = []
  const properties = {
    script: new Map(
      Object.entries(
        scriptProperties === undefined
          ? { NJA_API_ENDPOINT: TEST_API_ENDPOINT }
          : scriptProperties || {},
      ),
    ),
    user: new Map(
      Object.entries(
        userProperties || (licensed ? { NJA_LICENSE_KEY: VALID_LICENSE_KEY } : {}),
      ),
    ),
    document: new Map(Object.entries(documentProperties || {})),
  }
  const services = {
    UrlFetchApp: urlFetchApp || createUrlFetchApp({ log: fetchLog }),
    CacheService: createCacheService(cacheStore),
    PropertiesService: createPropertiesService(properties),
    Utilities: createUtilities(),
    SpreadsheetApp: createSpreadsheetApp(spreadsheet),
    HtmlService: createHtmlService(),
    Logger: { log: logger },
    console: { log: logger, warn: logger, error: logger, info: logger },
  }
  if (testOptions) {
    services.NJA_TEST_OPTIONS = testOptions
  }

  const ctx = vm.createContext(services)
  for (const name of HOST_GLOBALS_THAT_MUST_BE_ABSENT) {
    assert.equal(
      vm.runInContext(`typeof ${name}`, ctx),
      'undefined',
      `test env must not provide ${name}`,
    )
  }

  vm.runInContext(readFileSync(BUNDLE_PATH, 'utf8'), ctx, {
    filename: 'normalize-japanese-addresses.js',
  })
  vm.runInContext(readFileSync(CODE_PATH, 'utf8'), ctx, { filename: 'Code.js' })

  const urlFetchLog = services.UrlFetchApp._log || fetchLog
  return {
    ctx,
    fetchLog: urlFetchLog,
    /** PropertiesService の中身（script / user / document の Map） */
    properties,
    /** SpreadsheetApp モックのシート状態（cells / rich / alerts / menuItems） */
    sheet: services.SpreadsheetApp._sheet,
    NJA: vm.runInContext('NJA', ctx),
    /** グローバル関数を名前で呼ぶ（カスタム関数の呼び出しに相当） */
    call(name, ...args) {
      const fn = vm.runInContext(name, ctx)
      return fn(...args)
    },
  }
}
