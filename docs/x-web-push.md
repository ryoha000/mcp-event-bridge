# X Web Push → MCP Events

このホストは [Angelic-Angel](https://github.com/ryoha000/Angelic-Angel) を同じ VM で常駐させることで、X の Web Push 通知を raw JSON のまま MCP Events に流せる。

```
X → Mozilla AutoPush → Angelic-Angel → http://127.0.0.1:8080/internal/x-web-push
                                      → durable event store → MCP Events webhook → dot
```

## ブラウザは常駐不要

Angelic-Angel 自体が Firefox 相当の Web Push クライアントとして Mozilla AutoPush へ WebSocket 接続するため、Firefox/Chrome を起動し続ける必要はない。ブラウザが必要なのは、最初に X の `auth_token` と `ct0` Cookie を取得するときだけである。

常駐が必要なのは Angelic-Angel のプロセスと、この MCP bridge のプロセスである。

## X アカウント構成

自分自身の投稿を取り込む用途では、監視専用の X アカウントを使う。

1. 監視専用アカウントから対象アカウントをフォローする。
2. 対象アカウントの投稿通知を有効にする。
3. 監視専用アカウントの `auth_token` と `ct0` を Angelic-Angel に設定する。

bridge は通知 JSON を解釈・要約せず、`x.web_push.received` の `data.payload` としてそのまま dot に配送する。ただし通知に status URL が含まれる場合、ingest 時に `data.tweet` へ縮約したツイート本文・メディア URL を添える（後述）。X への書き込み機能や `x:reply` スコープは提供しない。

## bridge の設定

`/etc/discord-mcp/runtime.env` に以下を追加する。

```sh
X_WEB_PUSH_SOURCE_ID=@your_handle
X_WEB_PUSH_TWEET_API=https://api.fxtwitter.com
```

`X_WEB_PUSH_SOURCE_ID` は秘密ではない。イベントの tenant/source identity を安定させるためのラベルで、監視対象の handle などを使う。

`X_WEB_PUSH_TWEET_API` は通知内の status URL からツイート本文・メディア URL を補完する fxtwitter 互換 API の HTTPS ベース URL で、既定は `https://api.fxtwitter.com`。bridge は `https://{X_WEB_PUSH_TWEET_API}/{user}/status/{id}`（URL に user が無い `i/web/status` 形式なら `/status/{id}`）に GET するだけで、通知内の URL をそのまま fetch しない。タイムアウトや取得失敗でもイベントは破棄せず、通知自体が持つ本文・アイコン等から組み立てた `partial: true` の tweet を添える。`none` にすると外部 API を呼ばず、常に通知由来の `partial: true` tweet のみを添える。

公開 nginx 設定は `/internal/x-web-push` を proxy しない。Angelic-Angel は同一 VM 上から直接 `127.0.0.1:8080` へ POST する。公開側では Discord を `/mcp/discord`、X を `/mcp/x` に分離し、X の OAuth issuer は `/x` を使う。

## Secret Manager の準備

この X 連携のためだけに `terraform apply` は使わない。既存インフラの Terraform state が手元にない場合、VM/VPC/WIF など既存リソースまで新規作成扱いになるためである。

X 用の Secret 2個だけを `gcloud` で作成する。

```sh
export PROJECT_ID='<your-gcp-project>'

gcloud secrets describe x-monitor-auth-token --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud secrets create x-monitor-auth-token --project="$PROJECT_ID" --replication-policy=automatic

gcloud secrets describe x-monitor-ct0 --project="$PROJECT_ID" >/dev/null 2>&1 || \
  gcloud secrets create x-monitor-ct0 --project="$PROJECT_ID" --replication-policy=automatic
```

次に、実際に bridge が動いている VM の service account を確認する。

```sh
export INSTANCE='<your-instance-name>'
export ZONE='<your-zone>'

VM_SA="$(gcloud compute instances describe "$INSTANCE" \
  --project="$PROJECT_ID" \
  --zone="$ZONE" \
  --format='value(serviceAccounts[0].email)')"

printf '%s\n' "$VM_SA"
```

その service account に、X 用 Secret 2個だけの read 権限を付ける。

```sh
for SECRET in x-monitor-auth-token x-monitor-ct0; do
  gcloud secrets add-iam-policy-binding "$SECRET" \
    --project="$PROJECT_ID" \
    --member="serviceAccount:$VM_SA" \
    --role="roles/secretmanager.secretAccessor"
done
```

Secret の値（version）は次節の手順で別途投入する。値を Terraform variables/state に入れない。

## X Cookie の取得

監視専用 X アカウントを用意し、そのアカウントで対象アカウントをフォローして投稿通知を ON にする。

1. ブラウザで監視専用アカウントとして `https://x.com` にログインする。
2. DevTools を開く。
3. Chrome/Chromium 系なら **Application → Storage → Cookies → https://x.com**、Firefox なら **Storage → Cookies → https://x.com** を開く。
4. `auth_token` の Value を控える。
5. `ct0` の Value を控える。

これらはログインセッション資格情報なので、チャット・Issue・PR・`.env`・shell history に貼らない。

macOS/Linux の端末から値を履歴に残しにくく投入する例:

```sh
export PROJECT_ID='<your-gcp-project>'

read -s X_AUTH_TOKEN
printf '%s' "$X_AUTH_TOKEN" | gcloud secrets versions add x-monitor-auth-token \
  --project="$PROJECT_ID" --data-file=-
unset X_AUTH_TOKEN

read -s X_CT0
printf '%s' "$X_CT0" | gcloud secrets versions add x-monitor-ct0 \
  --project="$PROJECT_ID" --data-file=-
unset X_CT0
```

値を表示せず、version が作られたことだけ確認する:

```sh
gcloud secrets versions list x-monitor-auth-token --project="$PROJECT_ID"
gcloud secrets versions list x-monitor-ct0 --project="$PROJECT_ID"
```

## bridge のデプロイ

ローカルデプロイでは `.env.example` を `.env` にコピーし、既存の必須値に加えて `X_WEB_PUSH_SOURCE_ID` を設定すると X Web Push が有効になる。

```sh
X_WEB_PUSH_SOURCE_ID=@your_target_handle
```

`auth_token` / `ct0` の実値は `.env` に書かない。

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run deploy -- --dry-run
npm run deploy
```

GitHub Actions の CD を使う場合は、`production` environment の variables に次を追加する。

```text
X_WEB_PUSH_SOURCE_ID=@your_target_handle
```

Secret Manager の名前をデフォルトから変えない限り、GitHub Actions に X Cookie の値や Secret 名を追加する必要はない。

`npm run deploy` は bridge、Secret Manager loader の設定、nginx、systemd unit を VM に配置する。ただし Angelic-Angel バイナリの初回ビルド/インストールは別途1回必要。

## Angelic-Angel の初回インストール

VM に IAP SSH する。

```sh
gcloud compute ssh <instance-name> \
  --project <project-id> \
  --zone <zone> \
  --tunnel-through-iap
```

VM 上で Rust stable を用意し、credential 対応をマージ済みの fork を固定 revision からビルドする。現在この機能を含む merge commit は `f891d282a2dfd88001a7b95434af9c6395071706`。

```sh
sudo apt-get update
sudo apt-get install -y build-essential curl ca-certificates

curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh
sh /tmp/rustup.sh -y --profile minimal
. "$HOME/.cargo/env"

cargo install --locked \
  --git https://github.com/ryoha000/Angelic-Angel \
  --rev f891d282a2dfd88001a7b95434af9c6395071706 \
  angelic-angel

sudo install -m 0755 "$HOME/.cargo/bin/angelic-angel" /usr/local/bin/angelic-angel
/usr/local/bin/angelic-angel --help
```

## Angelic-Angel の設定

この構成では systemd credentials 対応済みの [ryoha000/Angelic-Angel](https://github.com/ryoha000/Angelic-Angel) を使う。ブラウザ常駐は不要で、X Cookie は TOML に保存しない。

専用ユーザーと永続 state directory を作る。

```sh
sudo useradd --system --home /var/lib/angelic-angel --shell /usr/sbin/nologin angelic-angel
sudo install -d -o angelic-angel -g angelic-angel -m 0700 /var/lib/angelic-angel
```

fork版 Angelic-Angel を `/usr/local/bin/angelic-angel` にインストールした後、Cookie を含まない config を作る。

```sh
sudo -u angelic-angel /usr/local/bin/angelic-angel \
  -c /var/lib/angelic-angel/angelic-angel.toml init --systemd-credentials
```

監視専用 X アカウントの `auth_token` と `ct0` は Secret Manager に別々の secret として保存する。bridge の `discord-mcp-secrets.service` が VM identity でそれらを読み、root 限定の `/run/discord-mcp-secrets/x-auth-token` と `x-ct0` に展開する。値は runtime.env や Git には入れない。

```sh
X_WEB_PUSH_SOURCE_ID=@your_target_handle
MCP_X_AUTH_TOKEN_SECRET=x-monitor-auth-token
MCP_X_AUTH_TOKEN_SECRET_VERSION=latest
MCP_X_CT0_SECRET=x-monitor-ct0
MCP_X_CT0_SECRET_VERSION=latest
```

最初の Web Push 登録も systemd credentials を付けて実行する。

```sh
sudo systemctl restart discord-mcp-secrets.service

sudo systemd-run --wait --pipe \
  -p User=angelic-angel \
  -p Group=angelic-angel \
  -p LoadCredential=auth_token:/run/discord-mcp-secrets/x-auth-token \
  -p LoadCredential=ct0:/run/discord-mcp-secrets/x-ct0 \
  /usr/local/bin/angelic-angel \
  -c /var/lib/angelic-angel/angelic-angel.toml register
```

登録後は `deployment/gce/angelic-angel.service.example` を systemd に入れて常駐させる。この unit は同じ `/run/discord-mcp-secrets/*` を `LoadCredential` し、Angelic-Angel には `$CREDENTIALS_DIRECTORY/auth_token` と `$CREDENTIALS_DIRECTORY/ct0` として見せる。

## シークレットの扱い

`auth_token` と `ct0` はログインセッション資格情報として扱う。

- Git、GitHub Actions variables、通常の環境ファイル、PR/Issue、ログには値を入れない。
- Secret Manager には `auth_token` と `ct0` を別 secret として保存する。
- VM の service account には必要な secret version への access のみ付与する。
- bridge の secret loader は値を root 限定の揮発 `/run` に置く。
- systemd はその値を Angelic-Angel 専用 credential directory にコピーする。
- fork版 Angelic-Angel の `--systemd-credentials` モードでは Cookie を `angelic-angel.toml` に書かない。
- `angelic-angel.toml` には Web Push の秘密鍵と AutoPush 登録状態だけが残り、Unix では mode `0600` で保存される。

Cookie をローテーションした場合は Secret Manager に新 version を追加し、`latest` を使っていれば secret loader と Angelic-Angel を再起動する。Twitter/X 側への再登録が必要になった場合も、Angelic-Angel は systemd credentials を再読込して自動再登録する。

## dot / ChatGPT 側

`x_status` はイベントがない状態でも認証済みの読み取りに成功する接続確認用ツールです。設定済みソースと、そのオーナー・Xソースのイベント／subscription／配送件数だけを返し、通知本文、アカウント識別子、認証情報は返しません。listenerの稼働やAutoPush接続を直接確認する機能ではありません。`x_read_event` は保存済みイベントIDがある場合に使います。

X は既存の Discord plugin へ追加せず、別 plugin として登録する。

- 表示名の例: `MCP Event Bridge(X)`
- MCP Server URL: `https://<your-host>/mcp/x`
- OAuth issuer: `https://<your-host>/x`
- OAuth scope: `x:read` のみ
- event: `x.web_push.received`
- tool: `x_read_event`

既存の `MCP Event Bridge(Discord)` は `/mcp/discord` のままで、`discord:read` / `discord:reply` の既存 client/grant を変更しない。X 側は新規 OAuth client と専用 state/cookie namespace を使うため、Discord 側の再認可は不要。

X plugin の consent 画面には、X が read-only で raw Web Push payload のみを公開し X へ投稿できない旨が表示される。

subscription arguments は空オブジェクト:

```json
{
  "name": "x.web_push.received",
  "arguments": {},
  "delivery": {
    "mode": "webhook",
    "url": "https://...",
    "secret": "whsec_..."
  }
}
```

callback の `data` は次の形で、`payload` が Angelic-Angel から受けた raw JSON である。

```json
{
  "version": 1,
  "event_id": "evt_...",
  "source": "x",
  "source_id": "@your_handle",
  "timestamp": "2026-10-05T00:00:00.000Z",
  "payload": {},
  "tweet": {
    "url": "https://x.com/you/status/1",
    "id": "1",
    "text": "...",
    "author": {"name": "...", "screen_name": "you"},
    "media": {"photos": [{"url": "https://pbs.twimg.com/..."}]}
  },
  "context_policy": "origin_event_only"
}
```

`tweet` は通知に status URL が含まれるとき付く。補完成功時は fxtwitter 由来の縮約データ（本文全文・投稿者名・写真/動画 URL・エンゲージメント数・引用ツイート1段）。補完失敗時や `X_WEB_PUSH_TWEET_API=none` のときは通知自体のフィールド（`title`/`body`/`icon`/`timestamp`/`image`/`data.lang`）から組み立てた `partial: true` の tweet になる。status URL を含まない通知ではキー自体が無い。`payload` と同様に非信頼データとして扱うこと。

同一 raw payload は内容ハッシュ由来の event ID で重複排除する。
