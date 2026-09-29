#!/usr/bin/env bash
# NEW hosts only. Never source or copy Executor01 state, environment or credentials.
set -euo pipefail
set +x
umask 077

fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }
[[ ${EUID} -eq 0 ]] || fail 'ROOT_REQUIRED'
[[ $# -eq 4 ]] || fail 'Usage: bootstrap-new-shard.sh executor-02 PUBLIC_IPV4 REGION ACME_EMAIL'
shard=$1; ipv4=$2; region=$3; email=$4
[[ $shard =~ ^executor-[0-9]{2,4}$ && $shard != executor-01 && $shard != executor-00 ]] || fail 'NEW_SHARD_REQUIRED'
[[ $ipv4 =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && $ipv4 != 46.101.104.48 ]] || fail 'EXECUTOR01_FORBIDDEN'
[[ $region =~ ^[A-Za-z0-9-]{2,30}$ && $email =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || fail 'INVALID_REGION_OR_EMAIL'
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(uname -m) == x86_64 ]] || fail 'UBUNTU_24_04_AMD64_REQUIRED'
env_file=/etc/coinops/live-executor.env
if [[ -e $env_file ]]; then
  [[ ! -L $env_file && $(stat -c %u "$env_file") == 0 && $(stat -c %a "$env_file") == 600 ]] || fail 'PRIVATE_ROOT_ENV_REQUIRED'
  [[ $(awk -F= '$1=="COINOPS_EXECUTOR_SHARD_ID"{print $2}' "$env_file") == "$shard" ]] || fail 'EXISTING_SHARD_ID_MISMATCH'
  [[ $(awk -F= '$1=="LIVE_EXECUTOR_EGRESS_IP"{print $2}' "$env_file") == "$ipv4" ]] || fail 'EXISTING_SHARD_IP_MISMATCH'
else
  [[ ! -e /opt/coinops/source && ! -e /var/lib/coinops-live-executor && ! -e /etc/coinops/account-registry.json ]] || fail 'HOST_NOT_EMPTY'
fi
command -v curl >/dev/null || fail 'CURL_REQUIRED_FOR_PREFLIGHT'
[[ $(curl -4fsS --max-time 10 https://api.ipify.org) == "$ipv4" ]] || fail 'EGRESS_IP_MISMATCH'
[[ -s /root/.ssh/authorized_keys ]] || fail 'AUTHORIZED_ROOT_SSH_KEY_REQUIRED'
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl xz-utils git nginx python3-venv ufw
timedatectl set-ntp true
# Canonical release assets travel together; bootstrap never invents a profile.
asset_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
node_version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["node_version"].removeprefix("v"))' "$asset_dir/fleet-release.json")
[[ $node_version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'FLEET_NODE_VERSION_REQUIRED'
node_root=/opt/coinops/node-v${node_version}-linux-x64
install -d -m 755 /opt/coinops /opt/coinops/releases /var/www/coinops-acme
if [[ ! -x $node_root/bin/node ]]; then
  download=$(mktemp -d /opt/coinops/node-download.XXXXXX)
  curl -fSL --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz" -o "$download/node.tar.xz"
  curl -fSL --proto '=https' --tlsv1.2 "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$download/SHASUMS256.txt"
  expected=$(awk -v file="node-v${node_version}-linux-x64.tar.xz" '$2==file{print $1}' "$download/SHASUMS256.txt")
  [[ $expected =~ ^[a-f0-9]{64}$ ]] || fail 'NODE_CHECKSUM_MISSING'
  [[ $(sha256sum "$download/node.tar.xz" | cut -d' ' -f1) == "$expected" ]] || fail 'NODE_CHECKSUM_MISMATCH'
  tar -xJf "$download/node.tar.xz" -C /opt/coinops
  chown -R root:root "$node_root"
fi
[[ $($node_root/bin/node --version) == v${node_version} ]] || fail 'NODE_VERSION_MISMATCH'
ln -sfn "$node_root/bin/node" /usr/local/bin/node
if ! id coinops-executor >/dev/null 2>&1; then useradd --system --home-dir /var/lib/coinops-live-executor --shell /usr/sbin/nologin coinops-executor; fi
install -d -o root -g coinops-executor -m 750 /etc/coinops
install -d -o coinops-executor -g coinops-executor -m 700 /var/lib/coinops-live-executor
if [[ ! -e $env_file ]]; then
  # Only this new shard's HMAC is generated; never printed or copied from a sibling.
  hmac=$(/usr/local/bin/node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("hex"))')
  printf '%s\n' "COINOPS_EXECUTOR_SHARD_ID=$shard" "LIVE_EXECUTOR_EGRESS_IP=$ipv4" \
    "COINOPS_EXECUTOR_REGION=$region" 'COINOPS_EXECUTOR_STATE_DIR=/var/lib/coinops-live-executor' \
    'COINOPS_EXECUTOR_REGISTRY_PATH=/etc/coinops/account-registry.json' \
    "COINOPS_EXECUTOR_HMAC_SECRET=$hmac" 'COINOPS_EXECUTOR_LEGACY_COMPAT=false' \
    'COINOPS_EXECUTOR_VERSION=not-deployed' 'TRADING_ENABLED=true' 'KILL_SWITCH=OFF' 'PORT=8080' > "$env_file"
  unset hmac
  chown root:root "$env_file"; chmod 600 "$env_file"
fi
if [[ ! -e /etc/coinops/account-registry.json ]]; then
  printf '{"version":1,"executor_shard_id":"%s","engines":[],"credentials":{}}\n' "$shard" > /etc/coinops/account-registry.json
  chown root:coinops-executor /etc/coinops/account-registry.json
  chmod 640 /etc/coinops/account-registry.json
fi
asset_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -m 644 "$asset_dir/coinops-shard-executor.service" /etc/systemd/system/coinops-live-executor.service
install -m 644 "$asset_dir/certbot-renew.service" /etc/systemd/system/coinops-certbot-renew.service
install -m 644 "$asset_dir/certbot-renew.timer" /etc/systemd/system/coinops-certbot-renew.timer
install -m 644 "$asset_dir/sshd-coinops.conf" /etc/ssh/sshd_config.d/00-coinops.conf
sshd -t
systemctl reload ssh
ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp
ufw --force enable
python3 -m venv /opt/coinops-certbot
/opt/coinops-certbot/bin/pip install --disable-pip-version-check 'certbot==5.8.0'
if [[ ! -e /etc/letsencrypt/live/$ipv4/fullchain.pem ]]; then
  printf 'server { listen 80; server_name %s; root /var/www/coinops-acme; location /.well-known/acme-challenge/ { try_files $uri =404; } location / { return 503; } }\n' "$ipv4" > /etc/nginx/sites-available/coinops-shard
  ln -sfn /etc/nginx/sites-available/coinops-shard /etc/nginx/sites-enabled/coinops-shard
  nginx -t; systemctl enable --now nginx; systemctl reload nginx
  /opt/coinops-certbot/bin/certbot certonly --non-interactive --agree-tos --email "$email" \
    --webroot -w /var/www/coinops-acme --ip-address "$ipv4" --cert-name "$ipv4" \
    --required-profile shortlived --preferred-challenges http --keep-until-expiring
fi
sed "s/__EGRESS_IPV4__/$ipv4/g" "$asset_dir/shard-nginx.conf.template" > /etc/nginx/sites-available/coinops-shard
ln -sfn /etc/nginx/sites-available/coinops-shard /etc/nginx/sites-enabled/coinops-shard
nginx -t; systemctl reload nginx
systemctl daemon-reload
systemctl enable coinops-live-executor
systemctl enable --now coinops-certbot-renew.timer
printf 'BOOTSTRAP_COMPLETE shard=%s ip=%s runtime=Node%s; verify registry and deploy a reviewed main SHA next.\n' "$shard" "$ipv4" "$node_version"
printf 'NEW_SHARD_NOT_READY: deploy the common fleet-release.json target and require FLEET_PARITY_PASS before onboarding.\n'
printf 'ADMISSION_BLOCKED_UNTIL_CERTIFIED: run capacity-preflight.mjs --record from the authorized control plane; SQL verifies policy, runtime, telemetry and Watchdog before admission.\n'
