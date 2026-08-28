# Live gehen

Ablauf vom laufenden Demo-Betrieb zum Produktivbetrieb mit Microsoft-Anmeldung
und allen Firmenpostfächern. Rechne mit einem halben Tag, davon eine Stunde
Wartezeit auf die Zugriffsrichtlinie.

Die Reihenfolge ist wichtig: der firmenweite Zugriff wird **zuletzt**
eingeschaltet, nachdem die Begrenzung nachweislich greift.

---

## 1. Subdomain und Zertifikat

Das System braucht eine eigene Subdomain, z. B. `crm.rss-fb.com`.

- A-Record auf den Server zeigen lassen
- Prüfen: `getent hosts crm.rss-fb.com` muss die Server-IP liefern

Läuft auf dem Server bereits ein Reverse Proxy, bekommt der später einen
zusätzlichen Eintrag; `deploy.sh` gibt ihn nach dem Start aus.

### Wenn der vorhandene Proxy selbst im Container läuft

Aus einem Container heraus zeigt `127.0.0.1` auf den Container selbst, nicht
auf den Server – ein Eintrag auf `127.0.0.1:8090` läuft dort ins Leere.
`deploy.sh` erkennt das Docker-Netz des vorhandenen Proxys und hängt den
Web-Container zusätzlich hinein; der Proxy erreicht ihn dann über den Namen
`salescrm-web`. Das Netz steht anschließend als `PROXY_NETWORK` in der `.env`.

---

## 2. App-Registrierung in Entra ID

Vollständig in [AZURE_SETUP.md](AZURE_SETUP.md), hier nur die Reihenfolge:

1. App-Registrierung `Akquisesystem` anlegen
2. Umleitungs-URI: `https://crm.rss-fb.com/api/auth/callback`
3. Clientschlüssel erzeugen, **Wert sofort kopieren** – er ist nur einmal sichtbar
4. Delegierte Berechtigungen setzen und Administratorzustimmung erteilen

Notieren: Verzeichnis-ID, Anwendungs-ID, Clientschlüssel.

> Das Ablaufdatum des Clientschlüssels gehört in den Kalender. Läuft er ab,
> steht das System ohne Vorwarnung still.

---

## 3. Umstellen auf Produktivbetrieb

```bash
cd /opt/salescrm
git pull
docker compose down

# Demo-Konfiguration beiseitelegen, nicht überschreiben
mv .env .env.demo

./deploy.sh setup
```

Das Skript fragt der Reihe nach ab: Domain, Microsoft-Zugangsdaten,
Anthropic-Schlüssel, Administrator-Mailadresse, eigene Maildomains und ob der
firmenweite Zugriff aktiviert werden soll.

**Der Anthropic-Schlüssel darf leer bleiben.** Ohne ihn laufen Mailimport,
Projektakte, Kontakte, Teams-Termine und Excel-Export vollständig; es entfallen
Mailentwürfe, Besprechungsnotizen und Firmenprofile. Das Dashboard weist an den
betroffenen Stellen darauf hin, statt Fehler zu zeigen. Nachtragen jederzeit:

```bash
# ANTHROPIC_API_KEY in der .env setzen, dann
docker compose up -d api worker
```

**Beim ersten Durchlauf hier „nein" antworten.** Der firmenweite Zugriff kommt
in Schritt 6, nachdem die Begrenzung steht.

Bei den eigenen Maildomains alle eintragen, unter denen im Haus gemailt wird –
sonst legt der Import die Kolleginnen und Kollegen als vermeintliche Kunden an.

### Die Demo-Daten aus der Datenbank entfernen

Sie stehen sonst zwischen den echten Vorgängen:

```bash
docker compose down -v      # löscht das Datenbank-Volume vollständig
docker compose up -d        # legt sie leer neu an, Migrationen laufen automatisch
```

---

## 4. Erste Anmeldung und ein Postfach prüfen

`https://crm.rss-fb.com` öffnen, mit dem Administrator-Konto anmelden.
Microsoft fragt einmalig nach Zustimmung.

Danach unter **Einstellungen**:

| Prüfpunkt | Erwartung |
|---|---|
| Microsoft 365 → Verbundenes Postfach | die eigene Adresse |
| Eingeschränkte Funktionen | leer |
| Systemstatus → `mail:inbox` | Zeitstempel, kein Fehler |

Der Import des eigenen Postfachs läuft ab jetzt im Hintergrund. Fortschritt:

```bash
docker compose logs -f worker
```

**Vor dem nächsten Schritt das Ergebnis ansehen.** Unter *Kontakte*: stimmen die
Firmenzuordnungen? Tauchen interne Adressen als Kunden auf? Falls ja,
`INTERNAL_EMAIL_DOMAINS` in der `.env` ergänzen, dann:

```bash
docker compose up -d api worker
```

---

## 5. Bauprojekte anlegen

Bevor die anderen Postfächer dazukommen, die laufenden Projekte eintragen –
dann ordnet der Import die Mails gleich richtig zu statt sie später
nachziehen zu müssen.

Je Projekt:

- **Projektnummer genau so, wie sie im Mailbetreff steht**
- unter *Weitere Bezeichnungen* alles, wie der Kunde das Vorhaben nennt
- bekannte Beteiligte mit ihren Rollen

---

## 6. Firmenweiten Postfachzugriff einschalten

Erst jetzt, und in dieser Reihenfolge.

### 6a. Anwendungsberechtigungen

In Entra ID unter **API-Berechtigungen → Anwendungsberechtigungen**:
`Mail.Read` und `User.Read.All`, dann Administratorzustimmung erteilen.

### 6b. Zugriff begrenzen

Ohne diesen Schritt darf die Anwendung **jedes Postfach der Organisation**
lesen, auch Geschäftsführung und Personalabteilung.

```bash
./deploy.sh policy
```

Gibt die Exchange-Befehle mit der eingetragenen Anwendungs-ID aus. In der
Exchange Online PowerShell ausführen. Nur die Postfächer in die Gruppe
aufnehmen, die tatsächlich durchsucht werden sollen.

### 6c. Nachweisen, dass die Begrenzung greift

```powershell
Test-ApplicationAccessPolicy -Identity info@rss-fb.com -AppId <ID>              # Granted
Test-ApplicationAccessPolicy -Identity geschaeftsfuehrung@rss-fb.com -AppId <ID> # Denied
```

Beide Antworten müssen stimmen. Bis zu einer Stunde Wartezeit.

### 6d. Aktivieren

In der `.env`:

```
MS_APP_ONLY_ENABLED=true
MS_MAILBOX_GROUP=AkquiseSystem-Postfaecher
```

```bash
docker compose up -d api worker
```

Dann im Dashboard **Einstellungen → Firmenpostfächer → „Postfächer suchen"**.
Gefundene Postfächer werden **deaktiviert** angelegt. Für jedes eintragen,
welcher Kollege für die daraus entstehenden Vorgänge zuständig ist – erst dann
lässt es sich aktivieren.

**Nicht alle auf einmal aktivieren.** Ein Postfach, Ergebnis ansehen, dann das
nächste.

---

## 7. Kollegen aufnehmen

Jeder meldet sich einmal unter `https://crm.rss-fb.com` mit seinem
Microsoft-Konto an. Das Konto entsteht dabei automatisch, sein persönliches
Postfach läuft ab dann delegiert – datensparsamer als über die
Anwendungsidentität.

Danach in den Projekten unter **Team** hinzufügen. Ab dann sieht er alle
Vorgänge und den Schriftverkehr dieser Projekte.

---

## Vor dem Einschalten des firmenweiten Zugriffs zu klären

Der Zugriff auf Postfächer von Beschäftigten ist in Deutschland regelmäßig
mitbestimmungspflichtig, und Mailinhalte gehen für Zusammenfassungen und
Entwürfe an die KI:

- Betriebsrat einbeziehen, falls vorhanden
- Verzeichnis von Verarbeitungstätigkeiten ergänzen
- Betroffene informieren, welche Postfächer ausgewertet werden
- Auftragsverarbeitungsvertrag mit Anthropic prüfen

Das persönliche Modell aus Schritt 4 – jeder meldet sich selbst an – kommt ohne
das aus. Wo es reicht, ist es die einfachere Wahl.

---

## Abnahme

- [ ] `https://crm.rss-fb.com` über HTTPS erreichbar, Zertifikat gültig
- [ ] Anmeldung mit dem Firmenkonto
- [ ] Systemstatus ohne Fehler
- [ ] Nächtlicher Lauf am Folgetag durchgelaufen
- [ ] Tagesübersicht enthält plausible Vorgänge mit nachvollziehbarer Begründung
- [ ] Ein Entwurf freigegeben, Mail kam beim Empfänger an
- [ ] Ein Teams-Termin angelegt
- [ ] `Test-ApplicationAccessPolicy` liefert für ein nicht freigegebenes Postfach `Denied`
- [ ] Sicherung eingerichtet und einmal zurückgespielt
