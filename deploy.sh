#!/usr/bin/env bash
#
# Einrichtung und Aktualisierung auf dem eigenen Server.
#
#   ./deploy.sh demo    – Demo-Modus: läuft ohne Microsoft-Mandanten, mit Beispieldaten
#   ./deploy.sh setup   – Produktivbetrieb einrichten (fragt die Angaben ab)
#   ./deploy.sh update  – neuen Stand ausrollen
#   ./deploy.sh status  – Zustand prüfen
#
# Das Skript ändert nichts ohne Rückfrage und überschreibt keine vorhandene .env.

set -euo pipefail

cd "$(dirname "$0")"

BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'

info()  { printf '%s\n' "  $*"; }
step()  { printf '\n%s%s%s\n' "$BOLD" "$*" "$RESET"; }
ok()    { printf '%s  ✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '%s  !%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail()  { printf '%s  ✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@"
  else docker-compose "$@"; fi
}

check_prerequisites() {
  step "Voraussetzungen"

  command -v docker >/dev/null 2>&1 || fail \
    "Docker fehlt. Installation: curl -fsSL https://get.docker.com | sh"
  ok "Docker $(docker --version | sed 's/Docker version //;s/,.*//')"

  docker compose version >/dev/null 2>&1 || docker-compose version >/dev/null 2>&1 || fail \
    "Docker Compose fehlt. Installation: apt install docker-compose-plugin"
  ok "Docker Compose vorhanden"

  docker info >/dev/null 2>&1 || fail \
    "Der Docker-Dienst läuft nicht. Starten mit: systemctl start docker"
  ok "Docker-Dienst läuft"

  # Unter 2 GB RAM bricht der Build der Anwendung reproduzierbar ab.
  local mem_mb
  mem_mb=$(free -m 2>/dev/null | awk '/^Mem:/ {print $2}' || echo 0)
  if [ "$mem_mb" -gt 0 ] && [ "$mem_mb" -lt 1900 ]; then
    warn "Nur ${mem_mb} MB Arbeitsspeicher. Der Build braucht etwa 2 GB – ggf. Swap einrichten."
  else
    ok "Arbeitsspeicher ausreichend"
  fi

  local free_gb
  free_gb=$(df -BG --output=avail . 2>/dev/null | tail -1 | tr -dc '0-9' || echo 0)
  if [ "$free_gb" -gt 0 ] && [ "$free_gb" -lt 10 ]; then
    warn "Nur ${free_gb} GB frei. Images und Datenbank brauchen Platz."
  else
    ok "Speicherplatz ausreichend"
  fi
}

# Läuft auf diesem Server bereits etwas auf Port 80 oder 443?
# Dann darf dieser Stack keinen eigenen Reverse Proxy starten – sonst
# scheitert entweder der Start oder, schlimmer, ein laufender Dienst wird gestört.
detect_existing_proxy() {
  local occupant=''

  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE ':(80|443)\s'; then
    occupant='ein Dienst'
  fi

  # Wenn es ein Container ist, gleich den Namen nennen – das erspart Sucherei.
  local container
  container=$(docker ps --format '{{.Names}}\t{{.Ports}}' 2>/dev/null \
    | grep -E ':(80|443)->' | awk '{print $1}' | head -1 || true)
  [ -n "$container" ] && occupant="der Container ${BOLD}${container}${RESET}"

  if [ -n "$occupant" ]; then
    EXISTING_PROXY="$occupant"
    return 0
  fi
  EXISTING_PROXY=''
  return 1
}

# Sucht einen freien Port ab dem angegebenen Startwert.
find_free_port() {
  local port="$1"
  while ss -ltn 2>/dev/null | grep -qE ":${port}\s"; do
    port=$((port + 1))
  done
  printf '%s' "$port"
}

generate_secrets() {
  # Erzeugt die drei Schlüssel, die niemand von Hand ausdenken sollte.
  ENCRYPTION_KEY=$(openssl rand -hex 32)
  SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')
  POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '\n/+=')
}

write_env() {
  local mode="$1"

  if [ -f .env ]; then
    warn "Es gibt bereits eine .env – sie bleibt unverändert."
    info "Zum Neuanlegen erst sichern und entfernen: mv .env .env.alt"
    return
  fi

  generate_secrets

  WEB_PORT=$(find_free_port 8090)
  API_PORT=$(find_free_port $((WEB_PORT + 1)))

  if [ "$mode" = "demo" ]; then
    step "Konfiguration für den Demo-Modus"

    if detect_existing_proxy; then
      info "Auf Port 80/443 läuft bereits ${EXISTING_PROXY}."
      info "Dieser Stack startet deshalb keinen eigenen Reverse Proxy und ist"
      info "zunächst nur lokal auf Port ${WEB_PORT} erreichbar."
      base_url="http://127.0.0.1:${WEB_PORT}"
      site_address=""
    else
      read -rp "  Domain oder IP, unter der das Dashboard erreichbar ist [localhost]: " host
      host="${host:-localhost}"
      if [ "$host" = "localhost" ] || [[ "$host" =~ ^[0-9.]+$ ]]; then
        base_url="http://${host}"
        site_address=":80"
        warn "Für eine IP-Adresse gibt es kein TLS-Zertifikat: der Zugriff läuft unverschlüsselt."
        warn "Zum Ausprobieren in Ordnung, für echte Daten nicht."
      else
        base_url="https://${host}"
        site_address="${host}"
      fi
    fi
    host="${host:-127.0.0.1}"

    cat > .env <<ENV
# Demo-Modus – erzeugt von deploy.sh am $(date '+%F %T')
# ACHTUNG: In dieser Betriebsart ist eine Anmeldung ohne Microsoft möglich.
# Nicht für den Produktivbetrieb. Umstellung mit: ./deploy.sh setup

NODE_ENV=development
DEMO_MODE=true
DEMO_USER_EMAIL=demo@example.de

DOMAIN=${host}
SITE_ADDRESS=${site_address}
ACME_EMAIL=demo@example.de
PUBLIC_BASE_URL=${base_url}
WEB_PORT=${WEB_PORT}
API_PORT=${API_PORT}
LOG_LEVEL=info

POSTGRES_USER=salescrm
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=salescrm

ENCRYPTION_KEY=${ENCRYPTION_KEY}
SESSION_SECRET=${SESSION_SECRET}

# Im Demo-Modus leer – ohne diese Angaben werden keine Postfächer gelesen.
MS_TENANT_ID=
MS_CLIENT_ID=
MS_CLIENT_SECRET=
MS_REDIRECT_URI=
MS_APP_ONLY_ENABLED=false
ANTHROPIC_API_KEY=

RULE_FOLLOW_UP_DAYS=14
RULE_REACTIVATION_DAYS=180
IMPORT_MONTHS_BACK=24
IMPORT_MAIL_FOLDERS=inbox,sentitems
INTERNAL_EMAIL_DOMAINS=
AUTO_GENERATE_FOLLOWUP_DRAFTS=false
MAX_AUTO_DRAFTS_PER_RUN=15
CRON_NIGHTLY_SYNC=0 3 * * *
CRON_DAILY_SCAN=30 4 * * 1-5
CRON_TRANSCRIPT_FETCH=0 * * * *
ENV
    ok ".env für den Demo-Modus angelegt"
    return
  fi

  step "Konfiguration für den Produktivbetrieb"
  info "Die Microsoft-Angaben stammen aus der App-Registrierung (docs/AZURE_SETUP.md)."
  echo

  read -rp "  Domain (z. B. akquise.beispiel.de): " domain
  [ -n "$domain" ] || fail "Ohne Domain kein TLS-Zertifikat."

  if detect_existing_proxy; then
    info ""
    info "Auf Port 80/443 läuft bereits ${EXISTING_PROXY}."
    info "Dieser Stack startet deshalb keinen eigenen Reverse Proxy. Nach dem"
    info "Start wird der Eintrag angezeigt, der in den vorhandenen Proxy gehört."
    site_address=""
    acme_email="verwaltet-vom-vorhandenen-proxy@localhost"
  else
    site_address="$domain"
    read -rp "  E-Mail für Let's-Encrypt-Benachrichtigungen: " acme_email
  fi
  read -rp "  Verzeichnis-ID (Mandant): " ms_tenant
  read -rp "  Anwendungs-ID (Client): " ms_client
  read -rsp "  Geheimer Clientschlüssel: " ms_secret; echo
  read -rsp "  Anthropic API-Schlüssel: " ai_key; echo
  read -rp "  Mailadresse des ersten Administrators: " admin_email
  read -rp "  Eigene Maildomains, kommagetrennt (z. B. beispiel.de): " internal_domains

  echo
  info "Firmenweiter Postfachzugriff:"
  info "  nein = nur die Postfächer der Personen, die sich selbst anmelden"
  info "  ja   = zusätzlich gemeinsame Postfächer und Postfächer ohne eigenen Zugang"
  info "         (braucht Admin-Zustimmung und eine ApplicationAccessPolicy)"
  read -rp "  Firmenweiten Zugriff aktivieren? [j/N]: " want_app_only
  if [[ "$want_app_only" =~ ^[jJyY] ]]; then
    app_only=true
    read -rp "  Sicherheitsgruppe der Zugriffsrichtlinie (z. B. AkquiseSystem-Postfaecher): " mailbox_group
  else
    app_only=false
    mailbox_group=""
  fi

  for value in "$ms_tenant" "$ms_client" "$ms_secret" "$ai_key" "$admin_email"; do
    [ -n "$value" ] || fail "Alle Angaben sind erforderlich."
  done

  if [ -z "$internal_domains" ]; then
    warn "Ohne eigene Maildomains landen die Kolleginnen und Kollegen als vermeintliche Kunden im System."
  fi

  cat > .env <<ENV
# Produktivbetrieb – erzeugt von deploy.sh am $(date '+%F %T')

NODE_ENV=production
DEMO_MODE=false

DOMAIN=${domain}
SITE_ADDRESS=${site_address}
ACME_EMAIL=${acme_email}
PUBLIC_BASE_URL=https://${domain}
WEB_PORT=${WEB_PORT}
API_PORT=${API_PORT}
LOG_LEVEL=info

POSTGRES_USER=salescrm
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_DB=salescrm

ENCRYPTION_KEY=${ENCRYPTION_KEY}
SESSION_SECRET=${SESSION_SECRET}
BOOTSTRAP_ADMIN_EMAIL=${admin_email}
ALLOWED_LOGIN_EMAILS=

MS_TENANT_ID=${ms_tenant}
MS_CLIENT_ID=${ms_client}
MS_CLIENT_SECRET=${ms_secret}
MS_REDIRECT_URI=https://${domain}/api/auth/callback
# Firmenweiter Postfachzugriff. Ohne ApplicationAccessPolicy im Exchange
# hätte die Anwendung Zugriff auf jedes Postfach der Organisation –
# siehe docs/AZURE_SETUP.md Abschnitt 4.
MS_APP_ONLY_ENABLED=${app_only}
MS_MAILBOX_GROUP=${mailbox_group}

ANTHROPIC_API_KEY=${ai_key}
AI_MODEL_DRAFTING=claude-sonnet-5
AI_MODEL_CLASSIFY=claude-haiku-4-5-20251001

RULE_FOLLOW_UP_DAYS=14
RULE_REACTIVATION_DAYS=180
RULE_MIN_EMAILS_FOR_CONTACT=3

IMPORT_MONTHS_BACK=24
IMPORT_MAIL_FOLDERS=inbox,sentitems
INTERNAL_EMAIL_DOMAINS=${internal_domains}

CRON_NIGHTLY_SYNC=0 3 * * *
CRON_DAILY_SCAN=30 4 * * 1-5
CRON_TRANSCRIPT_FETCH=0 * * * *

AUTO_GENERATE_FOLLOWUP_DRAFTS=true
MAX_AUTO_DRAFTS_PER_RUN=15
ENV

  chmod 600 .env
  ok ".env angelegt (nur für root lesbar)"
  warn "Diese Datei sichern! Ohne ENCRYPTION_KEY sind die gespeicherten Microsoft-Tokens verloren."
}

check_dns() {
  local domain
  domain=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)
  [ "$domain" = "localhost" ] && return 0
  [[ "$domain" =~ ^[0-9.]+$ ]] && return 0

  step "DNS"
  local resolved server_ip
  resolved=$(getent hosts "$domain" 2>/dev/null | awk '{print $1}' | head -1 || true)
  server_ip=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '')

  if [ -z "$resolved" ]; then
    warn "$domain löst nicht auf. Ohne A-Record schlägt die Zertifikatsausstellung fehl."
  elif [ -n "$server_ip" ] && [ "$resolved" != "$server_ip" ]; then
    warn "$domain zeigt auf $resolved, dieser Server ist $server_ip."
  else
    ok "$domain zeigt auf diesen Server"
  fi
}

start_stack() {
  step "Bauen und starten"
  info "Der erste Build dauert einige Minuten."
  compose build

  # SITE_ADDRESS ist leer, wenn ein fremder Reverse Proxy die Ports hält.
  # Dann bleibt das Profil "standalone" aus und kein eigener Caddy startet.
  if grep -qE '^SITE_ADDRESS=.+' .env; then
    compose --profile standalone up -d
    ok "Dienste gestartet, eigener Reverse Proxy aktiv"
  else
    compose up -d
    ok "Dienste gestartet, ohne eigenen Reverse Proxy"
  fi
}

# Gibt den Eintrag aus, der in den bereits vorhandenen Reverse Proxy gehört.
print_proxy_snippet() {
  grep -qE '^SITE_ADDRESS=.+' .env && return 0

  local domain web_port
  domain=$(grep -E '^DOMAIN=' .env | cut -d= -f2-)
  web_port=$(grep -E '^WEB_PORT=' .env | cut -d= -f2-)

  step "Eintrag für den vorhandenen Reverse Proxy"
  info "Auf diesem Server läuft bereits ein Proxy auf Port 80/443. Dieser Stack"
  info "lauscht auf 127.0.0.1:${web_port}. Damit das Dashboard unter der Domain"
  info "erreichbar wird, gehört dieser Block in dessen Konfiguration:"
  echo
  cat <<SNIPPET
${BOLD}Caddy${RESET} (Caddyfile, danach: docker exec <caddy-container> caddy reload --config /etc/caddy/Caddyfile)

${domain} {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
	}
	reverse_proxy 127.0.0.1:${web_port}
}

${BOLD}nginx${RESET}

server {
	listen 443 ssl http2;
	server_name ${domain};
	# ssl_certificate ...;
	location / {
		proxy_pass http://127.0.0.1:${web_port};
		proxy_set_header Host \$host;
		proxy_set_header X-Real-IP \$remote_addr;
		proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto \$scheme;
	}
}
SNIPPET
  echo
  warn "Der Proxy muss auch /api weiterleiten – der Block oben deckt beides ab."
  warn "Läuft der Proxy selbst im Container, ist 127.0.0.1 aus dessen Sicht"
  warn "nicht der Host. Dann stattdessen host.docker.internal oder die Docker-Bridge-IP"
  warn "(meist 172.17.0.1) eintragen."
}

wait_for_health() {
  step "Warten, bis die Anwendung antwortet"
  local i
  for i in $(seq 1 60); do
    if compose exec -T api node -e \
      "fetch('http://localhost:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
      ok "Anwendung antwortet"
      return 0
    fi
    sleep 3
  done
  warn "Keine Antwort nach 3 Minuten. Protokoll ansehen: ./deploy.sh logs"
  return 1
}

show_status() {
  step "Zustand"
  compose ps
  echo
  local base_url web_port
  base_url=$(grep -E '^PUBLIC_BASE_URL=' .env | cut -d= -f2-)
  web_port=$(grep -E '^WEB_PORT=' .env | cut -d= -f2- || echo '')
  info "Dashboard: ${base_url}"
  if ! grep -qE '^SITE_ADDRESS=.+' .env; then
    info "Lokal erreichbar: http://127.0.0.1:${web_port} (über den vorhandenen Proxy veröffentlichen)"
  fi
  if grep -q '^DEMO_MODE=true' .env; then
    warn "Demo-Modus aktiv – Anmeldung ohne Microsoft möglich, keine echten Daten."
  fi
}

case "${1:-}" in
  demo)
    check_prerequisites
    write_env demo
    start_stack
    wait_for_health || true
    step "Beispieldaten anlegen"
    compose exec -T api node apps/api/dist/scripts/demoData.js \
      || warn "Beispieldaten konnten nicht angelegt werden – die Anwendung läuft trotzdem."
    show_status
    print_proxy_snippet
    printf '\n%sFertig.%s Im Dashboard auf „Ohne Microsoft ansehen" klicken.\n\n' "$BOLD" "$RESET"
    ;;

  setup)
    check_prerequisites
    write_env production
    check_dns
    start_stack
    wait_for_health || true
    show_status
    print_proxy_snippet
    printf '\n%sFertig.%s Mit dem Microsoft-Konto des Administrators anmelden.\n' "$BOLD" "$RESET"
    printf 'Danach: Einstellungen → Systemstatus prüfen, dann den Erstimport starten\n'
    printf '(siehe docs/BETRIEB.md).\n\n'
    ;;

  update)
    step "Aktualisieren"
    git pull --ff-only
    compose build
    compose up -d
    wait_for_health || true
    show_status
    ;;

  policy)
    # Erzeugt die Exchange-Befehle, die den Zugriff der Anwendung auf die
    # freigegebenen Postfächer begrenzen. Ohne sie liest die Anwendung jedes
    # Postfach der Organisation.
    [ -f .env ] || fail "Keine .env gefunden. Erst ./deploy.sh setup ausführen."
    client_id=$(grep -E '^MS_CLIENT_ID=' .env | cut -d= -f2-)
    group=$(grep -E '^MS_MAILBOX_GROUP=' .env | cut -d= -f2-)
    [ -n "$client_id" ] || fail "MS_CLIENT_ID ist nicht gesetzt."

    step "Zugriffsrichtlinie einrichten"
    info "Diese Befehle in der Exchange Online PowerShell ausführen"
    info "(auf einem Windows-Rechner oder per: Install-Module ExchangeOnlineManagement)."
    echo
    cat <<POLICY
Connect-ExchangeOnline

# 1. Sicherheitsgruppe anlegen und NUR die Postfächer aufnehmen, die das
#    Akquisesystem lesen darf. Alles, was nicht drin steht, bleibt unerreichbar.
New-DistributionGroup -Name "${group:-AkquiseSystem-Postfaecher}" -Type Security

Add-DistributionGroupMember -Identity "${group:-AkquiseSystem-Postfaecher}" -Member info@IHRE-DOMAIN
Add-DistributionGroupMember -Identity "${group:-AkquiseSystem-Postfaecher}" -Member angebote@IHRE-DOMAIN
# ... je Postfach eine Zeile

# 2. Zugriff der Anwendung auf diese Gruppe begrenzen.
New-ApplicationAccessPolicy \
  -AppId ${client_id} \
  -PolicyScopeGroupId "${group:-AkquiseSystem-Postfaecher}" \
  -AccessRight RestrictAccess \
  -Description "Akquisesystem darf nur die freigegebenen Postfaecher lesen"

# 3. Prüfen: das erste muss "Granted" liefern, das zweite "Denied".
Test-ApplicationAccessPolicy -Identity info@IHRE-DOMAIN -AppId ${client_id}
Test-ApplicationAccessPolicy -Identity geschaeftsfuehrung@IHRE-DOMAIN -AppId ${client_id}
POLICY
    echo
    warn "Die Richtlinie braucht bis zu einer Stunde, bis sie greift."
    warn "Erst danach MS_APP_ONLY_ENABLED=true setzen – vorher sieht die Anwendung mehr, als sie soll."
    ;;

  doctor)
    step "Diagnose"

    info "Stand: $(git log --oneline -1 2>/dev/null || echo unbekannt)"
    info "Betriebsart: $(grep -E '^DEMO_MODE=' .env 2>/dev/null || echo 'keine .env gefunden')"
    info "Adresse: $(grep -E '^PUBLIC_BASE_URL=' .env 2>/dev/null | cut -d= -f2-)"
    info "Web-Port: $(grep -E '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2-)"

    step "Container"
    compose ps -a

    step "Migrationen"
    # Der häufigste Grund für eine nicht startende API: die Migration lief nicht
    # durch, und api wartet auf deren Erfolg.
    compose logs --tail=25 migrate 2>&1 || info "kein migrate-Container"

    step "API"
    compose logs --tail=40 api 2>&1 || info "kein api-Container"

    step "Erreichbarkeit"
    # Kein "local" – das ist außerhalb einer Funktion nicht zulässig.
    web_port=$(grep -E '^WEB_PORT=' .env 2>/dev/null | cut -d= -f2- || echo 8090)
    printf '  Dashboard  '
    curl -sS -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${web_port}/" 2>&1 || echo 'nicht erreichbar'
    printf '  API        '
    curl -sS -w ' (%{http_code})\n' "http://127.0.0.1:${web_port}/api/health/demo" 2>&1 || echo 'nicht erreichbar'

    step "Datenbank"
    compose exec -T db psql -U salescrm -d salescrm -c \
      'select count(*) as projekte from "Project";' 2>&1 \
      || info 'Datenbank nicht erreichbar oder Tabellen fehlen (Migration nicht gelaufen)'

    printf '\n%sDiese Ausgabe vollständig kopieren – daraus lässt sich die Ursache ablesen.%s\n\n' "$BOLD" "$RESET"
    ;;

  status)  show_status ;;
  logs)    compose logs --tail=100 -f "${2:-}" ;;
  stop)    compose down; ok "Gestoppt" ;;

  backup)
    mkdir -p backups
    file="backups/salescrm-$(date +%F-%H%M).sql.gz"
    compose exec -T db pg_dump -U salescrm salescrm | gzip > "$file"
    ok "Gesichert: $file"
    warn "Die .env gehört mitgesichert – sonst ist die Sicherung nicht verwendbar."
    ;;

  *)
    cat <<USAGE
${BOLD}Akquisesystem – Einrichtung${RESET}

  ./deploy.sh demo     Zum Ansehen: läuft ohne Microsoft-Mandanten, mit Beispieldaten
  ./deploy.sh setup    Produktivbetrieb einrichten
  ./deploy.sh update   Neuen Stand ausrollen
  ./deploy.sh status   Zustand anzeigen
  ./deploy.sh doctor   Diagnose bei Störungen: Container, Migrationen, Protokolle
  ./deploy.sh policy   Exchange-Befehle für die Postfach-Zugriffsrichtlinie ausgeben
  ./deploy.sh logs     Protokoll verfolgen (optional: logs api | worker | db)
  ./deploy.sh backup   Datenbank sichern
  ./deploy.sh stop     Alles anhalten

Zum Ausprobieren mit ${BOLD}demo${RESET} beginnen – dafür wird kein Microsoft-Mandant gebraucht.
USAGE
    ;;
esac
