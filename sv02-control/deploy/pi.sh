#!/usr/bin/env bash
# Update the app on the Pi from a laptop checkout, over SSH.
#
#   deploy/pi.sh inspect  user@octopi.local   # read-only: what is on the Pi now
#   deploy/pi.sh deploy   user@octopi.local   # back up, copy, install, restart
#   deploy/pi.sh rollback user@octopi.local   # restore the newest backup
#
# Needs key-based SSH (no password prompts). Works from Git Bash on Windows:
# files go over as a tar stream, so rsync is not required.
#
# The Pi's .env is never copied over or deleted: it holds the API key and
# passwords. Deploy refuses to continue unless the backup exists, and rolls
# back by itself if the new version does not come up.
set -euo pipefail

cmd=${1:-}
target=${2:-}
if [[ -z $cmd || -z $target ]]; then
  sed -n '2,13p' "$0"
  exit 2
fi

here=$(cd "$(dirname "$0")/.." && pwd)
ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10)
remote() { ssh "${ssh_opts[@]}" "$target" "$@"; }

# Where the service runs from, so the new files land in the same place.
app_dir() {
  local dir
  dir=$(remote "systemctl show -p WorkingDirectory --value sv02-control 2>/dev/null" || true)
  if [[ -z $dir ]]; then
    echo "Could not find the sv02-control service's WorkingDirectory on the Pi." >&2
    exit 1
  fi
  echo "$dir"
}

case $cmd in
inspect)
  remote 'bash -s' <<'EOF'
echo "== Who and where";      whoami; hostname; uptime -p
echo "== Node";               node -v 2>&1
echo "== Dashboard service";  systemctl is-active sv02-control; systemctl show -p WorkingDirectory -p User --value sv02-control
dir=$(systemctl show -p WorkingDirectory --value sv02-control)
echo "== Settings present (names only)"
[ -f "$dir/.env" ] && grep -oE '^[A-Z_]+=' "$dir/.env" | tr -d '=' | tr '\n' ' '; echo
echo "== OctoPrint URL the dashboard uses"; grep -E '^OCTOPRINT_URL=' "$dir/.env" 2>/dev/null
echo "== Klipper / Moonraker services"
for s in klipper moonraker; do printf '%-10s active=%s enabled=%s\n' "$s" "$(systemctl is-active $s 2>/dev/null)" "$(systemctl is-enabled $s 2>/dev/null)"; done
echo "== Serial devices"; ls -l /dev/ttyUSB* /dev/ttyACM* /dev/serial/by-id/* 2>/dev/null || echo "none - printer not detected over USB"
echo "== What holds the serial port"
for d in /dev/ttyUSB* /dev/ttyACM*; do [ -e "$d" ] && { echo "$d:"; sudo -n fuser -v "$d" 2>&1 || echo "  (nothing, or sudo needs a password)"; }; done
echo "== OctoPrint's saved serial settings"
f=$(ls ~/.octoprint/config.yaml /home/*/.octoprint/config.yaml 2>/dev/null | head -1)
[ -n "$f" ] && sed -n '/^serial:/,/^[a-z]/p' "$f" | head -20
echo "== Recent dashboard log"; journalctl -u sv02-control -n 15 --no-pager 2>/dev/null | tail -15
EOF
  ;;

deploy)
  dir=$(app_dir)
  stamp=$(date +%Y%m%d-%H%M%S)
  backup="$dir.backup-$stamp"
  echo "Deploying to $target:$dir (backup: $backup)"

  echo "== 1/6 Back up the app and .env"
  remote "set -e; [ -f '$dir/.env' ] || { echo 'No .env on the Pi - refusing to deploy.'; exit 1; }
          cp -a '$dir' '$backup'; cp -a '$dir/.env' ~/sv02-env-backup-$stamp
          [ -f '$backup/.env' ] && echo 'backup ok'"

  echo "== 2/6 Stop the service"
  remote "sudo -n systemctl stop sv02-control"

  echo "== 3/6 Copy the new version (excluding .env, node_modules, data)"
  tar -C "$here" -cf - \
      --exclude=./.env --exclude=./node_modules --exclude=./data \
      --exclude=./demo/dist --exclude=./sv02-control.service . \
    | remote "tar -C '$dir' -xf -"

  rollback_now() {
    echo "!! $1 - restoring the backup"
    remote "set -e; sudo -n systemctl stop sv02-control || true
            rm -rf '$dir'; cp -a '$backup' '$dir'; sudo -n systemctl start sv02-control"
    echo "Restored $backup. The previous version is running again."
    exit 1
  }

  echo "== 4/6 Install dependencies on the Pi, and add any new settings"
  remote "set -e; cd '$dir'; npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3
          for key in ATTACH_PHOTOS STALL_MINUTES; do
            grep -q \"^\$key=\" .env || { grep -E \"^#? ?\$key=\" .env.example | head -1 | sed 's/^# \\?//' >> .env; echo \"added \$key\"; }
          done" || rollback_now "npm install failed"

  echo "== 5/6 Start it and wait for it to answer"
  remote "sudo -n systemctl start sv02-control"
  port=$(remote "grep -E '^PORT=' '$dir/.env' | cut -d= -f2" || true)
  port=${port:-8088}
  ok=
  for _ in $(seq 1 15); do
    if remote "curl -sf -m 3 http://localhost:$port/api/health" >/dev/null 2>&1; then ok=1; break; fi
    sleep 2
  done
  [[ -n $ok ]] || rollback_now "the new version did not come up"
  remote "curl -s http://localhost:$port/api/health"; echo

  echo "== 6/6 Connection check (a disconnected printer shows as a failure here; that is not a deploy fault)"
  remote "cd '$dir' && timeout 60 npm run -s check" || true

  echo
  echo "Deployed. Backup kept at $backup"
  ;;

rollback)
  dir=$(app_dir)
  backup=$(remote "ls -d '$dir'.backup-* 2>/dev/null | sort | tail -1")
  [[ -n $backup ]] || { echo "No backup found next to $dir."; exit 1; }
  echo "Restoring $backup"
  remote "set -e; sudo -n systemctl stop sv02-control; rm -rf '$dir'; cp -a '$backup' '$dir'; sudo -n systemctl start sv02-control; systemctl is-active sv02-control"
  ;;

*)
  echo "Unknown command: $cmd (use inspect, deploy or rollback)" >&2
  exit 2
  ;;
esac
