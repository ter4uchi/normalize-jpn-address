# TASKS

公開までの進捗と残タスク。2026-09-14 時点。設計の詳細は README、コードの約束事は CLAUDE.md。

## 現在地

- コードは公開できる形まで書けている（ライセンス方式の作り直しを含む。テスト 38 本通過）。**今日の変更は未コミット**
- サイトは https://normalize-jpn-address.pizzabunlab.com/ で公開済み（Cloudflare Pages、カスタムドメイン接続済み、決済完了ページも配信中）
- 住所データの配信（R2）、Stripe、Apps Script へのデプロイ、Google Cloud / OAuth、Marketplace は未着手

## 決めたこと（2026-09-14）

| 項目 | 決定 |
|---|---|
| 無料 / 有料 | カスタム関数 `NORMALIZE_JPN_ADDRESS` は町丁目まで（レベル 0〜3）で無料。有料はメニューだけ: 番地・号までの一括正規化、地図リンク、緯度経度。`_MAP` / `_LATLNG` のカスタム関数は廃止 |
| ライセンス | キー = HMAC(secret, Google アカウントの sub)。登録時にアドオンが自分の sub で同じ計算をして照合するだけ。台帳・期限・Webhook 無し。返金後の無効化はしない。DocumentProperties は使わない（UserProperties のみ） |
| 購入導線 | サイドバーの購入リンク（`?client_reference_id=<sub>` 付きの Payment Link）からのみ。決済完了ページ `/license/thanks` が sub からキーを表示 |
| ホスト名 | サイト + 決済完了ページ: `normalize-jpn-address.pizzabunlab.com`（Pages）。住所データ: `normalize-jpn-address-data.pizzabunlab.com`（R2）。汎用サブドメイン（`license.` など）は切らない |
| OAuth スコープ | `openid` を追加（`ScriptApp.getIdentityToken()` 用。メールは読まない） |

## 完了

### リポジトリ

- [x] ドメインの綴り修正（`pizzabun-lab.com` → `pizzabunlab.com`）
- [x] ライセンスを sub 導出方式に作り直し（`src/license.ts`、`scripts/license-core.mjs`、`functions/license/thanks.js` の 3 実装、テストで一致を確認）
- [x] カスタム関数からライセンス判定を撤去、レベル 4 以上はメニューへの案内エラー
- [x] メニュー「選択範囲に緯度経度を付ける」を追加（3 モードを `NJA_MENU_MODES` に集約）
- [x] サイドバー: 購入リンクに sub を付与、ユーザー ID 表示、キー登録はアカウント照合つき
- [x] `appsscript.json` に `openid`、`urlFetchWhitelist` をデータ用ホストに変更
- [x] Worker（`worker/`）を廃止し、Pages Functions（`functions/license/thanks.js`）へ移行。`wrangler.toml`、`npm run deploy:site`、`wrangler` を devDependency に追加
- [x] サイト 4 ページ・サイドバー・README・CLAUDE.md を新方式に更新（プライバシーポリシーに `openid` と sub の扱いを明記）

### インフラ

- [x] wrangler ログイン（OAuth）
- [x] Pages プロジェクト `normalize-jpn-address` 作成、初回デプロイ
- [x] カスタムドメイン `normalize-jpn-address.pizzabunlab.com` 接続（DNS・証明書・全ページ・Functions の応答を確認済み）

## 残タスク

順番はおおむね依存関係順。「手作業」はダッシュボードやブラウザでの操作。

### 1. リポジトリの仕上げ

- [ ] 今日の変更をコミットする
- [ ] `site.config.json` の `TODO_PUBLISHER_NAME`（運営者名。OAuth 同意画面のアプリ名・特商法表記と揃える）、`TODO_OWNER`（`repoUrl` / `contactUrl`）を埋める → `npm run deploy:site`
- [ ] `LICENSE` の著作権者（`TODO_PUBLISHER_NAME`）を書く
- [ ] `.license-secret` を作る（`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > .license-secret`）。git 管理外。**紛失するとキーを再発行できない**のでバックアップする
- [ ] 特定商取引法に基づく表記をサイトに置く（`templates/site/` に新ページ、または `terms.html` に節を追加。個人なら住所・電話番号は「請求があれば遅滞なく開示」で省略可）

### 2. Stripe

- [ ] 500 円の商品と Payment Link を作る
- [ ] Payment Link の「支払い後の遷移先」を `https://normalize-jpn-address.pizzabunlab.com/license/thanks?session_id={CHECKOUT_SESSION_ID}` にする。領収書メールにこの遷移先を含める設定にする（キーの再表示用）
- [ ] 制限付き API キー（Checkout Sessions: 読み取りのみ）を作る
- [ ] Pages の秘密を入れる: `npx wrangler pages secret put NJA_LICENSE_SECRET`（`.license-secret` と同じ値）、`npx wrangler pages secret put STRIPE_SECRET_KEY`
- [ ] `site.config.json` の `purchaseUrl` を Payment Link にして `npm run deploy:site`
- [ ] テストモードで一連の流れを通す: サイドバーの購入リンク → 決済 → 完了ページにキーが出る → サイドバーで登録できる → 別アカウントでは登録できない

### 3. 住所データの配信（R2）

- [ ] R2 バケット `normalize-jpn-address` を作る（手作業。無料枠内でも支払い方法の登録が求められる）
- [ ] バケットのカスタムドメインに `normalize-jpn-address-data.pizzabunlab.com` を接続（手作業）
- [ ] Cache Rule: ホスト名が上記のとき「キャッシュ対象」、エッジ TTL 1 日（手作業。`.json` / `.txt` は既定でキャッシュされないため必須）
- [ ] R2 API トークン（Object Read & Write、このバケットのみ）を作り、rclone を入れて `~/.config/rclone/rclone.conf` に `[r2]` を書く（README「住所データの配信」）
- [ ] `japanese-addresses-v2` を clone して `npm install && npm run run:all`（時間がかかる。他と並行で回す）
- [ ] `scripts/r2-sync.sh ../japanese-addresses-v2/api r2:normalize-jpn-address` → `npm run check:api` で 200/206 と Cache-Control を確認
- [ ] `NJA_TEST_API_ENDPOINT=https://normalize-jpn-address-data.pizzabunlab.com/api/ja npm test` で自前配信を使ったテストを通す
- [ ] 月次更新の手順を決める（Geolonia のデータ更新に合わせて生成 → sync）

### 4. Apps Script

- [ ] `npx clasp login` → `npx clasp create --type sheets --title "日本の住所正規化関数" --rootDir dist` → `.clasp.json` を直下へ（README「Apps Script へのデプロイ」）
- [ ] `npm run push`（`.license-secret` が無いと拒否される）
- [ ] スクリプトエディタで `njaSelfTest` を実行し、取得先・ライセンス状態・通信回数を確認
- [ ] 「デプロイ > デプロイをテスト」でエディタ アドオンとしてインストールし、実機で確認:
  - [ ] 初回に `openid` を含む認可が出ること。サイドバーの「ユーザー ID」に数字が出ること（= `getIdentityToken()` が動いている）
  - [ ] `npm run license:issue -- --sub <そのユーザー ID>` で作ったキーが登録できること。別アカウントのキーは弾かれること
  - [ ] メニュー 3 種（正規化 / 地図リンク / 緯度経度）。未ライセンスで地図・緯度経度が購入案内になること
  - [ ] `=NORMALIZE_JPN_ADDRESS(A2, 8)` がメニューへの案内エラーになること

### 5. Google Cloud / OAuth

- [ ] Google Cloud プロジェクトを作り、Apps Script プロジェクトに紐付ける（設定 → GCP プロジェクト）
- [ ] Search Console で `pizzabunlab.com` を「ドメイン」プロパティとして所有確認（DNS TXT を Cloudflare に追加）。同意画面を作る Google アカウントで行う
- [ ] OAuth 同意画面: ユーザーの種類「外部」、公開ステータス「本番」。値は次の表
- [ ] OAuth 検証（ブランド確認）を申請。`script.external_request` は sensitive（用途: 住所データ配信サーバーの 2 ドメインから公開データを取得）。`openid` は non-sensitive（用途: ライセンスキーが利用者のアカウント用かの照合。識別子のみ）

| 項目 | 値 |
|---|---|
| 承認済みドメイン | `pizzabunlab.com` |
| ホームページ | `https://normalize-jpn-address.pizzabunlab.com/` |
| プライバシーポリシー | `https://normalize-jpn-address.pizzabunlab.com/privacy` |
| 利用規約 | `https://normalize-jpn-address.pizzabunlab.com/terms` |
| スコープ | `openid`、`script.external_request`、`script.container.ui`、`spreadsheets.currentonly`（`src/appsscript.json` と同じ） |

`.html` 付きの URL は Pages が拡張子無しへ 308 リダイレクトするので、Google や Stripe に登録するのは拡張子無しの形にする。

### 6. Marketplace

- [ ] Google Workspace Marketplace SDK を有効化し、「Sheets アドオン」に `clasp deploy` のデプロイ ID を設定
- [ ] 素材: アイコン 32×32 / 128×128、カードバナー 220×140、スクリーンショット 1280×800 以上を 1 枚以上
- [ ] 掲載情報: アプリ名（50 文字以内、「Google」を含めない）、説明文に無料の範囲と価格を明記、料金は「有料（外部決済）」、サポート URL = `https://normalize-jpn-address.pizzabunlab.com/support`
- [ ] 審査に出す

## 注意・未確認

- `ScriptApp.getIdentityToken()` は実機未確認。4 のテストデプロイで最初に見る。動かなければサイドバーに「Google アカウントを確認できませんでした」と出る
- `openid` を足したので、テストデプロイ済みのアカウントがあれば再認可が必要
- 返金してもキーは無効化できない（設計上の割り切り。README「ライセンスキーの仕組み」）
- サイドバー以外（サイトの直リンクなど）から Payment Link で決済されると `client_reference_id` が無くキーを出せない。完了ページが決済 ID を示して問い合わせに誘導するので、来たら返金か `license:issue` で対応
- `.license-secret` を変えると既発行のキーが全部無効になる
