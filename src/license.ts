/**
 * ライセンスキーの検証（Apps Script 側）。
 *
 * キーの形式と計算は scripts/license-core.mjs と同じ（そちらのコメント参照）。
 * 通信せずに検証できるので、カスタム関数の中から呼んでも遅くならない。
 * 秘密鍵はビルド時にバンドルへ埋め込まれる。公開アドオンのスクリプトは利用者から
 * 見えないが、スクリプトを読める人はキーを作れる。500 円の商品なので割り切っている。
 */

const KEY_PREFIX = 'NJA'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ID_LENGTH = 8
const SIG_LENGTH = 12
const MESSAGE_PREFIX = 'nja-license-v1:'

function base32(bytes: number[]): string {
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

function signature(secret: string, id: string): string {
  // Apps Script のバイト配列は符号付き（-128..127）。base32 側で & 0xff している
  const mac = Utilities.computeHmacSha256Signature(MESSAGE_PREFIX + id, secret)
  return base32(mac).slice(0, SIG_LENGTH)
}

/** 空白と区切りを除き大文字にする */
export function normalizeLicenseKey(key: unknown): string {
  return String(key === undefined || key === null ? '' : key)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

export function verifyLicenseKey(secret: string, key: unknown): boolean {
  const body = normalizeLicenseKey(key)
  if (
    body.length !== KEY_PREFIX.length + ID_LENGTH + SIG_LENGTH ||
    body.slice(0, KEY_PREFIX.length) !== KEY_PREFIX
  ) {
    return false
  }
  const id = body.slice(KEY_PREFIX.length, KEY_PREFIX.length + ID_LENGTH)
  const sig = body.slice(KEY_PREFIX.length + ID_LENGTH)
  return sig === signature(secret, id)
}

/** 表示用: 先頭と末尾だけ見せる（NJA-ABCDE-…-…-VWXYZ） */
export function maskLicenseKey(key: unknown): string {
  const body = normalizeLicenseKey(key)
  if (body.length < KEY_PREFIX.length + ID_LENGTH + SIG_LENGTH) {
    return ''
  }
  const rest = body.slice(KEY_PREFIX.length)
  return KEY_PREFIX + '-' + rest.slice(0, 5) + '-•••••-•••••-' + rest.slice(15)
}
