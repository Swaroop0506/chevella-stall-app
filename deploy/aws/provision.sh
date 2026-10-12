#!/usr/bin/env bash
# Provisions the stall app on a single EC2 instance.
#
#   DOMAIN=stall.chevellafarms.com ADMIN_EMAIL=you@chevellafarms.com deploy/aws/provision.sh
#
# One instance running docker compose, not ECS or RDS. For a system that runs hard for
# three days a year, a managed database and a container orchestrator would roughly triple
# the bill and add two more things to debug at 9am on the morning of the show.
#
# Safe to re-run: every resource is looked up by name first and reused if it already
# exists. Only the instance itself is created unconditionally, and the script refuses if
# one is already running under the same tag.

set -euo pipefail

REGION="${REGION:-ap-south-1}"
NAME="${NAME:-chevella-stall}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.medium}"
VOLUME_GB="${VOLUME_GB:-30}"
DOMAIN="${DOMAIN:-}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@chevellafarms.com}"
REPO="${REPO:-https://github.com/Swaroop0506/chevella-stall-app.git}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_DIR="$HOME/.ssh"
KEY_PATH="$KEY_DIR/$NAME.pem"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '  \033[36m•\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

aws_() { aws --region "$REGION" "$@"; }

# ------------------------------------------------------------------ preflight

command -v aws >/dev/null || die "AWS CLI not installed"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || die "No AWS credentials. Run 'aws configure' first."

bold "Deploying $NAME"
info "account $ACCOUNT, region $REGION, $INSTANCE_TYPE, ${VOLUME_GB}GB"
[ -n "$DOMAIN" ] && info "domain $DOMAIN" || info "no domain — HTTP only, /scan camera will not work"

# Refuse to build a second one by accident.
EXISTING="$(aws_ ec2 describe-instances \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text)"
if [ -n "$EXISTING" ]; then
  die "An instance tagged $NAME already exists ($EXISTING). Terminate it first, or set NAME=."
fi

# ------------------------------------------------------------------ network

VPC_ID="$(aws_ ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)"
[ "$VPC_ID" = "None" ] && die "No default VPC in $REGION. Create one, or set VPC_ID by hand."
SUBNET_ID="$(aws_ ec2 describe-subnets --filters "Name=vpc-id,Values=$VPC_ID" \
  --query 'Subnets[?MapPublicIpOnLaunch==`true`]|[0].SubnetId' --output text)"
[ "$SUBNET_ID" = "None" ] && die "No public subnet found in $VPC_ID"
ok "vpc $VPC_ID / subnet $SUBNET_ID"

SG_ID="$(aws_ ec2 describe-security-groups --filters "Name=group-name,Values=$NAME-sg" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)"

if [ "$SG_ID" = "None" ] || [ -z "$SG_ID" ]; then
  SG_ID="$(aws_ ec2 create-security-group --group-name "$NAME-sg" \
    --description "Chevella stall app" --vpc-id "$VPC_ID" --query GroupId --output text)"

  # SSH is restricted to the IP running this script. Everything else is a public web
  # service and has to be open.
  MY_IP="$(curl -fsS --max-time 5 https://checkip.amazonaws.com || echo "")"
  if [ -n "$MY_IP" ]; then
    aws_ ec2 authorize-security-group-ingress --group-id "$SG_ID" \
      --protocol tcp --port 22 --cidr "${MY_IP%$'\n'}/32" >/dev/null
    info "SSH limited to ${MY_IP%$'\n'}/32"
  else
    info "could not determine your IP — SSH left closed, use EC2 Instance Connect"
  fi

  for port in 80 443; do
    aws_ ec2 authorize-security-group-ingress --group-id "$SG_ID" \
      --protocol tcp --port "$port" --cidr 0.0.0.0/0 >/dev/null
  done
  ok "created security group $SG_ID (22 from your IP, 80+443 open)"
else
  ok "reusing security group $SG_ID"
fi

# ------------------------------------------------------------------ key pair

mkdir -p "$KEY_DIR"
if ! aws_ ec2 describe-key-pairs --key-names "$NAME" >/dev/null 2>&1; then
  aws_ ec2 create-key-pair --key-name "$NAME" --query KeyMaterial --output text > "$KEY_PATH"
  chmod 400 "$KEY_PATH"
  ok "created key pair, private key saved to $KEY_PATH"
else
  [ -f "$KEY_PATH" ] || info "key pair $NAME exists in AWS but $KEY_PATH is missing locally"
  ok "reusing key pair $NAME"
fi

# ------------------------------------------------------------------ image

# Canonical publish the current Ubuntu AMI ids as SSM public parameters, which is more
# reliable than grepping describe-images and never goes stale.
AMI_ID="$(aws_ ssm get-parameters \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text)"
[ -z "$AMI_ID" ] || [ "$AMI_ID" = "None" ] && die "Could not resolve the Ubuntu 24.04 AMI"
ok "ubuntu 24.04 ami $AMI_ID"

# ------------------------------------------------------------------ launch

USER_DATA="$(mktemp)"
trap 'rm -f "$USER_DATA"' EXIT
sed -e "s|__DOMAIN__|$DOMAIN|g" \
    -e "s|__ADMIN_EMAIL__|$ADMIN_EMAIL|g" \
    -e "s|^REPO=.*|REPO=\"$REPO\"|" \
    "$HERE/bootstrap.sh" > "$USER_DATA"

INSTANCE_ID="$(aws_ ec2 run-instances \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$NAME" \
  --security-group-ids "$SG_ID" \
  --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":$VOLUME_GB,\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true,\"Encrypted\":true}}]" \
  --metadata-options "HttpTokens=optional,HttpEndpoint=enabled" \
  --user-data "file://$USER_DATA" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=app,Value=chevella-stall}]" \
  --query 'Instances[0].InstanceId' --output text)"
ok "launched $INSTANCE_ID"

aws_ ec2 wait instance-running --instance-ids "$INSTANCE_ID"

# ------------------------------------------------------------------ elastic ip
#
# A stable address matters more here than usual: it is what the DNS record points at, and
# the DNS name is baked into every printed QR code. A reboot must not change it.

ALLOC_ID="$(aws_ ec2 describe-addresses --filters "Name=tag:Name,Values=$NAME" \
  --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo None)"
if [ "$ALLOC_ID" = "None" ] || [ -z "$ALLOC_ID" ]; then
  ALLOC_ID="$(aws_ ec2 allocate-address --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" \
    --query AllocationId --output text)"
fi
aws_ ec2 associate-address --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID" >/dev/null
PUBLIC_IP="$(aws_ ec2 describe-addresses --allocation-ids "$ALLOC_ID" \
  --query 'Addresses[0].PublicIp' --output text)"
ok "elastic ip $PUBLIC_IP"

# ------------------------------------------------------------------ done

echo
bold "Instance is up — now provisioning itself"
echo "  instance   $INSTANCE_ID"
echo "  address    $PUBLIC_IP"
echo "  ssh        ssh -i $KEY_PATH ubuntu@$PUBLIC_IP"
echo
if [ -n "$DOMAIN" ]; then
  bold "Next: point DNS at it"
  echo "  Add this record at your DNS provider, then wait for it to propagate:"
  echo
  echo "      $DOMAIN.    A    $PUBLIC_IP"
  echo
  echo "  Caddy issues the HTTPS certificate automatically once the record resolves."
fi
echo "  The first boot builds the OCR image and downloads the PP-OCRv5 weights,"
echo "  so give it 8-12 minutes. Watch it with:"
echo
echo "      ssh -i $KEY_PATH ubuntu@$PUBLIC_IP 'sudo tail -f /var/log/cloud-init-output.log'"
echo
echo "  Admin credentials are written to /root/CREDENTIALS.txt on the instance."
