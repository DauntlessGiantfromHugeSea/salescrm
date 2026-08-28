# Betrieb

## Erstinstallation

Voraussetzungen: Server mit Docker, eigene Domain, DNS-A-Record zeigt auf den
Server, Ports 80 und 443 offen.

```bash
git clone <repository> /opt/salescrm
cd /opt/salescrm

cp .env.example .env

# Schlüssel erzeugen und in die .env eintragen
openssl rand -hex 32      # → ENCRYPTION_KEY
openssl rand -base64 48   # → SESSION_SECRET
openssl rand -base64 24   # → POSTGRES_PASSWORD

# .env vollständig ausfüllen (siehe Kommentare in der Datei)
nano .env

docker compose up -d
docker compose logs -f api
```

Der erste Start dauert einige Minuten: Images bauen, Migrationen laufen, Caddy
holt das Zertifikat. Danach ist `https://IHRE-DOMAIN` erreichbar.

Erste Anmeldung mit der Adresse aus `BOOTSTRAP_ADMIN_EMAIL` – dieses Konto wird
automatisch Administrator.

## Der historische Erstimport

Der Import der Altbestände ist ein eigener Vorgang mit eigener Abnahme, kein
Nebenprodukt des Nachtlaufs.

```bash
# Was ist erfasst?
docker compose exec api npm run import -w @salescrm/api -- --list

# Ein einzelnes Postfach importieren (beobachtbar)
docker compose exec api npm run import -w @salescrm/api -- --mailbox info@example.de

# Alle aktivierten Postfächer
docker compose exec api npm run import -w @salescrm/api -- --all
```

Erfahrungswerte für ein Postfach mit 24 Monaten Historie:

| Umfang | Dauer |
|---|---|
| ~5.000 Mails | 20–40 Minuten |
| ~20.000 Mails | 2–4 Stunden |
| ~50.000 Mails | 6–12 Stunden |

Die Spanne kommt von der Drosselung durch Microsoft. Der Import wartet die von
Graph vorgegebene Zeit ab und läuft dann weiter – ein `429` im Log ist normal
und kein Fehler.

**Empfohlene Reihenfolge:**

1. Ein Postfach importieren, Ergebnis ansehen: stimmen Firmen, Kontakte, Rollen?
2. `INTERNAL_EMAIL_DOMAINS` nachschärfen, falls Kollegen als Kunden auftauchen
3. Bucket D abarbeiten (Dubletten)
4. Erst dann die restlichen Postfächer

## Projekte anlegen

Ein Projekt zieht die vorhandene Mailhistorie automatisch nach. Damit das
funktioniert, gehört beim Anlegen hinein:

- die **Projektnummer** genau in der Schreibweise, die im Mailbetreff steht
- unter *Weitere Bezeichnungen* alles, wie der Kunde das Vorhaben nennt
  (Bauvorhabenname, Kundenprojektnummer)
- Beteiligte mit ihren Rollen, sobald bekannt

Nach dem Anlegen läuft die Nachzuordnung im Hintergrund. Über
**Kommunikation → Weitere Mails suchen** lässt sie sich erneut anstoßen –
sinnvoll, nachdem Beteiligte ergänzt wurden.

## Sicherung

Die Datenbank enthält alles, was nicht aus Microsoft 365 nachladbar ist:
Vorgänge, Projekte, Rollen, Entwürfe, Protokoll.

```bash
# Tägliche Sicherung, 30 Tage Aufbewahrung
cat > /etc/cron.daily/salescrm-backup <<'SCRIPT'
#!/bin/sh
cd /opt/salescrm
docker compose exec -T db pg_dump -U salescrm salescrm | gzip \
  > "/opt/salescrm/backups/salescrm-$(date +%F).sql.gz"
find /opt/salescrm/backups -name 'salescrm-*.sql.gz' -mtime +30 -delete
SCRIPT
chmod +x /etc/cron.daily/salescrm-backup
```

Zusätzlich sichern – ohne diese Datei ist die Sicherung wertlos:

```bash
cp /opt/salescrm/.env /sicherer-ort/salescrm.env
```

`ENCRYPTION_KEY` daraus entschlüsselt die Microsoft-Tokens. Ohne ihn müssen sich
nach einer Wiederherstellung alle Benutzer neu anmelden.

Rückspielen:

```bash
gunzip -c backups/salescrm-2026-08-01.sql.gz \
  | docker compose exec -T db psql -U salescrm salescrm
```

## Aktualisieren

```bash
cd /opt/salescrm
git pull
docker compose build
docker compose up -d
```

Migrationen laufen automatisch vor dem Start von API und Worker. Der Worker
bekommt 120 Sekunden, um laufende Jobs zu beenden – ein Import wird nicht
mitten im Lauf abgeschnitten.

## Überwachung

Im Dashboard unter **Einstellungen → Systemstatus**:

- Wann lief der letzte Priorisierungslauf?
- Wann wurde welches Postfach zuletzt abgeglichen?
- Stehen Fehler an?

Auf dem Server:

```bash
docker compose ps
docker compose logs --tail=200 worker
curl -s https://IHRE-DOMAIN/api/health
```

### Was regelmäßig zu prüfen ist

| Was | Wann | Warum |
|---|---|---|
| Ablauf des Clientschlüssels | im Kalender vormerken | Läuft er ab, steht alles still |
| Bucket D | wöchentlich | Sonst wachsen Dubletten |
| Postfachstatus | monatlich | Fehler fallen sonst nicht auf |
| Sicherung zurückspielen | halbjährlich | Eine ungeprüfte Sicherung ist keine |

## Störungen

**Morgens keine neuen Vorgänge.**
Systemstatus prüfen. Steht bei `mail:inbox` ein Fehler? Häufigste Ursache: die
Microsoft-Anmeldung ist abgelaufen (nach etwa 90 Tagen Inaktivität) – ein Login
im Dashboard behebt das.

**Ein Postfach meldet „Fehler".**
Bei `ErrorAccessDenied`: das Postfach steht nicht in der Sicherheitsgruppe der
Zugriffsrichtlinie. Aufnehmen, bis zu eine Stunde warten, dann
*Jetzt abgleichen*.

**Entwürfe werden nicht erzeugt.**
`ANTHROPIC_API_KEY` prüfen und im Worker-Log nach `KI-Aufruf fehlgeschlagen`
suchen. Bei erschöpftem Kontingent laufen alle anderen Funktionen weiter.

**Mails landen im falschen Projekt.**
Im Projekt unter *Kommunikation* auf **Lösen** klicken, dann im richtigen
Projekt zuordnen – das wirkt auf den ganzen Verlauf. Wenn es öfter vorkommt:
prüfen, ob zwei Projekte dieselben Beteiligten haben und dem einen ein
eindeutiger Alias fehlt.

**Der Erstimport bricht ab.**
Er ist so gebaut, dass ein erneuter Aufruf dort weitermacht, wo er stehen
geblieben ist. Einfach nochmal starten.

**Termine lassen sich nicht anlegen.**
Meist fehlt `OnlineMeetings.ReadWrite`. Unter *Einstellungen → Microsoft 365*
steht, welche Berechtigungen fehlen.

## Regeln anpassen

Alles über die `.env`, ohne Codeänderung:

```
RULE_FOLLOW_UP_DAYS=14         # Tage bis ein Follow-up fällig wird
RULE_REACTIVATION_DAYS=180     # ab wann ein Kontakt reaktivierbar ist
MAX_AUTO_DRAFTS_PER_RUN=15     # Kostenbremse für die KI
AUTO_GENERATE_FOLLOWUP_DRAFTS  # Entwürfe vorproduzieren, ja/nein
CRON_DAILY_SCAN                # wann der Tageslauf startet (UTC!)
```

Nach Änderungen: `docker compose up -d api worker`

> Die Cron-Angaben sind **UTC**. Deutschland liegt im Winter eine, im Sommer
> zwei Stunden davor. `30 4 * * 1-5` bedeutet also 5:30 im Winter und 6:30 im
> Sommer.

## Einen Kollegen aufnehmen

1. Der Kollege meldet sich unter `https://IHRE-DOMAIN` mit seinem
   Microsoft-Konto an. Sein Konto entsteht dabei automatisch.
2. Sein persönliches Postfach wird ab dann gelesen; der Erstimport startet.
3. In den Projekten, an denen er mitarbeitet, wird er unter **Team**
   hinzugefügt – ab dann sieht er alle Vorgänge und den Schriftverkehr dieser
   Projekte.

Ist `ALLOWED_LOGIN_EMAILS` gesetzt, muss seine Adresse vorher dort eingetragen
werden.

Es gibt keinen Datenbankumbau für weitere Personen – das Owner-Feld und die
Rollen sind von Anfang an vorhanden.
