/**
 * Apps Script サービスの最小モック。
 * 実装が依存している API だけを、実物の癖（符号付きバイト配列、100KB 制限など）込みで再現する。
 */
import zlib from 'node:zlib'
import { createHash, createHmac } from 'node:crypto'
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
    computeHmacSha256Signature(value, key) {
      return toSignedBytes(createHmac('sha256', key).update(value, 'utf8').digest())
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

/**
 * PropertiesService。script / user / document の 3 ストアは別物（それぞれ文字列の Map）。
 */
export function createPropertiesService({
  script = new Map(),
  user = new Map(),
  document = new Map(),
} = {}) {
  const wrap = (store) => {
    const props = {
      getProperty: (key) => (store.has(key) ? store.get(key) : null),
      setProperty(key, value) {
        store.set(key, String(value))
        return props
      },
      deleteProperty(key) {
        store.delete(key)
        return props
      },
      getProperties: () => Object.fromEntries(store),
    }
    return props
  }
  const scriptProps = wrap(script)
  const userProps = wrap(user)
  const documentProps = wrap(document)
  return {
    getScriptProperties: () => scriptProps,
    getUserProperties: () => userProps,
    getDocumentProperties: () => documentProps,
  }
}

/**
 * SpreadsheetApp。1 枚のシートをメモリ上に持つ最小実装。
 * @param {{
 *   values?: any[][],                 // シートの初期値（A1 から）
 *   selection?: { row: number, column: number, rows: number, columns: number } | null,  // 1 始まり
 *   alertResponse?: 'OK' | 'CANCEL' | 'YES' | 'NO',
 * }} options
 * 返り値の `_sheet` で中身（values / richText / alerts / menuItems）を検査できる。
 */
export function createSpreadsheetApp({
  values = [],
  selection = null,
  alertResponse = 'OK',
} = {}) {
  const cells = new Map() // "row,col" -> value
  const rich = new Map() // "row,col" -> { text, url }
  values.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v !== '' && v !== null && v !== undefined) cells.set(`${r + 1},${c + 1}`, v)
    }),
  )
  const alerts = []
  const menuItems = []
  const state = { cells, rich, alerts, menuItems, selection }

  const makeRange = (row, column, rows, columns) => ({
    getRow: () => row,
    getColumn: () => column,
    getNumRows: () => rows,
    getNumColumns: () => columns,
    getSheet: () => sheet,
    getA1Notation: () => `R${row}C${column}:R${row + rows - 1}C${column + columns - 1}`,
    getValues() {
      const out = []
      for (let r = 0; r < rows; r++) {
        const line = []
        for (let c = 0; c < columns; c++) {
          const key = `${row + r},${column + c}`
          line.push(cells.has(key) ? cells.get(key) : '')
        }
        out.push(line)
      }
      return out
    },
    setValues(vals) {
      if (vals.length !== rows || vals.some((l) => l.length !== columns)) {
        throw new Error(`setValues: 形が違います (${vals.length}x${vals[0] && vals[0].length} vs ${rows}x${columns})`)
      }
      vals.forEach((line, r) =>
        line.forEach((v, c) => {
          const key = `${row + r},${column + c}`
          cells.set(key, v)
          rich.delete(key)
        }),
      )
      return this
    },
    setRichTextValues(vals) {
      if (vals.length !== rows || vals.some((l) => l.length !== columns)) {
        throw new Error('setRichTextValues: 形が違います')
      }
      vals.forEach((line, r) =>
        line.forEach((v, c) => {
          const key = `${row + r},${column + c}`
          cells.set(key, v.getText())
          rich.set(key, { text: v.getText(), url: v.getLinkUrl() })
        }),
      )
      return this
    },
  })
  const sheet = {
    getRange: (row, column, rows = 1, columns = 1) => makeRange(row, column, rows, columns),
    getName: () => 'Sheet1',
  }
  const menu = {
    addItem(caption, fn) {
      menuItems.push({ caption, fn })
      return menu
    },
    addSeparator() {
      return menu
    },
    addToUi() {},
  }
  const Button = { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO', CLOSE: 'CLOSE' }
  const ui = {
    Button,
    ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO' },
    createAddonMenu: () => menu,
    createMenu: () => menu,
    showSidebar() {},
    alert(...args) {
      alerts.push(args.map(String).join(' | '))
      return alertResponse
    },
  }
  const richTextBuilder = () => {
    let text = ''
    let url = null
    const b = {
      setText(t) {
        text = String(t)
        return b
      },
      setLinkUrl(u) {
        url = u === null || u === undefined ? null : String(u)
        return b
      },
      build: () => ({ getText: () => text, getLinkUrl: () => url }),
    }
    return b
  }
  return {
    _sheet: state,
    getUi: () => ui,
    getActiveRange: () =>
      selection ? makeRange(selection.row, selection.column, selection.rows, selection.columns) : null,
    getActiveSpreadsheet: () => ({ getActiveSheet: () => sheet, getActiveRange: () => sheet && null }),
    getActiveSheet: () => sheet,
    newRichTextValue: richTextBuilder,
    flush() {},
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
