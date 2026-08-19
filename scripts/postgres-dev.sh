#!/usr/bin/env bash
# Entorno local reproducible de PostgreSQL para prime-board.
# No acepta contraseñas como argumentos: usa PB_PG_PASSWORD o un prompt oculto.
set -euo pipefail

PB_PG_CONTAINER="${PB_PG_CONTAINER:-prime-board-postgres}"
PB_PG_NETWORK="${PB_PG_NETWORK:-prime-board}"
PB_PG_VOLUME="${PB_PG_VOLUME:-prime-board-pgdata}"
PB_PG_SECRET="${PB_PG_SECRET:-prime-board-pg-password}"
PB_PG_DB="${PB_PG_DB:-primeboard}"
PB_PG_USER="${PB_PG_USER:-primeboard}"
PB_PG_PORT="${PB_PG_PORT:-5432}"
PB_PG_IMAGE="${PB_PG_IMAGE:-docker.io/library/postgres:17}"

usage() {
  cat >&2 <<'EOF'
Uso: scripts/postgres-dev.sh <up|status|check|backup|restore|down>

Variables opcionales: PB_PG_CONTAINER, PB_PG_NETWORK, PB_PG_VOLUME,
PB_PG_SECRET, PB_PG_DB, PB_PG_USER, PB_PG_PORT, PB_PG_IMAGE.
PB_PG_PASSWORD solo se lee desde el entorno o un prompt oculto durante `up`.
PB_PG_BACKUP define el archivo para `backup`/`restore`.
EOF
}

ensure_podman() {
  if podman info >/dev/null 2>&1; then
    return
  fi
  if ! podman machine start >/dev/null 2>&1; then
    echo "No se pudo conectar con Podman; inicia la máquina con: podman machine start" >&2
    exit 1
  fi
}

network_exists() { podman network inspect "$PB_PG_NETWORK" >/dev/null 2>&1; }
volume_exists() { podman volume inspect "$PB_PG_VOLUME" >/dev/null 2>&1; }
secret_exists() { podman secret inspect "$PB_PG_SECRET" >/dev/null 2>&1; }
container_exists() { podman container exists "$PB_PG_CONTAINER"; }

validate_config() {
  case "$PB_PG_USER" in
    ''|*[!A-Za-z0-9_]*|[0-9]*) echo "PB_PG_USER debe ser un identificador PostgreSQL simple" >&2; exit 2 ;;
  esac
  case "$PB_PG_DB" in
    ''|*[!A-Za-z0-9_]*|[0-9]*) echo "PB_PG_DB debe ser un identificador PostgreSQL simple" >&2; exit 2 ;;
  esac
  case "$PB_PG_PORT" in
    ''|*[!0-9]*) echo "PB_PG_PORT debe ser numérico" >&2; exit 2 ;;
  esac
}

ensure_secret() {
  if secret_exists; then
    return
  fi
  local password="${PB_PG_PASSWORD:-}"
  if [[ -z "$password" ]]; then
    if [[ ! -t 0 ]]; then
      echo "Falta PB_PG_PASSWORD para crear el secreto en modo no interactivo" >&2
      exit 2
    fi
    read -r -s -p "PostgreSQL password: " password
    printf '\n' >&2
  fi
  if ! printf '%s' "$password" | podman secret create "$PB_PG_SECRET" - >/dev/null; then
    unset password
    echo "No se pudo crear el secreto de PostgreSQL" >&2
    exit 1
  fi
  unset password
}

wait_ready() {
  local attempt
  for attempt in $(seq 1 60); do
    if podman exec "$PB_PG_CONTAINER" pg_isready -U "$PB_PG_USER" -d "$PB_PG_DB" >/dev/null 2>&1; then
      echo "PostgreSQL listo: ${PB_PG_CONTAINER} (127.0.0.1:${PB_PG_PORT})"
      return
    fi
    sleep 1
  done
  echo "PostgreSQL no alcanzó estado ready" >&2
  podman inspect --format '{{.State.Status}} {{.State.Health.Status}}' "$PB_PG_CONTAINER" >&2 || true
  exit 1
}

up() {
  ensure_podman
  if ! network_exists; then
    podman network create "$PB_PG_NETWORK" >/dev/null
  fi
  if ! volume_exists; then
    podman volume create "$PB_PG_VOLUME" >/dev/null
  fi
  ensure_secret

  if container_exists; then
    podman start "$PB_PG_CONTAINER" >/dev/null 2>&1 || true
    wait_ready
    return
  fi

  podman run --detach --name "$PB_PG_CONTAINER" \
    --network "$PB_PG_NETWORK" \
    --publish "127.0.0.1:${PB_PG_PORT}:5432" \
    --restart unless-stopped \
    --health-cmd "pg_isready -U ${PB_PG_USER} -d ${PB_PG_DB}" \
    --health-interval 10s --health-timeout 5s --health-retries 6 \
    --secret "${PB_PG_SECRET},type=mount" \
    --env "POSTGRES_USER=${PB_PG_USER}" \
    --env "POSTGRES_DB=${PB_PG_DB}" \
    --env "POSTGRES_PASSWORD_FILE=/run/secrets/${PB_PG_SECRET}" \
    --volume "${PB_PG_VOLUME}:/var/lib/postgresql/data" \
    "$PB_PG_IMAGE" >/dev/null
  wait_ready
}

status() {
  ensure_podman
  if ! container_exists; then
    echo "PostgreSQL no está creado: ${PB_PG_CONTAINER}"
    return 1
  fi
  podman inspect --format 'container={{.Name}} status={{.State.Status}} health={{.State.Health.Status}} image={{.Config.Image}}' "$PB_PG_CONTAINER"
}

check() {
  ensure_podman
  wait_ready
  if podman exec --user postgres "$PB_PG_CONTAINER" psql \
    --username="$PB_PG_USER" --dbname="$PB_PG_DB" --tuples-only --no-align --command 'SELECT 1' | grep -qx '1'; then
    echo "PostgreSQL query check: OK"
  else
    echo "PostgreSQL query check: FAILED" >&2
    exit 1
  fi
}

backup() {
  ensure_podman
  wait_ready
  local destination="${PB_PG_BACKUP:-}"
  if [[ -z "$destination" ]]; then
    echo "Define PB_PG_BACKUP con la ruta del dump" >&2
    exit 2
  fi
  umask 077
  podman exec --user postgres "$PB_PG_CONTAINER" pg_dump \
    --username="$PB_PG_USER" --dbname="$PB_PG_DB" --format=custom > "$destination"
  echo "Backup escrito en ${destination}"
}

restore() {
  ensure_podman
  wait_ready
  local source="${PB_PG_BACKUP:-}"
  if [[ -z "$source" || ! -f "$source" ]]; then
    echo "PB_PG_BACKUP debe apuntar a un dump existente" >&2
    exit 2
  fi
  podman exec --user postgres --interactive "$PB_PG_CONTAINER" pg_restore \
    --clean --if-exists --no-owner --username="$PB_PG_USER" --dbname="$PB_PG_DB" < "$source"
  echo "Restore completado desde ${source}"
}

down() {
  ensure_podman
  if container_exists; then
    podman stop "$PB_PG_CONTAINER" >/dev/null
    echo "PostgreSQL detenido: ${PB_PG_CONTAINER}"
  fi
}

command="${1:-}"
validate_config
case "$command" in
  up) up ;;
  status) status ;;
  check) check ;;
  backup) backup ;;
  restore) restore ;;
  down) down ;;
  *) usage; exit 2 ;;
esac
