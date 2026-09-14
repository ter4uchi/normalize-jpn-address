/**
 * Apps Script 用エントリ。
 *
 * 配布済みの UMD バンドルは `__internals` を公開しておらず fetch を差し替えられないため、
 * Node 版エントリ（main-node.ts）と同じ形で、ライブラリのソースを直接取り込んで
 * `__internals.fetch` に Apps Script 互換の I/O（gas-fetch.ts）を差し込む。
 *
 * このファイルは esbuild で IIFE（グローバル名 `NJA`）にまとめ、
 * その後 async/await を取り除いて dist/normalize-japanese-addresses.js に出力する。
 */
import * as Normalize from '../node_modules/@geolonia/normalize-japanese-addresses/src/normalize'
import {
  __internals,
  currentConfig,
} from '../node_modules/@geolonia/normalize-japanese-addresses/src/config'
import type { NormalizeResult } from '../node_modules/@geolonia/normalize-japanese-addresses/src/types'
import { gasFetch, fetchStats, type FetchStats } from './gas-fetch'
import {
  verifyLicenseKey as verifyWithSecret,
  maskLicenseKey,
  normalizeLicenseKey,
} from './license'

export type { NormalizeResult }

/**
 * Apps Script 側（src/Code.ts）から見たグローバル `NJA` の型。
 * ビルドで async/await が除去されるため、normalize は Promise ではなく結果を直接返す。
 * ここのエクスポート一覧と下の `export const` を対応させること。
 */
export type NjaGlobal = {
  normalize: (input: string, option?: Normalize.Option) => NormalizeResult
  config: Normalize.Config
  libraryVersion: string
  addonVersion: string
  /** 実際に使う住所データの取得先（Script Properties で上書きされていればその値） */
  apiEndpoint: string
  /** ビルド時に埋め込んだ既定の取得先（package.json の nja.apiEndpoint） */
  defaultApiEndpoint: string
  /** Geolonia の公開 API（package.json の nja.upstreamEndpoint）。障害時の切り替え先 */
  upstreamApiEndpoint: string
  stats: FetchStats
  /** ライセンスキーが正しい形式・署名か（通信しない） */
  verifyLicenseKey: (key: unknown) => boolean
  maskLicenseKey: (key: unknown) => string
  normalizeLicenseKey: (key: unknown) => string
  /** 購入ページ（site.config.json の purchaseUrl） */
  purchaseUrl: string
  /** 秘密鍵が開発用の固定値のとき true（本番ビルドでは false になるべき） */
  licenseSecretIsDev: boolean
}

// ビルド時に scripts/build.mjs が埋め込む
declare const __NJA_LIB_VERSION__: string
declare const __NJA_ADDON_VERSION__: string
declare const __NJA_API_ENDPOINT__: string
declare const __NJA_UPSTREAM_ENDPOINT__: string
declare const __NJA_LICENSE_SECRET__: string
declare const __NJA_LICENSE_SECRET_IS_DEV__: boolean
declare const __NJA_PURCHASE_URL__: string

/** Script Properties でこのキーに URL を入れると、再デプロイなしで取得先を切り替えられる */
const API_ENDPOINT_PROPERTY = 'NJA_API_ENDPOINT'

/**
 * 取得先の決定。Script Properties（スクリプトエディタの「プロジェクトの設定」）に
 * NJA_API_ENDPOINT があればそれを、無ければビルド時の既定値を使う。
 * 切り替え先は src/appsscript.json の urlFetchWhitelist に含まれている必要がある
 * （含まれていなければ UrlFetchApp が拒否する）。
 * PropertiesService は認可不要でカスタム関数からも使える。読めない環境では既定値に落とす。
 */
function resolveApiEndpoint(): string {
  try {
    if (typeof PropertiesService !== 'undefined') {
      const value = PropertiesService.getScriptProperties().getProperty(
        API_ENDPOINT_PROPERTY,
      )
      if (value && /^https:\/\/\S+$/.test(value)) {
        return value.replace(/\/+$/, '')
      }
    }
  } catch (e) {
    // 読めなければ既定値
  }
  return __NJA_API_ENDPOINT__
}

const resolvedApiEndpoint = resolveApiEndpoint()
currentConfig.japaneseAddressesApi = resolvedApiEndpoint
__internals.fetch = gasFetch

/** 正規化関数。ビルド後は同期関数になり、結果オブジェクトを直接返す */
export const normalize = Normalize.normalize
export const config = Normalize.config
export const libraryVersion = __NJA_LIB_VERSION__
export const addonVersion = __NJA_ADDON_VERSION__
export const apiEndpoint = resolvedApiEndpoint
export const defaultApiEndpoint = __NJA_API_ENDPOINT__
export const upstreamApiEndpoint = __NJA_UPSTREAM_ENDPOINT__
export const stats = fetchStats
export const verifyLicenseKey = (key: unknown): boolean =>
  verifyWithSecret(__NJA_LICENSE_SECRET__, key)
export { maskLicenseKey, normalizeLicenseKey }
export const purchaseUrl = __NJA_PURCHASE_URL__
export const licenseSecretIsDev = __NJA_LICENSE_SECRET_IS_DEV__
