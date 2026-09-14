/**
 * ライセンスキーの署名に使う秘密鍵の読み込み。
 * リポジトリ直下の .license-secret（git 管理外）を使う。無ければ開発用の固定値。
 * build（バンドルへの埋め込み）、テスト、キー発行スクリプトが同じ値を見るための共通モジュール。
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const SECRET_PATH = fileURLToPath(new URL('../.license-secret', import.meta.url))
export const DEV_SECRET = 'DEV-SECRET-NOT-FOR-PRODUCTION'

/** @returns {{ secret: string, isDev: boolean }} */
export function readLicenseSecret() {
  if (existsSync(SECRET_PATH)) {
    const secret = readFileSync(SECRET_PATH, 'utf8').trim()
    if (secret.length >= 32) {
      return { secret, isDev: false }
    }
    throw new Error('.license-secret は 32 文字以上にしてください')
  }
  return { secret: DEV_SECRET, isDev: true }
}
