/**
 * Cloudflare Worker: Stripe の決済完了ページでライセンスキーを表示する。
 *
 * 流れ:
 *   1. Stripe の Payment Link（500 円）の「支払い後の遷移先」を
 *      https://<この Worker のドメイン>/thanks?session_id={CHECKOUT_SESSION_ID} にする
 *   2. 支払い後、Stripe が上の URL にリダイレクトする
 *   3. この Worker が Stripe API でセッションを確認し（payment_status が paid か）、
 *      セッション ID から決定的にキーを作って表示する
 *
 * データベースもメール送信も無い。同じ URL を開き直せば同じキーが出るので、
 * 「キーを控え忘れた」問い合わせは Stripe の領収書メールにあるリンクで解決する
 * （Stripe の設定で領収書に「支払い後の遷移先」を含められる）。
 *
 * 秘密鍵はアドオンのビルドに使った .license-secret と同じ値にする:
 *   wrangler secret put NJA_LICENSE_SECRET
 *   wrangler secret put STRIPE_SECRET_KEY      # sk_live_… （読み取りだけなので制限付きキーで可）
 *
 * キーの計算は scripts/license-core.mjs と同じ（Web Crypto で実装）。
 */

const KEY_PREFIX = 'NJA'
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const ID_LENGTH = 8
const SIG_LENGTH = 12
const MESSAGE_PREFIX = 'nja-license-v1:'

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

/** 決済セッション ID から決定的に ID を作る（同じ購入には同じキー） */
async function idFromSession(sessionId) {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode('nja-session:' + sessionId)),
  )
  return base32(digest).slice(0, ID_LENGTH)
}

async function issueLicenseKey(secret, id) {
  const sig = base32(await hmacSha256(secret, MESSAGE_PREFIX + id)).slice(0, SIG_LENGTH)
  const body = id + sig
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
<style>body{font:16px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Hiragino Sans","Noto Sans JP",sans-serif;color:#202124;max-width:640px;margin:40px auto;padding:0 16px}code{font:18px/1.5 ui-monospace,Menlo,Consolas,monospace;background:#f1f3f4;padding:6px 10px;border-radius:6px;user-select:all;display:inline-block}ol{padding-left:20px}</style></head>
<body><h1>${escape(title)}</h1>${body}</body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname !== '/thanks') {
      return new Response('not found', { status: 404 })
    }
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
    const key = await issueLicenseKey(env.NJA_LICENSE_SECRET, await idFromSession(sessionId))
    return page(
      'ご購入ありがとうございます',
      `<p>ライセンスキー:</p><p><code>${escape(key)}</code></p>
<ol>
<li>スプレッドシートの「拡張機能」メニューから「日本の住所正規化関数 › 使い方とライセンス」を開く</li>
<li>「ライセンスキー」欄に上のキーを貼り付けて「登録」を押す</li>
<li><code>=NORMALIZE_JPN_ADDRESS(A2, 8)</code> や <code>=HYPERLINK(NORMALIZE_JPN_ADDRESS_MAP(A2), "地図")</code> が使えるようになります</li>
</ol>
<p>このページはいつでも開き直せます（同じキーが表示されます）。Stripe からの領収書メールも保管してください。</p>`,
    )
  },
}
