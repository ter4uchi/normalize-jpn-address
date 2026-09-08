/**
 * Apps Script 用エントリ。
 *
 * 配布済みの UMD バンドルは `__internals` を公開しておらず fetch を差し替えられないため、
 * Node 版エントリ（main-node.ts）と同じ形で、ライブラリのソースを直接取り込んで
 * `__internals.fetch` に Apps Script 互換の I/O（gas-fetch.ts）を差し込む。
 *
 * このファイルは esbuild で IIFE（グローバル名 `NJA`）にまとめ、
 * その後 async/await を取り除いて gas/normalize-japanese-addresses.js に出力する。
 */
import * as Normalize from '../node_modules/@geolonia/normalize-japanese-addresses/src/normalize'
import {
  __internals,
  currentConfig,
} from '../node_modules/@geolonia/normalize-japanese-addresses/src/config'
import { gasFetch, fetchStats } from './gas-fetch'

export type { NormalizeResult } from '../node_modules/@geolonia/normalize-japanese-addresses/src/types'

// ビルド時に scripts/build.mjs が埋め込む
declare const __NJA_LIB_VERSION__: string
declare const __NJA_ADDON_VERSION__: string
declare const __NJA_API_ENDPOINT__: string

currentConfig.japaneseAddressesApi = __NJA_API_ENDPOINT__
__internals.fetch = gasFetch

/** 正規化関数。ビルド後は同期関数になり、結果オブジェクトを直接返す */
export const normalize = Normalize.normalize
export const config = Normalize.config
export const libraryVersion = __NJA_LIB_VERSION__
export const addonVersion = __NJA_ADDON_VERSION__
export const stats = fetchStats
