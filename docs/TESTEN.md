# Testen

Drei Stufen, aufeinander aufbauend. Stufe 1 braucht **keinen** Microsoft-Mandanten –
damit lässt sich das System ansehen, bevor die IT irgendetwas einrichtet.

---

## Stufe 1: Ansehen, ohne Microsoft

Auf dem Server:

```bash
git clone https://github.com/DauntlessGiantfromHugeSea/salescrm.git /opt/salescrm
cd /opt/salescrm
./deploy.sh demo
```

Das Skript prüft die Voraussetzungen, erzeugt die Schlüssel, baut, startet und
legt Beispieldaten an. Beim ersten Mal dauert der Build einige Minuten.

Danach im Browser die angezeigte Adresse öffnen und auf
**„Ohne Microsoft ansehen"** klicken.

### Wenn auf dem Server schon etwas läuft

Das Skript prüft, ob die Ports 80 und 443 bereits belegt sind. Ist das der Fall
– etwa durch einen vorhandenen Caddy oder nginx –, startet dieser Stack **keinen
eigenen Reverse Proxy**, sondern lauscht nur auf `127.0.0.1` auf einem freien
Port. Zum Schluss gibt das Skript den Konfigurationsblock aus, der in den
vorhandenen Proxy gehört.

Damit stört die Installation nichts, was auf dem Server bereits läuft. Für einen
ersten Blick genügt ein SSH-Tunnel, ganz ohne Änderung am Proxy:

```bash
# auf dem eigenen Rechner
ssh -L 8090:127.0.0.1:8090 root@SERVER
# dann im Browser: http://localhost:8090
```

### Was in dieser Stufe funktioniert

Alles, was ohne Postfach auskommt:

- Tagesübersicht mit den Buckets A–D
- Projektakte: Beteiligte mit Rollen, Team, Schriftverkehr, Vorgänge
- Kontaktakte: Rolle je Projekt, gesamter Schriftwechsel
- Vorgänge bearbeiten, Status ändern, Wiedervorlage setzen
- Entwürfe ansehen und bearbeiten
- Prüfliste: Dubletten zusammenführen, mehrdeutige Zuordnung auflösen
- Excel-Export

### Was nicht funktioniert – und das ist beabsichtigt

Ohne Mandanten gibt es kein Postfach und keinen Kalender:

- Mailabgleich, Kontakt- und Kalenderimport
- Versand freigegebener Entwürfe
- Teams-Termine und Terminvorschläge
- Buchungsseite (sie braucht echte freie Zeiten)

Diese Funktionen melden sich mit einem verständlichen Hinweis, statt
kommentarlos zu scheitern. Ohne `ANTHROPIC_API_KEY` gibt es außerdem keine neu
erzeugten Entwürfe – die beiden Beispielentwürfe sind vorhanden.

Auf jedem Bildschirm steht ein Hinweisbalken, dass es sich um Beispieldaten
handelt und nichts nach außen geht.

### Was dabei zu prüfen ist

Diese Punkte zeigen, ob das System das tut, was es soll:

| Ansicht | Worauf achten |
|---|---|
| Heute | Jeder Eintrag trägt Chips mit der Begründung („Seit 19 Tagen keine Antwort"). Stimmen die Einordnungen? |
| Projekt `…-041` → Beteiligte | Fünf Beteiligte, einer davon gelb markiert: aus dem Mailverkehr erkannt, Rolle noch offen. Rolle setzen und ansehen, ob die Markierung verschwindet |
| Projekt → Kommunikation | Jede Mail zeigt, **warum** sie diesem Projekt zugeordnet wurde: Projektnummer, Mailverlauf, Beteiligte |
| Kontakt „Meike Brandhorst" | Sie steht in zwei Projekten – in einem als Architektin. Genau das kann eine Ordnerstruktur nicht |
| Prüfen | Dublette zusammenführen; danach ist der Eintrag weg und die Historie liegt am verbleibenden Kontakt |
| Entwürfe | Text ändern, dann Freigeben versuchen: das System verlangt erst das Speichern |

### Wieder aufräumen

```bash
./deploy.sh stop
docker compose down -v   # löscht auch die Beispieldaten
```

---

## Stufe 2: Mit einem Testmandanten

Sinnvoll, bevor es an die echten Postfächer geht. Microsoft stellt kostenlose
Entwicklermandanten bereit ([Microsoft 365 Developer Program](https://developer.microsoft.com/microsoft-365/dev-program)),
mit Beispielnutzern und Postfächern.

1. [docs/AZURE_SETUP.md](AZURE_SETUP.md) im Testmandanten durchgehen (Schritte 1–3).
   Schritt 4, der firmenweite Zugriff, bleibt zunächst außen vor.
2. Auf dem Server:

   ```bash
   ./deploy.sh stop
   mv .env .env.demo
   ./deploy.sh setup
   ```

3. Mit dem Testkonto anmelden. Der Erstimport startet automatisch.

### Was hier zu prüfen ist

| Schritt | Erwartung |
|---|---|
| Anmeldung | Microsoft fragt nach Zustimmung, danach landet man im Dashboard |
| Einstellungen → Microsoft 365 | Das Postfach steht da, „Eingeschränkte Funktionen" ist leer |
| Einstellungen → Systemstatus | `mail:inbox` und `contacts` mit Zeitstempel, ohne Fehler |
| Kontakte | Die importierten Adressbuchkontakte sind da |
| Projekt anlegen mit einer Nummer, die in Testmails vorkommt | Die Mails hängen anschließend am Projekt |
| Entwurf erzeugen und freigeben | Die Mail liegt im Postfach unter „Gesendete Elemente" |
| Teams-Termin aus einem Vorgang | Termin im Kalender, Einladung beim Teilnehmer, Vorgang auf „Termin vereinbart" |

---

## Stufe 3: Produktivbetrieb

Erst wenn Stufe 2 durchgelaufen ist.

```bash
./deploy.sh setup
```

Dann **nicht** sofort alle Postfächer aktivieren. Die Reihenfolge aus
[docs/BETRIEB.md](BETRIEB.md):

1. Ein einzelnes Postfach importieren
2. Ergebnis ansehen: stimmen Firmen und Kontakte? Tauchen Kolleginnen und
   Kollegen als vermeintliche Kunden auf? Dann `INTERNAL_EMAIL_DOMAINS`
   nachschärfen und neu importieren
3. Prüfliste abarbeiten
4. Erst dann die übrigen Postfächer

### Abnahmeliste

Was nach dem Ausrollen funktionieren muss:

- [ ] `https://DOMAIN` ist über HTTPS erreichbar, Zertifikat gültig
- [ ] Anmeldung mit dem Firmenkonto
- [ ] Einstellungen → Systemstatus: kein Fehler bei den Postfächern
- [ ] Der nächtliche Lauf ist am Folgetag durchgelaufen (Zeitstempel prüfen)
- [ ] Tagesübersicht enthält plausible Vorgänge mit nachvollziehbarer Begründung
- [ ] Ein Entwurf lässt sich freigeben, die Mail kommt beim Empfänger an
- [ ] Ein Teams-Termin lässt sich anlegen
- [ ] Excel-Export öffnet sich in Excel
- [ ] Eine Sicherung wurde einmal erfolgreich zurückgespielt

---

## Der Demo-Modus im Detail

Er wird über eine einzige Variable geschaltet:

```
DEMO_MODE=true
```

Zwei Sperren verhindern, dass er versehentlich im Produktivbetrieb landet:

1. Zusammen mit `NODE_ENV=production` **verweigert der Prozess den Start** –
   mit einer Meldung, die den Grund nennt.
2. Die Route `/api/auth/demo-login` wird nur registriert, wenn `DEMO_MODE`
   gesetzt ist. Ohne ihn existiert sie nicht.

Beim Umstellen auf den Produktivbetrieb also `NODE_ENV=production` **und**
`DEMO_MODE=false` setzen – `./deploy.sh setup` erledigt beides.

### Beispieldaten erneut anlegen

```bash
docker compose exec api node apps/api/dist/scripts/demoData.js
```

Das Skript legt nichts an, wenn bereits Projekte vorhanden sind. Für einen
sauberen Neustart:

```bash
docker compose down -v && ./deploy.sh demo
```

---

## Ohne Docker entwickeln

Für Änderungen am Code:

```bash
npm install
docker compose up -d db redis          # nur Datenbank und Warteschlange

cp .env.example .env
# DEMO_MODE=true, DATABASE_URL und REDIS_URL auf localhost zeigen lassen

npm run db:migrate:dev -w @salescrm/api
npm run demo:seed -w @salescrm/api

npm run dev -w @salescrm/api           # API auf :3000
npm run dev -w @salescrm/web           # Dashboard auf :5173
npm run worker -w @salescrm/api        # Hintergrundjobs
```

Vor jedem Commit:

```bash
npm test          # Regelwerk und Projektzuordnung
npm run typecheck
npm run build
```
