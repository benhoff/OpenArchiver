#!/usr/bin/env bash
set -euo pipefail

# Run this from the source OpenArchiver repo after stopping the source stack.
#
# Defaults are set for the current planned migration:
#   source: current machine/repo
#   target: hoff@arch
#   target path: /home/hoff/swdev/OpenArchiver
#   frontend port on target: 3004
#
# Override any default with environment variables, for example:
#   TARGET=hoff@arch TARGET_PORT=3004 ./scripts/migrate-to-host.sh

TARGET="${TARGET:-hoff@arch}"
DEST="${DEST:-/home/hoff/swdev/OpenArchiver}"
TARGET_PORT="${TARGET_PORT:-3004}"
TARGET_APP_URL="${TARGET_APP_URL:-http://localhost:${TARGET_PORT}}"
REMOTE_BACKUP_ROOT="${REMOTE_BACKUP_ROOT:-${DEST}/.migration-backups}"
VOLUMES="${VOLUMES:-openarchiver_pgdata openarchiver_meilidata openarchiver_valkeydata}"
OVERWRITE_REMOTE="${OVERWRITE_REMOTE:-0}"
ALLOW_SOURCE_RUNNING="${ALLOW_SOURCE_RUNNING:-0}"
START_REMOTE="${START_REMOTE:-1}"
BUILD_REMOTE="${BUILD_REMOTE:-1}"
KEEP_LOCAL_BACKUP="${KEEP_LOCAL_BACKUP:-1}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-/tmp/openarchiver-migration-${TIMESTAMP}}"
REMOTE_BACKUP_DIR="${REMOTE_BACKUP_ROOT}/${TIMESTAMP}"
ARCHIVE_IMAGE="${ARCHIVE_IMAGE:-postgres:17-alpine}"

log() {
	printf '\n[%s] %s\n' "$(date +%H:%M:%S)" "$*"
}

fail() {
	printf '\nERROR: %s\n' "$*" >&2
	exit 1
}

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

quote_single() {
	printf "%s" "$1" | sed "s/'/'\\\\''/g"
}

set_env_key() {
	local file="$1"
	local key="$2"
	local value="$3"
	local tmp="${file}.tmp"

	awk -v key="$key" -v value="$value" '
		BEGIN { done = 0 }
		$0 ~ "^[[:space:]]*" key "=" {
			print key "=" value
			done = 1
			next
		}
		{ print }
		END {
			if (!done) {
				print key "=" value
			}
		}
	' "$file" >"$tmp"
	mv "$tmp" "$file"
}

require_cmd docker
require_cmd rsync
require_cmd ssh

cd "$REPO_ROOT"

[[ -f docker-compose.yml ]] || fail "Run this from the OpenArchiver repo root."
[[ -f .env ]] || fail "Missing .env in repo root. The migration needs it."

log "Checking local Docker Compose state"
if running_services="$(docker compose ps --services --status running 2>/dev/null)" && [[ -n "$running_services" ]]; then
	if [[ "$ALLOW_SOURCE_RUNNING" != "1" ]]; then
		fail "Source stack still has running services: ${running_services//$'\n'/, }. Stop it with 'docker compose down' or set ALLOW_SOURCE_RUNNING=1."
	fi
	log "ALLOW_SOURCE_RUNNING=1 set; continuing even though source services are running."
fi

log "Checking target host prerequisites on ${TARGET}"
ssh "$TARGET" bash -s <<'REMOTE_PREREQS'
set -euo pipefail

missing=0

if ! command -v docker >/dev/null 2>&1; then
	echo "Missing remote prerequisite: docker" >&2
	missing=1
fi

if command -v docker >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
	echo "Missing remote prerequisite: docker compose plugin" >&2
	missing=1
fi

if ! command -v rsync >/dev/null 2>&1; then
	echo "Missing remote prerequisite: rsync" >&2
	missing=1
fi

if [[ "$missing" == "1" ]]; then
	echo "Install the missing package(s) on the target host, then re-run this script." >&2
	exit 1
fi
REMOTE_PREREQS

log "Creating local backup directory: ${LOCAL_BACKUP_DIR}"
mkdir -p "$LOCAL_BACKUP_DIR"

log "Preparing target directories"
ssh "$TARGET" "mkdir -p '$(quote_single "$DEST")' '$(quote_single "$REMOTE_BACKUP_DIR")'"

log "Stopping any existing target stack at ${DEST}"
ssh "$TARGET" "if [ -f '$(quote_single "$DEST")/docker-compose.yml' ]; then cd '$(quote_single "$DEST")' && docker compose down; fi"

log "Archiving Docker volumes"
for volume in $VOLUMES; do
	if ! docker volume inspect "$volume" >/dev/null 2>&1; then
		fail "Local Docker volume not found: $volume"
	fi
	log "Archiving volume ${volume}"
	docker run --rm \
		-v "${volume}:/volume:ro" \
		-v "${LOCAL_BACKUP_DIR}:/backup" \
		"$ARCHIVE_IMAGE" \
		sh -c "cd /volume && tar czf '/backup/${volume}.tgz' ."
done

log "Copying repository worktree to ${TARGET}:${DEST}"
RSYNC_EXCLUDES=(
	"--exclude=node_modules"
	"--exclude=**/node_modules"
	"--exclude=dist"
	"--exclude=**/dist"
	"--exclude=packages/frontend/.svelte-kit"
	"--exclude=packages/frontend/build"
	"--exclude=docs/.vitepress/cache"
	"--exclude=docs/.vitepress/dist"
	"--exclude=.migration-backups"
)

STORAGE_LOCAL_ROOT_PATH="$(
	awk -F= '/^[[:space:]]*STORAGE_LOCAL_ROOT_PATH=/ {
		value = $2
		for (i = 3; i <= NF; i++) value = value "=" $i
		gsub(/^["'\'']|["'\'']$/, "", value)
		print value
		exit
	}' .env
)"
if [[ -z "$STORAGE_LOCAL_ROOT_PATH" ]]; then
	STORAGE_LOCAL_ROOT_PATH="/var/data/open-archiver"
fi

if [[ "$STORAGE_LOCAL_ROOT_PATH" == "$REPO_ROOT"* ]]; then
	storage_relative="${STORAGE_LOCAL_ROOT_PATH#"$REPO_ROOT"/}"
	if [[ -n "$storage_relative" && "$storage_relative" != "$STORAGE_LOCAL_ROOT_PATH" ]]; then
		RSYNC_EXCLUDES+=("--exclude=${storage_relative}")
	fi
fi

rsync -aH --delete --info=progress2 "${RSYNC_EXCLUDES[@]}" "${REPO_ROOT}/" "${TARGET}:${DEST}/"

log "Writing target .env with PORT_FRONTEND=${TARGET_PORT} and APP_URL=${TARGET_APP_URL}"
TARGET_ENV="${LOCAL_BACKUP_DIR}/target.env"
cp "${REPO_ROOT}/.env" "$TARGET_ENV"
set_env_key "$TARGET_ENV" "PORT_FRONTEND" "$TARGET_PORT"
set_env_key "$TARGET_ENV" "APP_URL" "$TARGET_APP_URL"
set_env_key "$TARGET_ENV" "ORIGIN" "$TARGET_APP_URL"
rsync -a "$TARGET_ENV" "${TARGET}:${DEST}/.env"

log "Copying Docker volume archives to target"
rsync -aH --info=progress2 "${LOCAL_BACKUP_DIR}/" "${TARGET}:${REMOTE_BACKUP_DIR}/"

log "Restoring Docker volumes on target"
for volume in $VOLUMES; do
	log "Restoring volume ${volume}"
	ssh "$TARGET" bash -s -- "$volume" "${REMOTE_BACKUP_DIR}/${volume}.tgz" "$OVERWRITE_REMOTE" "$ARCHIVE_IMAGE" <<'REMOTE_RESTORE'
set -euo pipefail

volume="$1"
archive_path="$2"
overwrite="$3"
archive_image="$4"
archive_dir="$(dirname "$archive_path")"
archive_name="$(basename "$archive_path")"

docker volume create "$volume" >/dev/null

if docker run --rm -v "${volume}:/volume:ro" "$archive_image" sh -c 'test -n "$(ls -A /volume 2>/dev/null)"'; then
	if [[ "$overwrite" != "1" ]]; then
		echo "Remote volume ${volume} already contains data. Re-run with OVERWRITE_REMOTE=1 to replace it." >&2
		exit 1
	fi
	docker run --rm -v "${volume}:/volume" "$archive_image" sh -c 'find /volume -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
fi

docker run --rm \
	-v "${volume}:/volume" \
	-v "${archive_dir}:/backup:ro" \
	"$archive_image" \
	sh -c "cd /volume && tar xzf '/backup/${archive_name}'"
REMOTE_RESTORE
done

if [[ -d "$STORAGE_LOCAL_ROOT_PATH" ]]; then
	log "Copying local storage path to target: ${STORAGE_LOCAL_ROOT_PATH}"
	ssh "$TARGET" "mkdir -p '$(quote_single "$STORAGE_LOCAL_ROOT_PATH")'"
	rsync -aH --delete --info=progress2 "${STORAGE_LOCAL_ROOT_PATH}/" "${TARGET}:${STORAGE_LOCAL_ROOT_PATH}/"
else
	log "Storage path does not exist locally, skipping: ${STORAGE_LOCAL_ROOT_PATH}"
fi

if [[ "$BUILD_REMOTE" == "1" ]]; then
	log "Building OpenArchiver image on target"
	ssh "$TARGET" "cd '$(quote_single "$DEST")' && docker compose build open-archiver"
fi

if [[ "$START_REMOTE" == "1" ]]; then
	log "Starting OpenArchiver on target"
	ssh "$TARGET" "cd '$(quote_single "$DEST")' && docker compose up -d"
	log "Target status"
	ssh "$TARGET" "cd '$(quote_single "$DEST")' && docker compose ps"
fi

cat <<EOF

Migration copy completed.

Target repo: ${TARGET}:${DEST}
Target UI port: ${TARGET_PORT}
Target APP_URL/ORIGIN: ${TARGET_APP_URL}
Remote backup archives: ${TARGET}:${REMOTE_BACKUP_DIR}
Local backup archives: ${LOCAL_BACKUP_DIR}

If you want to access the UI from a different machine, remember docker-compose.yml
currently binds the frontend to 127.0.0.1 on the target host.
Use an SSH tunnel like:

  ssh -L ${TARGET_PORT}:127.0.0.1:${TARGET_PORT} ${TARGET}

Then open:

  http://localhost:${TARGET_PORT}

EOF

if [[ "$KEEP_LOCAL_BACKUP" != "1" ]]; then
	log "Removing local backup directory"
	rm -rf "$LOCAL_BACKUP_DIR"
fi
