# Deploying

The whole system fits on one small VPS. A 2 vCPU / 4 GB box handles a stall comfortably —
OCR is the only hungry part, and it is capped at 2 CPUs in `docker-compose.yml`.

Rough shape of the cost: the server, a domain, and nothing else. There is no per-scan,
per-lead or per-seat charge anywhere in this stack.

---

## 1. Server

Anything that runs Docker: Hetzner CX22, DigitalOcean, Oracle Cloud free tier, or a box in
the office. Ubuntu 24.04 is assumed below.

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER" && newgrp docker
```

## 2. DNS

Point a record at the server before you do anything else — the QR codes contain this name:

```
A    stall.chevellafarms.com    →  <server IP>
```

## 3. Clone and configure

```bash
git clone https://github.com/Swaroop0506/chevella-stall-app.git
cd chevella-stall-app
cp .env.example .env
```

Edit `.env`. The ones that matter:

```bash
POSTGRES_PASSWORD=$(openssl rand -hex 24)
JWT_SECRET=$(openssl rand -hex 32)
DEVICE_API_KEY=$(openssl rand -hex 32)
IP_HASH_SALT=$(openssl rand -hex 16)

PUBLIC_BASE_URL=https://stall.chevellafarms.com     # goes inside every QR code
API_PUBLIC_URL=https://stall.chevellafarms.com
CORS_ORIGINS=https://stall.chevellafarms.com

DATABASE_URL=postgres://cf:<the POSTGRES_PASSWORD above>@db:5432/chevella_stall

SEED_ADMIN_EMAIL=you@chevellafarms.com
SEED_ADMIN_PASSWORD=<a long one, used once>
```

> `PUBLIC_BASE_URL` must be the final public HTTPS address **before you print any QR
> codes**. It is encoded into each one. Changing it afterwards invalidates every printed
> sheet.

## 4. Start

```bash
docker compose up -d --build        # first build pulls the PP-OCRv5 weights, ~5 min
docker compose exec api npm run migrate
docker compose ps
```

Then blank `SEED_ADMIN_PASSWORD` in `.env` — it has done its job.

## 5. HTTPS

The bundled nginx serves plain HTTP on `HTTP_PORT` (3000 by default). Put Caddy in front
for automatic, free certificates:

```bash
sudo apt install -y caddy
```

```caddy
# /etc/caddy/Caddyfile
stall.chevellafarms.com {
    reverse_proxy localhost:3000
    request_body {
        max_size 20MB          # card photos
    }
}
```

```bash
sudo systemctl reload caddy
```

HTTPS is not optional here: `Secure` session cookies require it, and Android will refuse
plaintext uploads from the scanner app without extra configuration.

## 6. Point the app at it

In the admin console, **Scanner app** shows the API URL, the device key and a setup QR.
Add the matching values to the GitHub repo so the APK ships pre-configured:

- Variable `APP_API_URL` = `https://stall.chevellafarms.com`
- Secret `APP_DEVICE_KEY` = your `DEVICE_API_KEY`

Run **Actions → Build Android APK**, download the artifact, and install it on the stall
phones. Set `APK_DOWNLOAD_URL` in `.env` to the release link and the admin page will show a
QR for it.

---

## Deploying to AWS

Two scripts in `deploy/aws/`. `provision.sh` creates the infrastructure from your laptop;
`bootstrap.sh` runs on the instance itself as user-data and needs no interaction.

```bash
aws configure                      # once, with a key that can run EC2
DOMAIN=stall.chevellafarms.com \
ADMIN_EMAIL=you@chevellafarms.com \
REGION=ap-south-1 \
  deploy/aws/provision.sh
```

It creates a security group (SSH from your IP only, 80 and 443 open), a key pair saved to
`~/.ssh/chevella-stall.pem`, a t3.medium on Ubuntu 24.04 with a 30 GB encrypted volume,
and an Elastic IP. Then the instance installs Docker, clones the repo, generates its own
secrets, builds the images, runs the migrations and starts everything. First boot takes
8–12 minutes, almost all of it building the OCR image and pulling the PP-OCRv5 weights.

Afterwards, add one DNS record:

```
stall.chevellafarms.com.    A    <the Elastic IP the script prints>
```

Caddy gets the Let's Encrypt certificate by itself once that resolves. Admin credentials
are written to `/root/CREDENTIALS.txt` on the instance — read them once and shred the file.

### Why a single EC2 instance

For a system that runs hard for three days a year, ECS plus RDS would roughly triple the
bill and add two more moving parts to debug on the morning of the show. One box running
`docker compose` is the same artefact you run locally, which means a problem at the stall
can be reproduced on a laptop.

The size is set by OCR, not by traffic. PP-OCRv5 holds its models in memory and each card
is read six times; with Postgres, Node and Next alongside it, 4 GB is the honest minimum,
so `t3.medium`. A `t3.small` will OOM mid-scan. The bootstrap also adds 4 GB of swap,
which is what stops the image build itself being killed.

### Keeping the bill down

The instance only has to be running during the event.

```bash
aws ec2 stop-instances  --instance-ids <id> --region ap-south-1   # after the show
aws ec2 start-instances --instance-ids <id> --region ap-south-1   # the morning of
```

Stopped, you pay only for the 30 GB volume and the idle Elastic IP — a couple of dollars a
month. Running, a t3.medium in ap-south-1 is roughly $30/month on demand, so an event week
costs about $7. Check current pricing and whatever free-tier credit the account has rather
than taking those numbers as exact.

The Elastic IP survives a stop/start, so the DNS record and every printed QR code keep
working.

### Updating a deployed instance

```bash
ssh -i ~/.ssh/chevella-stall.pem ubuntu@<ip>
cd /opt/chevella && sudo git pull && sudo docker compose up -d --build
sudo docker compose exec -T api npm run migrate
```

---

## Backups

Two things matter. The database is reproducible from a dump; **the card photos are not
reproducible at all.**

```bash
#!/usr/bin/env bash
# /usr/local/bin/cf-backup.sh
set -euo pipefail
cd /home/ubuntu/chevella-stall-app
STAMP=$(date +%F-%H%M)
mkdir -p /var/backups/chevella

docker compose exec -T db pg_dump -U cf chevella_stall \
  | gzip > "/var/backups/chevella/db-$STAMP.sql.gz"

docker run --rm \
  -v chevella-stall_card-storage:/data:ro \
  -v /var/backups/chevella:/backup \
  alpine tar czf "/backup/cards-$STAMP.tar.gz" -C /data .

find /var/backups/chevella -mtime +30 -delete
```

```bash
sudo chmod +x /usr/local/bin/cf-backup.sh
echo "0 2 * * * /usr/local/bin/cf-backup.sh" | sudo crontab -
```

Run it **manually on the evening of each event day** as well. That is when the data is
newest and most valuable, and when a lost phone or a dropped laptop is most likely.

### Restore

```bash
gunzip -c db-2026-11-13-0200.sql.gz | docker compose exec -T db psql -U cf chevella_stall
docker run --rm -v chevella-stall_card-storage:/data \
  -v /var/backups/chevella:/backup alpine \
  sh -c "cd /data && tar xzf /backup/cards-2026-11-13-0200.tar.gz"
```

---

## Before the event — a checklist

- [ ] `PUBLIC_BASE_URL` is the real HTTPS address, and `https://.../c/<code>` loads on a phone
      **on mobile data, not the office wifi**
- [ ] Every contact's QR scanned once with an actual phone camera, and *Save our contact*
      produces a real contact entry on both an Android and an iPhone
- [ ] WhatsApp button opens a chat with the pre-typed message
- [ ] Print pack printed and checked — QRs scan from a metre away off the printed sheet,
      not just off the screen
- [ ] APK installed on every stall phone, each with a distinct phone label
- [ ] One test card scanned per phone, and it appears in **Leads** within a minute
- [ ] Event status set to **Active**
- [ ] Excel export downloaded once and opened, so nobody discovers a problem on day three
- [ ] Phones charged, and a power bank per phone — the camera drains a battery fast

## Day-of monitoring

```bash
docker compose logs -f api ocr          # live
curl https://stall.chevellafarms.com/api/v1/health
```

`/api/v1/health` reports the database and OCR status. If OCR is down, **keep scanning** —
the photos are stored regardless and the admin can re-run OCR afterwards with
**Re-read** on each lead, or you can type the fields from the photo.

---

## Scaling, if you ever need to

The bottleneck is OCR: roughly 5–10 seconds per card on 2 CPUs, since each photo is read
six times. For a very busy stall:

- raise the `ocr` CPU limit in `docker-compose.yml`
- or send `level=fast` from the API to halve the preprocessing passes
- or run a second `ocr` replica and let nginx round-robin between them

None of this affects the phones — they queue and upload in the background, so staff never
wait on OCR regardless.
