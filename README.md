# Akquisesystem

Akquise- und Projektsystem für ein Ingenieurbüro im Bauwesen. Läuft auf einem
eigenen Server unter eigener Domain, liest die Firmenpostfächer über Microsoft
365, führt Bauprojekte mit allen Beteiligten, schlägt täglich vor, wer
nachzufassen ist, und schreibt dafür Mailentwürfe – **versendet wird nichts ohne
ausdrückliche Freigabe.**

## Was es tut

**Bauprojekte.** Jedes Vorhaben mit Projektnummer, Beteiligten und deren Rollen
(Bauherr, Architekt, Statiker, Bauleitung …), dem internen Team und dem gesamten
Schriftverkehr. Mails finden ihr Projekt automatisch – über die Projektnummer im
Betreff, den Mailverlauf oder die bekannten Beteiligten.

**Kontakte.** Jede Person mit ihrer Rolle in jedem Projekt und dem vollständigen
Schriftwechsel aus allen Firmenpostfächern. Die Antwort auf „wie stehen wir zu
diesem Menschen" vor dem nächsten Anruf.

**Tagesübersicht.** Vier Blöcke: A Follow-up, B Reaktivierung, C Kaltakquise,
D Prüfen. Jeder Eintrag trägt die Begründung, warum er heute dasteht.

**Entwürfe.** Die KI schreibt einen Vorschlag auf Grundlage der echten
Vorgangshistorie. Der Mensch liest, ändert, gibt frei. Erst dann geht die Mail
aus der echten Mailbox raus.

**Teams.** Termin direkt aus dem Vorgang, Zeitvorschläge aus dem echten
Kalender, öffentliche Buchungsseite für Kunden, nach dem Gespräch eine Notiz
aus dem Transkript.

## Einstieg

| Ich will … | Dokument |
|---|---|
| Microsoft 365 einrichten | [docs/AZURE_SETUP.md](docs/AZURE_SETUP.md) |
| installieren und betreiben | [docs/BETRIEB.md](docs/BETRIEB.md) |
| verstehen, wie es funktioniert | [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md) |
| wissen, was als Nächstes kommt | [docs/ROADMAP.md](docs/ROADMAP.md) |

## Schnellstart

```bash
cp .env.example .env
openssl rand -hex 32       # → ENCRYPTION_KEY
openssl rand -base64 48    # → SESSION_SECRET
nano .env                  # ausfüllen, Kommentare beachten

docker compose up -d
```

Dann `https://IHRE-DOMAIN` öffnen und mit dem Microsoft-Konto anmelden.

## Entwicklung

```bash
npm install
npx prisma generate --schema apps/api/prisma/schema.prisma
npm run db:migrate:dev -w @salescrm/api

npm run dev -w @salescrm/api    # API auf :3000
npm run dev -w @salescrm/web    # Dashboard auf :5173
npm run worker -w @salescrm/api # Hintergrundjobs

npm test          # Tests
npm run typecheck # Typen
```

## Aufbau

```
packages/shared/   Domänenlogik ohne Abhängigkeiten: Regelwerk für offene
                   Vorgänge, Projektzuordnung, gemeinsame Typen. Hier stehen
                   die Tests, weil hier die Entscheidungen fallen.

apps/api/          Fastify-API und Worker
  graph/           Microsoft Graph: Auth, Mail, Kontakte, Kalender, Teams, Planner
  domain/          Regelwerk, Import, Dubletten, Projektzuordnung, Buchung
  ai/              Entwürfe, Klassifikation, Besprechungsnotizen
  routes/          HTTP-Endpunkte
  jobs/            Warteschlange, Worker, Zeitpläne

apps/web/          React-Dashboard und öffentliche Buchungsseite
```

## Grundsätze im Code

Drei Regeln, die überall durchgehalten werden:

1. **Nichts wird ohne Freigabe versendet.** Vier unabhängige Sperren verhindern
   das; Details in [docs/ARCHITEKTUR.md](docs/ARCHITEKTUR.md).
2. **Unsicheres wird markiert, nicht geändert.** Dubletten werden vorgeschlagen,
   nicht zusammengeführt. Mehrdeutige Zuordnungen landen in der Prüfliste,
   statt geraten zu werden.
3. **Nachvollziehbarkeit.** Jeder Vorgang in der Tagesübersicht trägt die
   Begründung der Regel-Engine. Jede automatische Projektzuordnung zeigt, worauf
   sie beruht. Jede Freigabe steht im Protokoll.
