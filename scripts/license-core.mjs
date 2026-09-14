/**
 * ライセンスキーの発行と検証（Node 側）。
 *
 * キーはサーバーに問い合わせずに検証できる自己署名方式:
 *   NJA-XXXXX-XXXXX-XXXXX-XXXXX
 *   = "NJA-" + base32(ID 8 文字 + 署名 12 文字) を 5 文字ずつ区切ったもの
 *   署名 = base32(HMAC-SHA256(secret, "nja-license-v1:" + ID)) の先頭 12 文字（60 bit）
 *
 * アドオン側（src/license.ts）は同じ計算を Utilities.computeHmacSha256Signature で行う。
 * 2 つの実装が一致することはテストで確認している。
 * 記号は読み間違えやすい I, O, 0, 1 を除いた 32 文字。
 */
import { createHmac, randomBytes } from 'node:crypto'

export const KEY_PREFIX = 'NJA'
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const ID_LENGTH = 8
export const SIG_LENGTH = 12
export const MESSAGE_PREFIX = 'nja-license-v1:'

/** 標準の base32 ビット詰め（パディング無し）。src/license.ts と同じ */
export function base32(bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = ((value << 8) | (b & 0xff)) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31]
  }
  return out
}

export function signature(secret, id) {
  const mac = createHmac('sha256', secret).update(MESSAGE_PREFIX + id, 'utf8').digest()
  return base32(mac).slice(0, SIG_LENGTH)
}

export function randomId() {
  // 5 バイト = 40 bit = base32 8 文字ちょうど
  return base32(randomBytes(5)).slice(0, ID_LENGTH)
}

export function formatKey(body) {
  return KEY_PREFIX + '-' + body.match(/.{1,5}/g).join('-')
}

/** 空白と区切りを除き大文字にする。表示用の書式のまま貼られても通るように */
export function normalizeKey(key) {
  return String(key || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

/**
 * @param {string} secret
 * @param {string} [id] 省略時はランダム。決済のセッション ID から決定的に作るときは指定する
 */
export function issueLicenseKey(secret, id = randomId()) {
  if (!/^[A-Z2-9]{8}$/.test(id) || /[IO01]/.test(id)) {
    throw new Error(`ID は base32 の 8 文字で指定してください: ${id}`)
  }
  return formatKey(id + signature(secret, id))
}

export function verifyLicenseKey(secret, key) {
  const body = normalizeKey(key)
  if (
    body.length !== KEY_PREFIX.length + ID_LENGTH + SIG_LENGTH ||
    !body.startsWith(KEY_PREFIX)
  ) {
    return false
  }
  const id = body.slice(KEY_PREFIX.length, KEY_PREFIX.length + ID_LENGTH)
  const sig = body.slice(KEY_PREFIX.length + ID_LENGTH)
  return sig === signature(secret, id)
}
