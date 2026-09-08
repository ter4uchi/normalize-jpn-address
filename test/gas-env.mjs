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
  createSpreadsheetApp,
  createUrlFetchApp,
  createUtilities,
} from './gas-mocks.mjs'

const GAS_DIR = fileURLToPath(new URL('../gas/', import.meta.url))
const BUNDLE_PATH = `${GAS_DIR}normalize-japanese-addresses.js`
const CODE_PATH = `${GAS_DIR}Code.js`

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
 * @param {{ cacheStore?: Map<string,string>, urlFetchApp?: object, testOptions?: object, logger?: (…args:any[]) => void }} options
 */
export function createGasEnv({
  cacheStore,
  urlFetchApp,
  testOptions,
  logger = () => {},
} = {}) {
  const fetchLog = []
  const services = {
    UrlFetchApp: urlFetchApp || createUrlFetchApp({ log: fetchLog }),
    CacheService: createCacheService(cacheStore),
    Utilities: createUtilities(),
    SpreadsheetApp: createSpreadsheetApp(),
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
    NJA: vm.runInContext('NJA', ctx),
    /** グローバル関数を名前で呼ぶ（カスタム関数の呼び出しに相当） */
    call(name, ...args) {
      const fn = vm.runInContext(name, ctx)
      return fn(...args)
    },
  }
}
