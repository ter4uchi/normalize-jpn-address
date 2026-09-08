/**
 * Apps Script サービスの最小モック。
 * 実装が依存している API だけを、実物の癖（符号付きバイト配列、100KB 制限など）込みで再現する。
 */
import zlib from 'node:zlib'
import { createHash } from 'node:crypto'
import { syncHttpGet } from './sync-http.mjs'

/** Apps Script の Byte[] は -128..127 の符号付き整数 */
export function toSignedBytes(buf) {
  return Array.from(buf, (b) => (b > 127 ? b - 256 : b))
}

export function toBuffer(bytes) {
  return Buffer.from(bytes.map((b) => b & 0xff))
}

class BlobMock {
  constructor(buf, contentType, name) {
    this._buf = buf
    this._contentType = contentType || 'application/octet-stream'
    this._name = name || null
  }
  getBytes() {
    return toSignedBytes(this._buf)
  }
  getDataAsString(charset) {
    return this._buf.toString('utf8')
  }
  getContentType() {
    return this._contentType
  }
  getName() {
    return this._name
  }
}

export function createUtilities() {
  return {
    DigestAlgorithm: { MD5: 'MD5', SHA_1: 'SHA_1', SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8', US_ASCII: 'US_ASCII' },
    newBlob(data, contentType, name) {
      const buf =
        typeof data === 'string' ? Buffer.from(data, 'utf8') : toBuffer(data)
      return new BlobMock(buf, contentType, name)
    },
    gzip(blob) {
      return new BlobMock(zlib.gzipSync(blob._buf), 'application/x-gzip')
    },
    ungzip(blob) {
      return new BlobMock(zlib.gunzipSync(blob._buf), 'application/octet-stream')
    },
    base64Encode(data) {
      const buf =
        typeof data === 'string' ? Buffer.from(data, 'utf8') : toBuffer(data)
      return buf.toString('base64')
    },
    base64Decode(text) {
      return toSignedBytes(Buffer.from(text, 'base64'))
    },
    computeDigest(algorithm, value, charset) {
      const name = String(algorithm).replace('_', '').toLowerCase()
      return toSignedBytes(createHash(name).update(value, 'utf8').digest())
    },
    sleep() {},
  }
}

const CACHE_MAX_KEY_LENGTH = 250
const CACHE_MAX_VALUE_BYTES = 100 * 1024

/**
 * CacheService。store を渡すと複数の「実行」（vm コンテキスト）間で共有できる。
 */
export function createCacheService(store = new Map()) {
  const check = (key, value) => {
    if (typeof key !== 'string' || key.length > CACHE_MAX_KEY_LENGTH) {
      throw new Error(`Cache key too long: ${String(key).length}`)
    }
    if (typeof value !== 'string') {
      throw new Error('Cache value must be a string')
    }
    if (Buffer.byteLength(value, 'utf8') > CACHE_MAX_VALUE_BYTES) {
      throw new Error(`Cache value too large: ${Buffer.byteLength(value, 'utf8')} bytes`)
    }
  }
  const cache = {
    get: (key) => (store.has(key) ? store.get(key) : null),
    put: (key, value, ttl) => {
      check(key, value)
      store.set(key, value)
    },
    getAll: (keys) => {
      const out = {}
      for (const k of keys) if (store.has(k)) out[k] = store.get(k)
      return out
    },
    putAll: (values, ttl) => {
      for (const [k, v] of Object.entries(values)) {
        check(k, v)
        store.set(k, v)
      }
    },
    remove: (key) => {
      store.delete(key)
    },
    removeAll: (keys) => {
      for (const k of keys) store.delete(k)
    },
  }
  return {
    getScriptCache: () => cache,
    getDocumentCache: () => cache,
    getUserCache: () => cache,
    _store: store,
  }
}

/** 既定のハンドラ: 実際に HTTP GET する（ディスクキャッシュ付き） */
export function liveHandler(url, headers) {
  return syncHttpGet(url, headers)
}

/**
 * UrlFetchApp。
 * @param {{ log?: any[], handler?: (url: string, headers: Record<string,string>) => {status:number, headers?:object, body:Buffer} }} options
 */
export function createUrlFetchApp({ log = [], handler = liveHandler } = {}) {
  return {
    _log: log,
    fetch(url, params = {}) {
      const headers = params.headers || {}
      log.push({ url, headers, params })
      const res = handler(url, headers)
      const buf = res.body
      if (
        !params.muteHttpExceptions &&
        (res.status < 200 || res.status >= 300)
      ) {
        throw new Error(`Request failed for ${url} returned code ${res.status}`)
      }
      return {
        getResponseCode: () => res.status,
        getContentText: () => buf.toString('utf8'),
        getContent: () => toSignedBytes(buf),
        getHeaders: () => res.headers || {},
        getAllHeaders: () => res.headers || {},
      }
    },
    fetchAll(requests) {
      return requests.map((r) => this.fetch(r.url, r))
    },
  }
}

export function createSpreadsheetApp() {
  const menu = {
    addItem() {
      return menu
    },
    addSeparator() {
      return menu
    },
    addToUi() {},
  }
  return {
    getUi: () => ({
      createAddonMenu: () => menu,
      createMenu: () => menu,
      showSidebar() {},
    }),
  }
}

export function createHtmlService() {
  return {
    createHtmlOutputFromFile: () => {
      const out = {
        setTitle: () => out,
        setWidth: () => out,
      }
      return out
    },
  }
}
