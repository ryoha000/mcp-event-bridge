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

bridge は通知 JSON を解釈・要約せず、`x.web_push.received` の `data.payload` としてそのまま dot に配送する。X への書き込み機能や `x:reply` スコープは提供しない。

## bridge の設定

`/etc/discord-mcp/runtime.env` に以下を追加する。

```sh
X_WEB_PUSH_ENABLE=true
X_WEB_PUSH_SOURCE_ID=@your_handle
```

`X_WEB_PUSH_SOURCE_ID` は秘密ではない。イベントの tenant/source identity を安定させるためのラベルで、監視対象の handle などを使う。

公開 nginx 設定は `/internal/x-web-push` を proxy しない。Angelic-Angel は同一 VM 上から直接 `127.0.0.1:8080` へ POST する。

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
X_WEB_PUSH_ENABLE=true
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

## dot 側

既存の `/mcp/discord` resource をそのまま利用し、OAuth で `x:read` を許可する。イベント一覧には `x.web_push.received` が追加される。

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
  "context_policy": "origin_event_only"
}
```

同一 raw payload は内容ハッシュ由来の event ID で重複排除する。
