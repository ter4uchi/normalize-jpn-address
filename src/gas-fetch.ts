/**
 * Apps Script 互換の I/O 層。
 *
 * ライブラリ本体は `__internals.fetch`（config.ts）だけを通して外部データを読む。
 * ここでは `fetch` の代わりに UrlFetchApp を使い、取得したデータを
 * CacheService（スクリプトキャッシュ）に最大 6 時間保存する。
 *
 * 重要: このファイルは `async` / `await` で書くこと。ビルド時に async/await は
 * 機械的に取り除かれ、同期関数になる（scripts/deasync-plugin.mjs）。
 * UrlFetchApp は同期なので、取り除いても意味は変わらない。
 * `Promise.resolve()` や `.then()` は使ってはいけない（同期化できなくなる）。
 */
import type {
  FetchLike,
  FetchOptions,
} from '../node_modules/@geolonia/normalize-japanese-addresses/src/config'
import { currentConfig } from '../node_modules/@geolonia/normalize-japanese-addresses/src/config'

/** CacheService の上限（6 時間） */
const CACHE_TTL_SECONDS = 21600
/** キャッシュ形式を変えるときはここを上げる */
const CACHE_KEY_PREFIX = 'nja1:'
/** CacheService は 1 値あたり 100KB まで。余裕を持って分割する */
const CACHE_CHUNK_CHARS = 90000
/** これより長い本文は gzip + base64 で保存する（日本語 JSON は 1 文字 3 バイトになるため） */
const RAW_MAX_CHARS = 20000

export type FetchStats = { network: number; cacheHits: number }

/** テストとデバッグ用の統計 */
export const fetchStats: FetchStats = { network: 0, cacheHits: 0 }

type ByteRange = { offset: number; length: number }

/**
 * ライブラリに差し込む fetch 実装。
 * `input` は `.json` や `/東京都/千代田区.json?v=...` のようなパス部分。
 */
export const gasFetch: FetchLike = async (
  input: string,
  options?: FetchOptions,
) => {
  const o = options || {}
  const range: ByteRange | undefined =
    typeof o.offset === 'number' && typeof o.length === 'number'
      ? { offset: o.offset, length: o.length }
      : undefined
  const url = `${currentConfig.japaneseAddressesApi}${input}`
  const key = cacheKey(url, range)

  let body = cacheGet(key)
  if (body === null) {
    body = httpGet(url, range)
    fetchStats.network += 1
    cachePut(key, body)
  } else {
    fetchStats.cacheHits += 1
  }

  const text = body
  return {
    ok: true,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function httpGet(url: string, range?: ByteRange): string {
  const headers: Record<string, string> = {}
  if (range) {
    headers['Range'] = `bytes=${range.offset}-${range.offset + range.length - 1}`
  }

  let response: GoogleAppsScript.URL_Fetch.HTTPResponse
  try {
    response = UrlFetchApp.fetch(url, {
      method: 'get',
      headers,
      muteHttpExceptions: true,
      followRedirects: true,
    })
  } catch (e) {
    throw new Error(
      `住所データの取得に失敗しました: ${describeError(e)} (${url})`,
    )
  }

  const code = response.getResponseCode()
  if (range && code === 200) {
    // サーバーが Range を無視して全体を返した場合は、こちらでバイト範囲を切り出す
    const bytes = response.getContent()
    const slice = bytes.slice(range.offset, range.offset + range.length)
    return Utilities.newBlob(slice).getDataAsString('UTF-8')
  }
  if (code < 200 || code >= 300) {
    throw new Error(`住所データの取得に失敗しました (HTTP ${code}): ${url}`)
  }
  return response.getContentText('UTF-8')
}

// ---------------------------------------------------------------------------
// CacheService
// ---------------------------------------------------------------------------

function getCache(): GoogleAppsScript.Cache.Cache | null {
  try {
    return CacheService.getScriptCache()
  } catch (e) {
    return null
  }
}

function md5hex(s: string): string {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5,
    s,
    Utilities.Charset.UTF_8,
  )
  let out = ''
  for (const b of bytes) {
    // Apps Script のバイト配列は符号付き
    out += ((b + 256) % 256).toString(16).padStart(2, '0')
  }
  return out
}

function cacheKey(url: string, range?: ByteRange): string {
  const raw = range ? `${url}#${range.offset}+${range.length}` : url
  // URL には日本語が含まれ 250 文字制限を超え得るのでハッシュにする
  return CACHE_KEY_PREFIX + md5hex(raw)
}

/** 'R' + 生テキスト、または 'G' + base64(gzip(テキスト)) */
function encodeForCache(body: string): string {
  if (body.length <= RAW_MAX_CHARS) {
    return 'R' + body
  }
  const gz = Utilities.gzip(Utilities.newBlob(body, 'text/plain', 'cache.txt'))
  return 'G' + Utilities.base64Encode(gz.getBytes())
}

function decodeFromCache(value: string): string | null {
  const tag = value.charAt(0)
  const payload = value.substring(1)
  if (tag === 'R') {
    return payload
  }
  if (tag === 'G') {
    const blob = Utilities.newBlob(
      Utilities.base64Decode(payload),
      'application/x-gzip',
      'cache.gz',
    )
    return Utilities.ungzip(blob).getDataAsString('UTF-8')
  }
  return null
}

function chunkKey(key: string, index: number): string {
  return `${key}.${index}`
}

function cacheGet(key: string): string | null {
  const cache = getCache()
  if (!cache) {
    return null
  }
  try {
    const head = cache.get(key)
    if (head === null) {
      return null
    }
    if (head.charAt(0) !== 'M') {
      return decodeFromCache(head)
    }
    // 分割保存: 'M<チャンク数>'
    const count = parseInt(head.substring(1), 10)
    if (!(count > 0)) {
      return null
    }
    const keys: string[] = []
    for (let i = 0; i < count; i++) {
      keys.push(chunkKey(key, i))
    }
    const parts = cache.getAll(keys)
    let joined = ''
    for (const k of keys) {
      const part = parts[k]
      if (typeof part !== 'string') {
        return null // 一部が期限切れ
      }
      joined += part
    }
    return decodeFromCache(joined)
  } catch (e) {
    return null
  }
}

function cachePut(key: string, body: string): void {
  const cache = getCache()
  if (!cache) {
    return
  }
  try {
    const encoded = encodeForCache(body)
    if (encoded.length <= CACHE_CHUNK_CHARS) {
      cache.put(key, encoded, CACHE_TTL_SECONDS)
      return
    }
    const values: Record<string, string> = {}
    let count = 0
    for (let i = 0; i < encoded.length; i += CACHE_CHUNK_CHARS) {
      values[chunkKey(key, count)] = encoded.substring(i, i + CACHE_CHUNK_CHARS)
      count += 1
    }
    // 本体を先に入れてからヘッダを書く（ヘッダだけ残る状態を避ける）
    cache.putAll(values, CACHE_TTL_SECONDS)
    cache.put(key, `M${count}`, CACHE_TTL_SECONDS)
  } catch (e) {
    // キャッシュはベストエフォート。失敗しても正規化は続行する
  }
}
