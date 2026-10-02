#!/usr/bin/env bash
# scripts/deploy-gce.mjs のリモート側 — GCE インスタンス上で root として実行。
# 環境変数: HOST は必須、CERTBOT_EMAIL と NODE_VERSION は任意
# （空のメールは --register-unsafely-without-email を意味する）。
# このスクリプトと同じディレクトリのペイロードに、描画済み設定・ユニット・
# app.tar（デプロイ対象コミットの git archive — 追跡ファイルのみ）が入る。
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP=/opt/discord-mcp
ETC=/etc/discord-mcp
SITE=/etc/nginx/sites-available/discord-mcp
REVISION="$(cat "$DEPLOY_DIR/revision")"
APP_CHANGED=0
CFG_CHANGED=0
CHANGED=0
UNIT_CHANGED=0
NGINX_CHANGED=0

trap 'rm -rf "$DEPLOY_DIR"' EXIT

if [ -z "${HOST:-}" ]; then
  echo "HOST is required" >&2
  exit 1
fi

NODE_VERSION="${NODE_VERSION:-22.23.3}"

# --- 初回ブートのプロビジョニング（マーカーで冪等化し、以降のデプロイを軽く保つ） ---
MARKER=/var/lib/discord-mcp-bootstrap.done
WANT="node-v${NODE_VERSION}"
if [ ! -f "$MARKER" ] || [ "$(cat "$MARKER")" != "$WANT" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends nginx certbot python3-certbot-nginx curl ca-certificates xz-utils
  if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "v${NODE_VERSION}" ]; then
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" -o /tmp/node.tar.xz
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
    rm -f /tmp/node.tar.xz
  fi
  id discord-mcp >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin discord-mcp
  install -d -m 0700 -o discord-mcp -g discord-mcp /var/lib/discord-mcp
  install -d -m 0755 /opt/discord-mcp "$ETC" /var/lib/letsencrypt
  rm -f /etc/nginx/sites-enabled/default
  systemctl enable nginx
  printf '%s' "$WANT" > "$MARKER"
fi

# --- アプリコード ---
PREV=""
if [ -f "$APP/.revision" ]; then PREV="$(cat "$APP/.revision")" || true; fi
if [ "$PREV" != "$REVISION" ]; then
  rm -rf "$APP.new" "$APP.prev"
  mkdir "$APP.new"
  tar xf "$DEPLOY_DIR/app.tar" -C "$APP.new"
  if [ -d "$APP" ]; then mv "$APP" "$APP.prev"; fi
  mv "$APP.new" "$APP"
  printf '%s\n' "$REVISION" > "$APP/.revision"
  # node_modules はアーカイブに含まれない。lock が同じなら前リビジョンから引き継ぐ。
  if [ -f "$APP.prev/package-lock.json" ] && cmp -s "$APP/package-lock.json" "$APP.prev/package-lock.json" && [ -d "$APP.prev/node_modules" ]; then
    mv "$APP.prev/node_modules" "$APP/node_modules"
  else
    (cd "$APP" && npm ci --omit=dev --ignore-scripts)
  fi
  APP_CHANGED=1
  CHANGED=1
fi

# --- runtime env（非秘密。秘密情報は systemd クレデンシャルに留める） ---
install -d -m 0755 "$ETC"
if ! cmp -s "$DEPLOY_DIR/runtime.env" "$ETC/runtime.env"; then
  if [ -f "$ETC/runtime.env" ]; then cp -a "$ETC/runtime.env" "$ETC/runtime.env.prev"; fi
  install -m 0640 "$DEPLOY_DIR/runtime.env" "$ETC/runtime.env"
  CFG_CHANGED=1
  CHANGED=1
fi

# --- systemd ユニット ---
for unit in discord-mcp-secrets.service discord-mcp.service; do
  if ! cmp -s "$DEPLOY_DIR/$unit" "/etc/systemd/system/$unit"; then
    install -m 0644 "$DEPLOY_DIR/$unit" "/etc/systemd/system/$unit"
    UNIT_CHANGED=1
    CHANGED=1
  fi
done
if [ "$UNIT_CHANGED" = 1 ]; then systemctl daemon-reload; fi

# --- nginx スニペット/logrotate ---
install -d -m 0755 /etc/nginx/snippets /etc/nginx/conf.d /etc/logrotate.d /var/lib/letsencrypt
install_pair() {
  if ! cmp -s "$DEPLOY_DIR/$1" "$2"; then install -m 0644 "$DEPLOY_DIR/$1" "$2"; NGINX_CHANGED=1; fi
}
install_pair nginx-proxy.conf /etc/nginx/snippets/discord-mcp-proxy.conf
install_pair nginx-timing.conf /etc/nginx/conf.d/discord-mcp-timing.conf
install_pair nginx-timing-logrotate.conf /etc/logrotate.d/discord-mcp-timing

# --- サイト設定: 証明書ができるまではブートストラップ（ACME のみ） ---
SITE_SRC=nginx-https.conf
if [ ! -f /etc/letsencrypt/live/discord-mcp/fullchain.pem ]; then SITE_SRC=nginx-bootstrap.conf; fi
install_pair "$SITE_SRC" "$SITE"
ln -sfn ../sites-available/discord-mcp /etc/nginx/sites-enabled/discord-mcp
rm -f /etc/nginx/sites-enabled/default

if [ "$NGINX_CHANGED" = 1 ] || ! systemctl is-active --quiet nginx; then
  nginx -t
  systemctl enable nginx
  systemctl reload-or-restart nginx
fi

# --- ブートストラップサイト経由での初回証明書発行 ---
if [ ! -f /etc/letsencrypt/live/discord-mcp/fullchain.pem ]; then
  if [ -n "${CERTBOT_EMAIL:-}" ]; then
    certbot certonly --webroot --webroot-path /var/lib/letsencrypt --domain "$HOST" --cert-name discord-mcp --agree-tos --email "$CERTBOT_EMAIL" --non-interactive --keep-until-expiring
  else
    certbot certonly --webroot --webroot-path /var/lib/letsencrypt --domain "$HOST" --cert-name discord-mcp --agree-tos --register-unsafely-without-email --non-interactive --keep-until-expiring
  fi
  install -m 0644 "$DEPLOY_DIR/nginx-https.conf" "$SITE"
  nginx -t
  systemctl reload nginx
fi

# --- サービス: 変更があった場合のみ再起動 ---
if ! systemctl is-enabled --quiet discord-mcp.service 2>/dev/null; then
  systemctl enable discord-mcp.service
  CHANGED=1
fi
# restart の失敗で中断しないよう || true にし、後続のヘルスチェックで判定する。
if [ "$CHANGED" = 1 ] || ! systemctl is-active --quiet discord-mcp.service || [ ! -f /run/discord-mcp-secrets/bot-token ]; then
  systemctl restart discord-mcp-secrets.service discord-mcp.service || true
fi

# --- ヘルスチェック ---
ok=0
for _ in $(seq 1 30); do
  if curl -fsS --max-time 5 http://127.0.0.1:8080/healthz >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ "$ok" != 1 ]; then
  if [ "$APP_CHANGED" = 1 ] && [ -d "$APP.prev" ]; then
    rm -rf "$APP"
    mv "$APP.prev" "$APP"
    if [ "$CFG_CHANGED" = 1 ] && [ -f "$ETC/runtime.env.prev" ]; then mv "$ETC/runtime.env.prev" "$ETC/runtime.env"; fi
    systemctl restart discord-mcp-secrets.service discord-mcp.service || true
    recovered=0
    for _ in $(seq 1 15); do
      if curl -fsS --max-time 5 http://127.0.0.1:8080/healthz >/dev/null 2>&1; then recovered=1; break; fi
      sleep 2
    done
    echo "health check failed; rolled back to previous revision (recovered=$recovered)" >&2
  else
    echo "health check failed" >&2
  fi
  exit 1
fi
echo "deploy ok: $REVISION"
