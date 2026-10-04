# MCP Event Bridge

合成プローブと Discord メンションアダプタを備えた、耐久性のある MCP Events ブリッジ。現在の常駐 Discord ホストは、Linux プロセス 1 つ・SQLite・systemd・HTTPS リバースプロキシで構成される。リクエスト駆動のスケールトゥーゼロなサービスでは Discord Gateway 接続を維持できない。

`Discord Gateway → ソースアダプタ → バージョン付きイベントエンベロープ → 永続アウトボックス → 署名付き MCP Events コールバック`

コンシューマは `/mcp/discord` を通じて `discord_read_event`、`discord_reply_to_event`、`discord_status` を利用できる。OAuth スコープは read と reply のアクセスを分離する。返信の宛先は保存された起点メンションから導出され、呼び出し側が別チャンネルを選ぶことはできない。人間による直接メンションは設定済みギルド内でのみ受理される。DM、bot のメッセージ、メッセージ履歴、添付は除外される。メンション本文は信頼できない入力であり、自動応答器はそのイベントのコンテキストのみを使うべきである。

SQLite はイベント・配送試行・サブスクリプション・OAuth 許可・返信受領・Gateway チェックポイントを永続化する。イベント ID と返信受領はリトライを重複排除する。曖昧な Discord 送信は自動再送せず `unknown` として保持される。Discord アダプタは上限付きの独立した 👀 リアクションも発行する。インラインコールバックペイロードは不変のメンションエンベロープを運び、追加の読み取り要求を不要にする。他のソースは `lib/adapters/` の normalize/validate/reply アダプタ契約を実装し、共有の `lib/events/` コンポーネントを利用できる。

## 開発

Node.js 22.13 以降が必要。既存ランタイムには Node.js 22 LTS を使う。

```sh
npm ci --ignore-scripts
npm run check
npm test
```

テストはフェイクの Discord 入力と一時ストレージを使う。Discord や Google の認証情報は不要。独立した合成プローブは `server.mjs`、`production.mjs`、`lib/probe.mjs` に残っており、そのクラウド裏付けの本番モードはプライベート GCS バケットを使う。

## 常駐 Discord ホストの実行

付属のサービスファイルは、独立して設定された Linux VM 向けの例である。インフラや権限をプロビジョニングしない。

1. `/opt/discord-mcp` にソースと本番依存をインストールし、Node を `/usr/local/bin/node` で利用可能にする。非特権の `discord-mcp` ユーザーを作成する。`/var/lib/discord-mcp` はそのユーザー専用にし、再起動を越えて保持する。
2. `deployment/gce/runtime.env.example` をもとに、root が読める `/etc/discord-mcp/runtime.env` を作る。自身の `GCE_DISCORD_ORIGIN`、`DISCORD_GUILD_ID`、`DISCORD_BOT_ID`、Google Web クライアント ID、Google が権威を持つオーナーメール、厳密なコネクタリダイレクト URI を設定する。HTTPS オリジンを Google Web クライアントに登録する。`guild-visible` は bot の既存の可視範囲に従う。`allowlist` は追加で `DISCORD_CHANNEL_IDS`（JSON 配列）を必須とする。
3. Discord bot トークンと、別の OAuth 署名/クッキー JSON ドキュメントを systemd クレデンシャル経由で供給する。ドキュメントには `cookieKeys`（少なくとも 32 バイトのランダム文字列の配列）と `jwks.keys`（2048 ビット以上の秘密 RSA JWK オブジェクトの配列）が必要。実値はチェックアウト外に保存する。任意の `discord-mcp-secrets.service` は VM のIDを使って Secret Manager の指定バージョンを読み込む。`latest` を指定するとローテーション後の再起動で新しいバージョンに追従する。`MCP_*` 設定を構成し、その ID には 2 つのシークレットへのアクセスのみ許可する。サービスアカウントのキーファイルは使わない。
4. `deployment/gce/` の 2 つのユニット例を systemd にインストールする。別のクレデンシャルプロバイダを使う場合は、`/run/discord-mcp-secrets/` の 2 つのクレデンシャルファイルを維持したままシークレットローダーユニットを差し替える。nginx には有効な証明書を用意し、`@@HOST@@` プレースホルダをレンダリングして、プロキシスニペットとタイミングログ形式をインストールする。HTTPS 例にあるルートのみを公開する。MCP と OAuth は HTTPS を使わなければならない。
5. 準備済みホストを `sudo systemctl daemon-reload` と `sudo systemctl enable --now discord-mcp.service` で起動する。ユニットはプロセスロックの下で `npm start` 相当を実行し、Node を `127.0.0.1:8080` にバインドし、クレデンシャルディレクトリを供給する。`/healthz` を確認してから、コンシューマを `https://<your-host>/mcp/discord` に接続し、対象ギルドの `discord.mention.created` を購読する。

bot には対象ギルド/チャンネルへのアクセス、Gateway の guild および guild-message インテント（マスク 513）、閲覧・返信送信・リアクション追加のチャンネル権限が必要。実装は Discord のロールやチャンネル権限を変更しない。OAuth 許可・データベース・認証情報・ログはソース管理に入れない。

このリポジトリは汎用的な例とフェイクのフィクスチャのみを含み、デプロイ履歴や実運用設定は含まない。

## X Web Push (Angelic-Angel)

任意で [Angelic-Angel](https://github.com/ryoha000/Angelic-Angel) を同一 VM に常駐させ、raw X Web Push JSON を `x.web_push.received` として同じ MCP Events 接続へ流せる。ブラウザの常駐は不要で、Angelic-Angel 自体が Mozilla AutoPush への WebSocket を維持する。

安定した `X_WEB_PUSH_SOURCE_ID` を設定すると X Web Push が有効になる。未設定または空なら無効。Angelic-Angel の `WEBHOOK_ENDPOINT` を `http://127.0.0.1:8080/internal/x-web-push` にする。nginx の公開設定はこの内部 ingest path を公開しない。

X Cookie (`auth_token`, `ct0`) はソース管理に入れない。systemd credentials 対応済みの fork を使い、Secret Manager → root 限定 `/run` → `LoadCredential` で渡すため、Cookie は `angelic-angel.toml` に保存しない。詳しい構成と監視専用 X アカウントの手順は [docs/x-web-push.md](docs/x-web-push.md) を参照。

## プロビジョニングとデプロイの自動化

`infra/` には上記の単一 VM 構成（インスタンス、IAM、Secret Manager のコンテナ、ファイアウォール、固定 IP、GitHub Actions 用 Workload Identity Federation）を定義した Terraform がある。`terraform.tfvars.example` をコピーして apply し、シークレットのバージョンは後から Secret Manager に追加する。

```sh
gcloud auth application-default login
terraform -chdir=infra init && terraform -chdir=infra apply
```

`.env.example` から `.env`（gitignore 対象）を作り、IAP SSH 経由でコミット済みツリーをデプロイする。デプロイは冪等で、コミットと設定に変更がなければ再起動しない。

```sh
npm run deploy -- --dry-run   # 構築と検証のみ
npm run deploy                # アップロード + インストール + ヘルスチェック
```

`.github/workflows/` は push ごとに `check`+`test` を実行し（ci）、グリーンになった `main` を Workload Identity Federation 経由でデプロイする（cd）。`production` environment は `.env` と同じ名前の値を持つ： secrets の `GCP_WIF_PROVIDER`、`GCP_DEPLOY_SA`（どちらも Terraform の output）、`DISCORD_GUILD_ID`、`DISCORD_BOT_ID`、および残りの variables。

WIF プロバイダの `attribute_condition` は GitHub OIDC トークンの `repository` クレームを `github_repo` 変数と照合する。つまりデプロイを許可されるのは tfvars で指定したリポジトリの Actions のみであり、fork で動かす場合は `github_repo` をその fork の `owner/name` に合わせる必要がある。

`production` environment とその値は `gh` CLI で作成できる（`-R` は自分のリポジトリを指定）:

```sh
gh api repos/<owner>/<repo>/environments/production -X PUT

gh variable set DEPLOY_HOST --env production -b "<ホスト名>"
gh variable set DEPLOY_GOOGLE_CLIENT_ID --env production -b "<OAuth クライアント ID>"
gh variable set DEPLOY_CHANNEL_IDS --env production -b '[]'
gh variable set DEPLOY_PROJECT --env production -b "<GCP プロジェクト ID>"
gh variable set DEPLOY_PROJECT_NUMBER --env production -b "<プロジェクト番号>"
gh variable set DEPLOY_ZONE --env production -b "<ゾーン>"
gh variable set DEPLOY_INSTANCE --env production -b "<インスタンス名>"
gh variable set DEPLOY_NODE_VERSION --env production -b "22.23.3"
gh variable set GOOGLE_ALLOWED_EMAIL --env production -b "<オーナーのメール>"

gh secret set GCP_WIF_PROVIDER --env production -b "$(terraform -chdir=infra output -raw wif_provider)"
gh secret set GCP_DEPLOY_SA --env production -b "$(terraform -chdir=infra output -raw deploy_service_account)"
gh secret set DISCORD_GUILD_ID --env production -b "<ギルド ID>"
gh secret set DISCORD_BOT_ID --env production -b "<bot の Application ID>"
```
