locals {
  apis = toset([
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "iam.googleapis.com",
    "iamcredentials.googleapis.com",
    "iap.googleapis.com",
    "oslogin.googleapis.com",
    "secretmanager.googleapis.com",
    "sts.googleapis.com",
  ])
}

resource "google_project_service" "apis" {
  for_each           = local.apis
  service            = each.value
  disable_on_destroy = false
}

# --- VM のアイデンティティ ---

resource "google_service_account" "vm" {
  account_id   = "discord-mcp-gce"
  display_name = "Discord MCP single VM runtime"
  depends_on   = [google_project_service.apis]
}

# --- シークレット（値のバージョンは手動管理。Terraform が作るのは
# コンテナと、VM アイデンティティへのアクセス権のみ） ---

resource "google_secret_manager_secret" "bot_token" {
  secret_id = var.bot_secret_name
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "auth" {
  secret_id = var.auth_secret_name
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "bot_token" {
  secret_id = google_secret_manager_secret.bot_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_secret_manager_secret_iam_member" "auth" {
  secret_id = google_secret_manager_secret.auth.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}


resource "google_secret_manager_secret" "x_auth_token" {
  secret_id = var.x_auth_token_secret_name
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret" "x_ct0" {
  secret_id = var.x_ct0_secret_name
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "x_auth_token" {
  secret_id = google_secret_manager_secret.x_auth_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}

resource "google_secret_manager_secret_iam_member" "x_ct0" {
  secret_id = google_secret_manager_secret.x_ct0.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.vm.email}"
}

# --- ネットワーク ---

resource "google_compute_network" "vpc" {
  name                    = var.network_name
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "subnet" {
  name          = var.subnet_name
  region        = var.region
  network       = google_compute_network.vpc.id
  ip_cidr_range = var.subnet_cidr
}

resource "google_compute_address" "ip" {
  name    = "${var.instance_name}-ip"
  region  = var.region
  project = var.project_id
}

# VM のサービスアカウントにスコープ（タグではなく）。HTTPS は公開、SSH は IAP のみ。
resource "google_compute_firewall" "web" {
  name    = "${var.firewall_name_prefix}-web"
  network = google_compute_network.vpc.name
  allow {
    protocol = "tcp"
    ports    = ["80"]
  }
  allow {
    protocol = "tcp"
    ports    = ["443"]
  }
  source_ranges           = ["0.0.0.0/0"]
  target_service_accounts = [google_service_account.vm.email]
}

resource "google_compute_firewall" "iap_ssh" {
  name    = "${var.firewall_name_prefix}-iap-ssh"
  network = google_compute_network.vpc.name
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  # Google IAP TCP フォワーディング帯 — それ以外の SSH 侵入は不可。
  source_ranges           = ["35.235.240.0/20"]
  target_service_accounts = [google_service_account.vm.email]
}

# --- 任意の Cloud DNS レコード ---

data "google_dns_managed_zone" "zone" {
  count = var.dns_zone_name != "" ? 1 : 0
  name  = var.dns_zone_name
}

resource "google_dns_record_set" "a" {
  count        = var.dns_zone_name != "" && var.hostname != "" ? 1 : 0
  managed_zone = data.google_dns_managed_zone.zone[0].name
  name         = "${var.hostname}."
  type         = "A"
  ttl          = 300
  rrdatas      = [google_compute_address.ip.address]
}

# --- インスタンス ---

resource "google_compute_instance" "vm" {
  name         = var.instance_name
  machine_type = var.machine_type
  zone         = var.zone
  labels       = { application = var.instance_name }

  boot_disk {
    # auto_delete=false で VM を作り直しても SQLite のデータがディスクに残る。
    auto_delete = false
    initialize_params {
      image = var.boot_image
      size  = var.disk_size_gb
      type  = var.disk_type
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet.id
    access_config {
      nat_ip = google_compute_address.ip.address
    }
  }

  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
  }

  # metadata_startup_script は使わない — 変更するとインスタンスが再作成される。
  # 初回ブートのプロビジョニングは deployment/gce/install.sh 内で行う。

  scheduling {
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
  }

  allow_stopping_for_update = true
  depends_on                = [google_project_service.apis]
}

# --- 人間オペレータ向け SSH アクセス（OS Login + IAP トンネル） ---

resource "google_compute_instance_iam_member" "admin_oslogin" {
  for_each      = toset(var.admin_members)
  project       = var.project_id
  zone          = var.zone
  instance_name = google_compute_instance.vm.name
  role          = "roles/compute.osAdminLogin"
  member        = each.value
}

resource "google_iap_tunnel_instance_iam_member" "admin_iap" {
  for_each = toset(var.admin_members)
  project  = var.project_id
  zone     = var.zone
  instance = google_compute_instance.vm.name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = each.value
}
