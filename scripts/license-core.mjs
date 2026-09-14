/**
 * ライセンスキーの発行と検証（Node 側）。
 *
 * キーは購入者の Google アカウント（ID トークンの sub）から導出する:
 *   NJA-XXXXX-XXXXX-XXXXX-XXXXX
 *   = "NJA-" + base32(HMAC-SHA256(secret, "nja-license-v2:" + sub)) の先頭 20 文字（100 bit）
 *     を 5 文字ずつ区切ったもの
 *
 * 台帳も期限も無い。検証は「その sub で同じ計算をして一致するか」だけなので、
 * キーを知っていても、その Google アカウントでなければ登録できない。
 * アドオン側（src/license.ts）は同じ計算を Utilities.computeHmacSha256Signature で、
 * 決済完了ページ（functions/license/thanks.js）は Web Crypto で行う。一致はテストで確認している。
 * 記号は読み間違えやすい I, O, 0, 1 を除いた 32 文字。
 */
import { createHmac } from 'node:crypto'

export const KEY_PREFIX = 'NJA'
export const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const KEY_BODY_LENGTH = 20
export const MESSAGE_PREFIX = 'nja-license-v2:'

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

/** Google の sub は数字だけの文字列（最長 255 文字） */
export function isGoogleSub(sub) {
  return typeof sub === 'string' && /^[0-9]{1,255}$/.test(sub)
}

/** "NJA" + 本体 20 文字 → NJA-XXXXX-XXXXX-XXXXX-XXXXX */
export function formatKey(body) {
  return KEY_PREFIX + '-' + body.slice(KEY_PREFIX.length).match(/.{1,5}/g).join('-')
}

/** 空白と区切りを除き大文字にする。表示用の書式のまま貼られても通るように */
export function normalizeKey(key) {
  return String(key || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

/**
 * @param {string} secret
 * @param {string} sub 購入者の Google アカウントの sub
 */
export function issueLicenseKey(secret, sub) {
  if (!isGoogleSub(sub)) {
    throw new Error(`sub は数字だけの文字列で指定してください: ${sub}`)
  }
  const mac = createHmac('sha256', secret).update(MESSAGE_PREFIX + sub, 'utf8').digest()
  return formatKey(KEY_PREFIX + base32(mac).slice(0, KEY_BODY_LENGTH))
}

/** キーが、この sub のアカウント用に発行されたものか */
export function verifyLicenseKey(secret, sub, key) {
  if (!isGoogleSub(sub)) {
    return false
  }
  const body = normalizeKey(key)
  if (body.length !== KEY_PREFIX.length + KEY_BODY_LENGTH) {
    return false
  }
  return body === normalizeKey(issueLicenseKey(secret, sub))
}
