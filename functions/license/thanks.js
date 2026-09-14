/**
 * Cloudflare Pages Function: Stripe の決済完了ページでライセンスキーを表示する。
 * サイト（docs/）と同じ Pages プロジェクトで配信され、パスはこのファイルの位置から
 * https://normalize-jpn-address.pizzabunlab.com/license/thanks になる。
 *
 * 流れ:
 *   1. アドオンのサイドバーが、利用者の Google アカウントの sub を client_reference_id に付けて
 *      Stripe の Payment Link（500 円）を開く
 *   2. Stripe の Payment Link の「支払い後の遷移先」は
 *      https://normalize-jpn-address.pizzabunlab.com/license/thanks?session_id={CHECKOUT_SESSION_ID}
 *   3. この関数が Stripe API でセッションを確認し（payment_status が paid か）、
 *      client_reference_id の sub からキーを導出して表示する
 *
 * キーは sub から決定的に作られるので、データベースもメール送信も無い。同じ URL を開き直せば
 * 同じキーが出るので、「キーを控え忘れた」問い合わせは Stripe の領収書メールにあるリンクで解決する
 * （Stripe の設定で領収書に「支払い後の遷移先」を含められる）。
 * アドオンは登録時に「いまの Google アカウントの sub で同じ計算をして一致するか」を見るので、
 * 他人にキーを渡しても登録できない。
 *
 * 秘密（Pages プロジェクトの環境変数。暗号化して保存する）:
 *   npx wrangler pages secret put NJA_LICENSE_SECRET   # アドオンのビルドに使った .license-secret と同じ値
 *   npx wrangler pages secret put STRIPE_SECRET_KEY    # rk_live_… （Checkout Session の読み取りだけの制限付きキー）
 *
 * キーの計算は scripts/license-core.mjs と同じ（Web Crypto で実装）。一致は test/license-page.test.mjs で確認する。
 */

const KEY_PREFIX = 'NJA'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const KEY_BODY_LENGTH = 20
const MESSAGE_PREFIX = 'nja-license-v2:'

function base32(bytes) {
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

async function hmacSha256(secret, message) {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
}

/** Google の sub は数字だけの文字列（最長 255 文字） */
const isGoogleSub = (sub) => typeof sub === 'string' && /^[0-9]{1,255}$/.test(sub)

/** sub からキーを導出する（scripts/license-core.mjs の issueLicenseKey と同じ） */
export async function issueLicenseKey(secret, sub) {
  const mac = await hmacSha256(secret, MESSAGE_PREFIX + sub)
  const body = base32(mac).slice(0, KEY_BODY_LENGTH)
  return KEY_PREFIX + '-' + body.match(/.{1,5}/g).join('-')
}

async function fetchCheckoutSession(stripeSecretKey, sessionId) {
  const res = await fetch(
    'https://api.stripe.com/v1/checkout/sessions/' + encodeURIComponent(sessionId),
    { headers: { Authorization: 'Bearer ' + stripeSecretKey } },
  )
  if (!res.ok) {
    return null
  }
  return res.json()
}

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

function page(title, body) {
  return new Response(
    `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>body{font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Hiragino Sans","Noto Sans JP",sans-serif;color:#202124;max-width:640px;margin:40px auto;padding:0 16px}code{font:18px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#f1f3f4;padding:6px 10px;border-radius:6px;user-select:all;display:inline-block}ol{padding-left:20px}a{color:#1a73e8}</style></head>
<body><h1>${escape(title)}</h1>${body}<p><a href="/">サイトへ戻る</a></p></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('session_id') || ''
  if (!/^cs_(live|test)_[A-Za-z0-9]+$/.test(sessionId)) {
    return page('ご購入の確認ができません', '<p>URL が正しくありません。Stripe の領収書メールにあるリンクから開き直してください。</p>')
  }
  if (!env.NJA_LICENSE_SECRET || !env.STRIPE_SECRET_KEY) {
    return page('設定エラー', '<p>サーバー側の設定が不足しています。</p>')
  }
  const session = await fetchCheckoutSession(env.STRIPE_SECRET_KEY, sessionId)
  if (!session || session.payment_status !== 'paid') {
    return page(
      'お支払いが確認できません',
      '<p>決済がまだ完了していないか、確認に失敗しました。しばらくしてからこのページを開き直してください。</p>',
    )
  }
  const sub = session.client_reference_id
  if (!isGoogleSub(sub)) {
    // サイドバー経由でなく Payment Link を直接開いて決済した場合。sub が無いのでキーを作れない
    return page(
      'ライセンスキーを発行できません',
      `<p>この決済には Google アカウントの情報が含まれていません。ライセンスキーは、スプレッドシートの「拡張機能 › 日本の住所正規化関数 › 使い方とライセンス」にある購入ボタンから購入した場合に発行できます。</p>
<p>お手数ですが、この画面の内容（決済 ID: <code>${escape(sessionId)}</code>）を添えて<a href="/support.html">お問い合わせ</a>ください。返金または手動での発行で対応します。</p>`,
    )
  }
  const key = await issueLicenseKey(env.NJA_LICENSE_SECRET, sub)
  return page(
    'ご購入ありがとうございます',
    `<p>ライセンスキー:</p><p><code>${escape(key)}</code></p>
<ol>
<li>購入したときと同じ Google アカウントでスプレッドシートを開き、「拡張機能」メニューから「日本の住所正規化関数 › 使い方とライセンス」を開く</li>
<li>「ライセンスキー」欄に上のキーを貼り付けて「登録」を押す</li>
<li>メニューの「選択範囲を正規化」が番地・号まで正規化するようになり、「選択範囲に地図リンクを付ける」「選択範囲に緯度経度を付ける」が使えるようになります</li>
</ol>
<p>このキーは購入した Google アカウント専用です。このページはいつでも開き直せます（同じキーが表示されます）。Stripe からの領収書メールも保管してください。</p>`,
  )
}
