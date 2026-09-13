# normalize-jpn-address

Google スプレッドシート用アドオン。[Geolonia normalize-japanese-addresses](https://github.com/geolonia/normalize-japanese-addresses) をカスタム関数 `NORMALIZE_JPN_ADDRESS()` として使えるようにします。

```
=NORMALIZE_JPN_ADDRESS(A2)
=NORMALIZE_JPN_ADDRESS(A2:A1000)
=NORMALIZE_JPN_ADDRESS("東京都千代田区千代田１−１", 8)      ← ライセンス
=HYPERLINK(NORMALIZE_JPN_ADDRESS_MAP(A2), "地図")           ← ライセンス
=NORMALIZE_JPN_ADDRESS_LATLNG(A2:A1000)                     ← ライセンス
```

- 第1引数: 住所文字列、または 1 列か 1 行の範囲。
- 第2引数（省略可、既定 3）: 許容する最小の正規化レベル（0, 1, 2, 3, 8）。結果がこれに満たない住所はエラー。既定の 3 は町丁目まで（市区町村ごとに 1 回の通信）。8 を指定すると番地・号まで確認する（町丁目ごとに通信が 1 回増える）。
- 戻り値: 正規化した住所の文字列（都道府県 + 市区町村 + 町丁目 + 番地・号 + その他）。
- `_MAP` は位置を開く Google マップの URL、`_LATLNG` は緯度・経度の 2 列を返す。どちらも既定のレベルは 8。
- 旧名 `NORMALZE_JPN_ADDRESS`（綴り違い）は互換のために残している（`Code.ts` で新名を呼ぶだけ）。消さないこと。

メニュー（拡張機能 › 日本の住所正規化関数）からは数式なしで一括処理できます。住所の 1 列を選択して実行すると、右隣の列に**値として**書き込みます（既に値があれば上書き確認）。

| メニュー | 出力（右隣） | 無料 / ライセンス |
|---|---|---|
| 選択範囲を正規化 | 2 列: 正規化した住所、到達レベル（しきい値なし、できるところまで） | 無料は町丁目まで、ライセンスは番地・号まで |
| 選択範囲に地図リンクを付ける | 1 列: 「地図」リンク（番地未満は「地図（概略）」） | ライセンス |

100 行ごとに書き込むので、6 分の上限で止まっても処理済みの行は残ります（`njaMenuRun_`）。

## 無料と有料の境界

| | 無料 | ライセンス版（500 円、買い切り） |
|---|---|---|
| 町丁目までの正規化（レベル 0〜3） | ○ | ○ |
| 番地・号までの正規化（レベル 4〜8） | — | ○ |
| `_MAP` / `_LATLNG` | — | ○ |
| メニュー「選択範囲を正規化」 | ○（町丁目まで） | ○（番地・号まで） |
| メニュー「選択範囲に地図リンクを付ける」 | — | ○ |

無料側は Geolonia のライブラリの機能そのまま、有料側は配信コストの大きい番地・号データと、その座標を使ってこちらで作った機能、という切り分けです。

### ライセンスキーの仕組み

- キーは `NJA-XXXXX-XXXXX-XXXXX-XXXXX`（ID 8 文字 + HMAC-SHA256 の署名 12 文字を base32 で表記）で、**通信せずに検証**します。サーバーもデータベースもありません。
- 秘密鍵はリポジトリ直下の `.license-secret`（git 管理外）に置き、ビルド時にバンドルへ埋め込みます。無いと開発用の固定鍵になり、`npm run push` は拒否します。作り方は `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > .license-secret`。
- 同じ計算が 3 か所にあります: `src/license.ts`（アドオン）、`scripts/license-core.mjs`（Node。テストと `npm run license:issue`）、`worker/license-worker.mjs`（Cloudflare Worker。決済完了ページ）。テストで Node 発行のキーがアドオン側で通ることを確認しています。
- アドオンはキーを UserProperties（購入者のアカウント）と DocumentProperties（登録したファイル）の両方に保存し、カスタム関数からはその順に読みます。カスタム関数からユーザープロパティが読めない環境があれば、ファイル単位で動きます。
- 公開アドオンのスクリプトは利用者に見えませんが、スクリプトを読める人は鍵を取り出してキーを作れます。500 円の商品なので割り切っています。

### 販売の流れ（Stripe + Cloudflare Worker）

1. Stripe で 500 円の商品と Payment Link を作る。「支払い後の遷移先」を `https://license.pizzabun-lab.com/thanks?session_id={CHECKOUT_SESSION_ID}` にする。
2. `worker/` の Worker をデプロイする（`wrangler.toml.example` 参照）。秘密は `NJA_LICENSE_SECRET`（`.license-secret` と同じ値）と `STRIPE_SECRET_KEY`（Checkout Session の読み取りだけできる制限付きキー）。
3. Worker は Stripe API で支払い済みを確認し、セッション ID から決定的にキーを作って表示する。同じ URL を開けば同じキーが出るので、控え忘れは領収書メールのリンクで解決する。
4. `site.config.json` の `purchaseUrl` を Payment Link にして再ビルドする。
5. 手動で発行したいとき（返金後の再発行、テスターなど）は `npm run license:issue`。

特定商取引法に基づく表記（販売者名など）を公開サイトに置く必要があります。個人の場合、住所と電話番号は「請求があれば遅滞なく開示する」旨を書けば省略できます。

利用者向けの説明は [docs/index.html](docs/index.html)（GitHub Pages 用）とサイドバー（`templates/Sidebar.html`）にあります。

## 仕組み

Geolonia を再実装せず、ライブラリのソースをそのまま取り込んで Apps Script 互換の I/O を差し込んでいます。

1. **I/O の注入**: ライブラリは `__internals.fetch`（`src/config.ts`）だけを通して住所データを読みます。Node 版エントリ（`main-node.ts`）がそこを差し替えているのと同じ形で、`src/main-gas.ts` が UrlFetchApp + CacheService 実装（`src/gas-fetch.ts`）を差し込みます。配布済み UMD バンドルは `__internals` を公開していないため、ソースからバンドルし直します。
2. **同期化**: Apps Script のカスタム関数は Promise を返せません。ライブラリ内の非同期処理は「fetch を await する」だけで、`Promise.all` や `.then` は使われていないので、ビルド時に Babel で `async`/`await` を機械的に除去して同期関数にしています（`scripts/deasync-plugin.mjs`）。UrlFetchApp は同期なので意味は変わりません。
3. **キャッシュ**: 取得した住所データはスクリプトキャッシュ（全ユーザー共有、最大 6 時間）に保存します。1 値 100KB の制限があるため、gzip + base64 にして 90,000 文字ごとに分割保存します。
4. **バンドル**: esbuild で `es2019` に落として IIFE（グローバル `NJA`）にします。lru-cache のプライベートフィールドなどはここで変換されます。

Apps Script に push されるのは `dist/` の 4 ファイルです。`dist/` はすべてビルド生成物で、`npm run build` のたびに作り直されます（git 管理外）。

| 出力（`dist/`） | 元 | 内容 |
|---|---|---|
| `appsscript.json` | `src/appsscript.json` | マニフェスト（スコープ、`urlFetchWhitelist`）。そのままコピー |
| `Code.js` | `src/Code.ts` | カスタム関数、メニュー、サイドバー表示。型注釈を剥がしただけ（JSDoc は残る） |
| `normalize-japanese-addresses.js` | `src/main-gas.ts` + ライブラリ | ライブラリ + I/O 層、同期化済み |
| `Sidebar.html` | `templates/Sidebar.html` + `site.config.json` | サイドバー |

`src/Code.ts` は import/export を持たないスクリプトとして書きます。Apps Script はトップレベル関数をそのままカスタム関数やメニューのハンドラとして認識するため、モジュールにするとセルから呼べなくなります（ビルド時に検査します）。グローバル `NJA` の型は `src/main-gas.ts` の `NjaGlobal` で、同期化後の形（`normalize` が Promise ではなく結果を返す）を表しています。

## セットアップ

```sh
npm ci
npm run build      # dist/（push 対象 4 ファイル）, docs/, THIRD_PARTY_NOTICES.md を生成
npm test           # ビルドしてテスト
npm run typecheck  # tsc（src/ の .ts すべて。Code.ts も対象）
npm run check:api  # 住所データ配信サーバーの疎通確認（既定は自前配信。引数で別の取得先）
```

テストは Node の `vm` で「素の V8 コンテキスト」を作り、UrlFetchApp / CacheService / Utilities のモックを与えて `dist/` のファイルをそのまま実行します。`setTimeout` や `fetch` が無い点まで Apps Script と揃えているので、ブラウザ API への依存があればここで落ちます。初回は Geolonia の API に実際にアクセスし、結果を `.cache/http/` に保存します。

## Apps Script へのデプロイ

```sh
npx clasp login
npx clasp create --type sheets --title "日本の住所正規化関数" --rootDir dist   # スプレッドシート付き（コンテナバインド）
mv dist/.clasp.json .clasp.json   # clasp 2.x は --rootDir の中に .clasp.json を書く。dist/ はビルドで消えるので直下へ
# 既存のスクリプトに紐付ける場合は .clasp.json.example をコピーして scriptId を書く
npm run push       # ビルドしてから clasp push
npx clasp open
```

スクリプトエディタで `njaSelfTest` を実行すると、サンプル住所の結果と通信回数がログに出ます。

アドオンとして試すには、スクリプトエディタの「デプロイ > デプロイをテスト」で「エディタ アドオン」を選び、テスト用スプレッドシートにインストールします。「拡張機能」メニューに「使い方とライセンス」が出て、セルで `=NORMALIZE_JPN_ADDRESS(...)` が使えれば成功です。

## Marketplace 公開

1. `site.config.json` の `TODO_` を埋めて `npm run build` し、`docs/` を GitHub Pages で公開する（設定: Pages → Source: `docs/`）。
2. `LICENSE` の著作権者を書く。
3. Google Cloud プロジェクトを作り、Apps Script プロジェクトに紐付ける（設定 → GCP プロジェクト）。
4. OAuth 同意画面を設定する（アプリ名、サポートメール、ホームページ = `docs/index.html` の URL、プライバシーポリシー = `privacy.html`、利用規約 = `terms.html`、スコープは `src/appsscript.json` と同じ 3 つ）。ユーザーの種類は「外部」、公開ステータスは「本番」にする（「テスト」のままだと審査で却下される）。
5. OAuth 検証（ブランド確認）を申請する。`script.external_request` は sensitive スコープ扱いなので、未検証だと利用者に「確認されていないアプリ」の警告が出て利用者数に上限がかかる。用途は「住所データ配信サーバー（`urlFetchWhitelist` の 2 ドメイン）から公開データを取得するため」で足りる。
6. Google Workspace Marketplace SDK を有効にし、アプリ構成で「Sheets アドオン」にデプロイ ID（`clasp deploy` で作成）を設定する。
7. ストア掲載情報を入力して審査に出す。必要な素材: アプリアイコン 32×32 と 128×128、カードバナー 220×140、スクリーンショット 1280×800 を 1 枚以上、サポート URL = `support.html`。アプリ名は 50 文字以内で「Google」を含めない。料金は「有料（アプリ内課金 / 外部決済）」を選び、無料の範囲と価格を説明文に明記する（Marketplace は決済を代行しないので、決済は上の Stripe の流れ）。

## 住所データの配信（Cloudflare R2）

Geolonia は公開 API を「様子を見ながら停止や変更をすることがある」「商用稼働は自前ホストを強く推奨」としているので、アドオンは自前で配信する住所データを既定の取得先にしています。API の実体は静的ファイル（市区町村ごとに JSON 1 つと txt 2 つ、全国で 6,000 ファイル弱、合計数 GB）なので、R2 に置いて独自ドメインを付けるだけで済みます。

| 設定 | 値 |
|---|---|
| 既定の取得先 `nja.apiEndpoint` | `https://normalize-jpn-address.pizzabun-lab.com/api/ja` |
| 切り替え先 `nja.upstreamEndpoint` | `https://japanese-addresses-v2.geoloniamaps.com/api/ja`（Geolonia の公開 API） |
| `urlFetchWhitelist` | 上記 2 ドメイン。ビルド時に両方が含まれることを検査 |

### 初回セットアップ

1. Cloudflare で R2 バケットを作り（例: `normalize-jpn-address`）、「カスタムドメイン」に `normalize-jpn-address.pizzabun-lab.com` を接続する。`r2.dev` の公開 URL はレート制限つきで本番向きでないため使わない。
2. Cache Rule を追加する: ホスト名が上記ドメインのとき「キャッシュ対象」、エッジ TTL 1 日。これで R2 への読み取りはほぼエッジキャッシュに吸収される。
3. R2 API トークン（オブジェクト読み書き）を作り、rclone のリモートを設定する（`type = s3`, `provider = Cloudflare`, `endpoint = https://<account id>.r2.cloudflarestorage.com`）。
4. [japanese-addresses-v2](https://github.com/geolonia/japanese-addresses-v2) を clone して `npm install && npm run run:all` でデータを生成する（デジタル庁のアドレス・ベース・レジストリを取り込む。時間とディスクを使う）。
5. 同期して確認する。

```sh
scripts/r2-sync.sh ../japanese-addresses-v2/api r2:normalize-jpn-address
npm run check:api                                                       # 自前配信を確認
npm run check:api -- https://japanese-addresses-v2.geoloniamaps.com/api/ja  # Geolonia と比較
```

`check:api` はアドオンが実際に出す 3 種類のリクエスト（一覧 JSON、市区町村 JSON、Range 付き txt）を投げ、ステータス・Range 対応（206 が返ること）・Cache-Control を表示します。

### 月次更新

Geolonia は毎月データを更新しています。同じ頻度で 4〜5 を繰り返します。`rclone sync` はチェックサム比較なので、変わったファイルだけ転送されます。

### 取得先の切り替え（再デプロイ不要）

Apps Script の「プロジェクトの設定 → スクリプト プロパティ」で `NJA_API_ENDPOINT` に URL（`…/api/ja` まで）を入れると、次の実行からその取得先を使います。削除すればビルド時の既定に戻ります。自前配信に障害が起きたときに Geolonia の公開 API へ逃がす用途です。`urlFetchWhitelist` に無いドメインは UrlFetchApp が拒否するので、それ以外の URL には切り替えられません。スクリプトエディタで `njaSelfTest` を実行すると、いま使っている取得先がログに出ます。

取得先を恒久的に変えるときは `package.json` の `nja.apiEndpoint`（または `nja.upstreamEndpoint`）と `src/appsscript.json` の `urlFetchWhitelist` の両方を変えてください（ビルド時に整合性を検査します）。

### テストの取得先

テストは既定で Geolonia の公開 API からデータを取ります（自前配信が未稼働でも通るように）。自前配信を試すときは環境変数で指定します。`.cache/http/` は URL ごとなので、初回は再取得になります。

```sh
NJA_TEST_API_ENDPOINT=https://normalize-jpn-address.pizzabun-lab.com/api/ja npm test
```

## サイトとサイドバーの文言

`templates/` が元で、`docs/` と `dist/Sidebar.html` は生成物です。`{{token}}` は `site.config.json` の値と `libVersion` / `addonVersion` / `apiEndpoint` / `apiHost` で置き換えられ、未定義のトークンがあるとビルドが失敗します。

## ライブラリの更新

```sh
npm install --save-exact @geolonia/normalize-japanese-addresses@<version>
npm test
```

`src/main-gas.ts` と `src/gas-fetch.ts` は `node_modules/@geolonia/normalize-japanese-addresses/src/` を直接 import しています。ライブラリ側の `__internals.fetch` の型（`FetchLike`）が変わったら `npm run typecheck` で検出できます。async/await 以外の非同期構文（`Promise.all` など）が追加された場合はテストが落ちるので、そのときは同期化の方法を見直してください。

## 設計上の判断と制限

- **戻り値は住所文字列のみ**。緯度経度やレベルは返しません（結果オブジェクトは `NJA.normalize()` から取れるので、必要なら別関数を足せます）。
- **エラーの扱い**: 単セル入力はスローして `#ERROR!`（`IFERROR` が効く）、範囲入力は行ごとに `#LEVEL …` / `#ERROR …` / `#TIMEOUT …` の文字列（1 行の失敗で全体を止めない）。
- **第2引数はライブラリの正規化深度も兼ねる**: 0〜3 なら町丁目まで（市区町村ごとに 1 回の通信）、それ以上なら番地・号まで（町丁目ごとに Range 取得が 1 回増える）。
- **時間制限**: カスタム関数は 1 回 30 秒。範囲処理は 22 秒を目安に残りの行へ `#TIMEOUT` を入れて部分結果を返します。
- **データの整備状況**: 住居表示地区でも住居表示データが無い町丁目（東京都区部の一部など）はレベル 8 になりません。ライブラリが住居表示側しか見ないためです（`normalize.ts` の TODO 参照）。
- **住所データの提供元**: Geolonia 住所データ v2（CC BY 4.0）から生成したファイルを自前の Cloudflare R2 から配信します（上の「住所データの配信」参照）。Geolonia の公開 API は障害時の切り替え先として `urlFetchWhitelist` に残しています。

## ライセンス

MIT。同梱しているライブラリのライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) を参照してください。住所データは「アドレス・ベース・レジストリ」（デジタル庁）をもとに株式会社 Geolonia が作成したもの（[Geolonia 住所データ v2](https://github.com/geolonia/japanese-addresses-v2)、CC BY 4.0）です。
