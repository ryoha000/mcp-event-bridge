# X Web Push → MCP Events

このホストは [Angelic-Angel](https://github.com/sh1ma/Angelic-Angel) を同じ VM で常駐させることで、X の Web Push 通知を raw JSON のまま MCP Events に流せる。

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

Angelic-Angel をビルド・インストールし、専用ユーザーを作る。例:

```sh
sudo useradd --system --home /var/lib/angelic-angel --shell /usr/sbin/nologin angelic-angel
sudo install -d -o angelic-angel -g angelic-angel -m 0700 /var/lib/angelic-angel
```

初回だけ、専用ユーザーで config を作成して Web Push subscription を登録する。

```sh
sudo -u angelic-angel /usr/local/bin/angelic-angel \
  -c /var/lib/angelic-angel/angelic-angel.toml init

sudo -u angelic-angel /usr/local/bin/angelic-angel \
  -c /var/lib/angelic-angel/angelic-angel.toml register

sudo chmod 0600 /var/lib/angelic-angel/angelic-angel.toml
```

その後、`deployment/gce/angelic-angel.service.example` を環境に合わせてインストールし、常駐させる。

## シークレットの扱い

`auth_token` と `ct0` はログインセッション資格情報として扱い、Git、GitHub Actions variables、通常の環境ファイル、PR/Issue、ログには入れない。

現在の Angelic-Angel は Twitter Cookie と Web Push 登録状態を同じ TOML に保存し、UAID 再登録時にもその config を読み書きする。このため、Secret Manager から起動時だけ注入してディスクに一切残さない構成には、そのままではできない。

現状の推奨は次の通り。

- `/var/lib/angelic-angel/angelic-angel.toml` を専用ユーザー所有・mode `0600` にする。
- VM への SSH/IAM を最小化する。
- Cookie をローテーションしたら config を更新して再登録する。
- Secret Manager を使う場合も「初期投入元」として扱い、現行 upstream が最終的に TOML へ保存する点を前提にする。

Cookie と registration を分離して、Cookie を systemd credential / Secret Manager からのみ読むようにするには Angelic-Angel 側の変更が必要。

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
