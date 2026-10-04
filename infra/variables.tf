variable "project_id" {
  description = "Discord MCP インスタンスをホストする GCP プロジェクト ID。"
  type        = string
}

variable "project_number" {
  description = "プロジェクト番号（Secret Manager のリソース ID などで使用）。"
  type        = string
}

variable "region" {
  description = "VM・サブネット・静的 IP のリージョン。"
  type        = string
  default     = "us-west1"
}

variable "zone" {
  description = "VM のゾーン。"
  type        = string
  default     = "us-west1-c"
}

variable "instance_name" {
  description = "GCE インスタンス名。DEPLOY_INSTANCE と一致させること。"
  type        = string
  default     = "discord-mcp-gce"
}

variable "machine_type" {
  description = "マシンタイプ。サービスは SQLite シングルトンなので小さい 1 台で十分。"
  type        = string
  default     = "e2-micro"
}

variable "disk_size_gb" {
  description = "ブートディスクサイズ。"
  type        = number
  default     = 10
}

variable "disk_type" {
  description = "ブートディスクタイプ。"
  type        = string
  default     = "pd-standard"
}

variable "boot_image" {
  description = "ブートディスクイメージ。インポートで差分が出ないよう現行イメージにピン留め。"
  type        = string
  default     = "ubuntu-os-cloud/ubuntu-2404-noble-amd64-v20260918"
}

variable "network_name" {
  description = "インスタンスのカスタム VPC 名。"
  type        = string
  default     = "discord-mcp-gce"
}

variable "subnet_name" {
  description = "VPC 内のサブネット名。"
  type        = string
  default     = "discord-mcp-uswest1"
}

variable "subnet_cidr" {
  description = "サブネット CIDR。"
  type        = string
  default     = "10.241.0.0/28"
}

variable "firewall_name_prefix" {
  description = "ファイアウォールルール名の接頭辞。"
  type        = string
  default     = "discord-mcp"
}

variable "hostname" {
  description = "公開 HTTPS ホスト（FQDN）。任意の Cloud DNS レコードでのみ使用。"
  type        = string
  default     = ""
}

variable "dns_zone_name" {
  description = "Cloud DNS マネージドゾーン名。hostname と併せて設定すると A レコードを作成。"
  type        = string
  default     = ""
}

variable "github_repo" {
  description = "Workload Identity Federation 経由のデプロイを許可する GitHub リポジトリ（owner/name）。"
  type        = string
}

variable "admin_members" {
  description = "手動デプロイ用にインスタンスへ SSH を許可する IAM メンバー。例: [\"user:you@example.com\"]。"
  type        = list(string)
  default     = []
}

variable "bot_secret_name" {
  description = "Discord ボットトークンを保持する Secret Manager シークレット。MCP_DISCORD_BOT_SECRET に対応。"
  type        = string
  default     = "discord-mention-bot-token"
}

variable "auth_secret_name" {
  description = "OAuth 署名/cookie JSON を保持する Secret Manager シークレット。MCP_AUTH_SECRET に対応。"
  type        = string
  default     = "discord-consolidated-auth"
}

variable "x_auth_token_secret_name" {
  description = "監視専用 X アカウントの auth_token を保持する Secret Manager シークレット。"
  type        = string
  default     = "x-monitor-auth-token"
}

variable "x_ct0_secret_name" {
  description = "監視専用 X アカウントの ct0 を保持する Secret Manager シークレット。"
  type        = string
  default     = "x-monitor-ct0"
}
