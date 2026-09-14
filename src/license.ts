/**
 * ライセンスキーの検証（Apps Script 側）。
 *
 * キーは購入者の Google アカウント（ID トークンの sub）から導出する:
 *   NJA-XXXXX-XXXXX-XXXXX-XXXXX
 *   = "NJA-" + base32(HMAC-SHA256(secret, "nja-license-v2:" + sub)) の先頭 20 文字（100 bit）
 *
 * 検証は「いま使っている Google アカウントの sub から同じ計算をして一致するか」だけ。
 * サーバーも台帳も期限も無く、通信しない。他人のキーは値が違うので登録できない。
 * 計算は scripts/license-core.mjs（Node）と functions/license/thanks.js（決済完了ページ）と同じ。
 * 秘密鍵はビルド時にバンドルへ埋め込まれる。公開アドオンのスクリプトは利用者から
 * 見えないが、スクリプトを読める人はキーを作れる。500 円の商品なので割り切っている。
 */

const KEY_PREFIX = 'NJA'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const KEY_BODY_LENGTH = 20
const MESSAGE_PREFIX = 'nja-license-v2:'

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

/** Google の sub は数字だけの文字列（最長 255 文字） */
export function isGoogleSub(sub: unknown): sub is string {
  return typeof sub === 'string' && /^[0-9]{1,255}$/.test(sub)
}

/** 空白と区切りを除き大文字にする */
export function normalizeLicenseKey(key: unknown): string {
  return String(key === undefined || key === null ? '' : key)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

/** sub からキー本体（区切り無し）を導出する */
function deriveBody(secret: string, sub: string): string {
  // Apps Script のバイト配列は符号付き（-128..127）。base32 側で & 0xff している
  const mac = Utilities.computeHmacSha256Signature(MESSAGE_PREFIX + sub, secret)
  return KEY_PREFIX + base32(mac).slice(0, KEY_BODY_LENGTH)
}

/** キーが、この sub のアカウント用に発行されたものか */
export function verifyLicenseKey(secret: string, sub: unknown, key: unknown): boolean {
  if (!isGoogleSub(sub)) {
    return false
  }
  const body = normalizeLicenseKey(key)
  if (body.length !== KEY_PREFIX.length + KEY_BODY_LENGTH) {
    return false
  }
  return body === deriveBody(secret, sub)
}

/** 表示用: 先頭と末尾だけ見せる（NJA-ABCDE-…-…-VWXYZ） */
export function maskLicenseKey(key: unknown): string {
  const body = normalizeLicenseKey(key)
  if (body.length < KEY_PREFIX.length + KEY_BODY_LENGTH) {
    return ''
  }
  const rest = body.slice(KEY_PREFIX.length)
  return KEY_PREFIX + '-' + rest.slice(0, 5) + '-•••••-•••••-' + rest.slice(15)
}
