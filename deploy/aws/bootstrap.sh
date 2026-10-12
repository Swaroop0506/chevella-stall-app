#!/usr/bin/env bash
# EC2 user-data: takes a bare Ubuntu 24.04 instance to a running stall app.
#
# Passed as --user-data when the instance is launched, so it runs once on first boot as
# root. Everything it needs is baked in below; there is nothing to log in and type.
#
# Output lands in /var/log/cloud-init-output.log — read that first if the site does not
# come up.

set -euxo pipefail

REPO="${REPO:-https://github.com/Swaroop0506/chevella-stall-app.git}"
APP_DIR=/opt/chevella
DOMAIN="__DOMAIN__"          # substituted before launch; empty means "HTTP only, IP access"
ADMIN_EMAIL="__ADMIN_EMAIL__"

export DEBIAN_FRONTEND=noninteractive

# ------------------------------------------------------------------ packages

apt-get update -y
apt-get install -y ca-certificates curl git gnupg openssl ufw

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list

apt-get update -y
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

# ------------------------------------------------------------------ swap
#
# Building the OCR image and loading the PP-OCRv5 models both spike memory well above the
# steady-state footprint. Swap is what stops a 4 GB box being OOM-killed mid-build — it is
# cheap insurance and never gets touched once the models are resident.

if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ------------------------------------------------------------------ app

git clone "$REPO" "$APP_DIR"
cd "$APP_DIR"

# Secrets are generated on the box and never leave it. Nothing here is committed.
PG_PASS="$(openssl rand -hex 24)"
JWT="$(openssl rand -hex 32)"
DEVICE_KEY="$(openssl rand -hex 32)"
IP_SALT="$(openssl rand -hex 16)"
ADMIN_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)"

if [ -n "$DOMAIN" ]; then
  BASE="https://$DOMAIN"
else
  # No domain yet: fall back to the public IP over plain HTTP so the admin is reachable.
  # The /scan camera will NOT work like this — browsers require HTTPS for getUserMedia.
  BASE="http://$(curl -fsS --max-time 5 http://169.254.169.254/latest/meta-data/public-ipv4 || echo localhost)"
fi

cat > .env <<ENVEOF
POSTGRES_USER=cf
POSTGRES_PASSWORD=$PG_PASS
POSTGRES_DB=chevella_stall
DATABASE_URL=postgres://cf:$PG_PASS@db:5432/chevella_stall

JWT_SECRET=$JWT
DEVICE_API_KEY=$DEVICE_KEY
IP_HASH_SALT=$IP_SALT

PUBLIC_BASE_URL=$BASE
API_PUBLIC_URL=$BASE
CORS_ORIGINS=$BASE

SEED_ADMIN_NAME=Chevella Admin
SEED_ADMIN_EMAIL=$ADMIN_EMAIL
SEED_ADMIN_PASSWORD=$ADMIN_PASS

HTTP_PORT=3000
MAX_UPLOAD_MB=12
ENVEOF
chmod 600 .env

# The OCR image downloads ~40 MB of model weights at build time, so this is the slow step.
docker compose build
docker compose up -d
docker compose exec -T api npm run migrate

# The seed password has done its job; leave it out of the file that stays on disk.
sed -i 's/^SEED_ADMIN_PASSWORD=.*/SEED_ADMIN_PASSWORD=/' .env

# ------------------------------------------------------------------ https

if [ -n "$DOMAIN" ]; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y
  apt-get install -y caddy

  cat > /etc/caddy/Caddyfile <<CADDYEOF
$DOMAIN {
    reverse_proxy localhost:3000
    request_body {
        max_size 20MB
    }
    encode gzip
}
CADDYEOF
  systemctl restart caddy
fi

# ------------------------------------------------------------------ firewall

ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
[ -z "$DOMAIN" ] && ufw allow 3000/tcp   # only needed when there is no Caddy in front
ufw --force enable

# ------------------------------------------------------------------ handover

cat > /root/CREDENTIALS.txt <<CREDEOF
Chevella Farms stall app — first-boot credentials
Generated $(date -u +%FT%TZ)

  URL             $BASE
  Admin login     $ADMIN_EMAIL
  Admin password  $ADMIN_PASS

  Device key (for the scanner app / web scanner):
  $DEVICE_KEY

Change the admin password after signing in. The device key is also shown in the admin
under "Scanner"; rotate it via DEVICE_API_KEY in $APP_DIR/.env if a phone is lost.

Read this once, then delete this file:  shred -u /root/CREDENTIALS.txt
CREDEOF
chmod 600 /root/CREDENTIALS.txt

echo "BOOTSTRAP COMPLETE — credentials in /root/CREDENTIALS.txt"
