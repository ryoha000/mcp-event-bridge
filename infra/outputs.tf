output "static_ip" {
  description = "外部 IP — HTTPS ホストの A レコードをここに向ける。"
  value       = google_compute_address.ip.address
}

output "instance" {
  value = {
    name = google_compute_instance.vm.name
    zone = google_compute_instance.vm.zone
  }
}

output "vm_service_account" {
  description = "VM アイデンティティ。runtime.env の MCP_GCP_SERVICE_ACCOUNT に設定。"
  value       = google_service_account.vm.email
}

output "wif_provider" {
  description = "GitHub Actions のシークレット GCP_WIF_PROVIDER に設定。"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "deploy_service_account" {
  description = "GitHub Actions のシークレット GCP_DEPLOY_SA に設定。"
  value       = google_service_account.deploy.email
}

output "ssh_hint" {
  value = "gcloud compute ssh ${var.instance_name} --project ${var.project_id} --zone ${var.zone} --tunnel-through-iap"
}

output "x_secret_names" {
  description = "X Web Push 用 Secret Manager コンテナ名。値の version は別途投入する。"
  value = {
    auth_token = google_secret_manager_secret.x_auth_token.secret_id
    ct0        = google_secret_manager_secret.x_ct0.secret_id
  }
}
