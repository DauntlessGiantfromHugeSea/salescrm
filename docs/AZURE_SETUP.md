# Microsoft 365 einrichten

Diese Anleitung führt durch die Einrichtung in Entra ID (früher Azure AD).
Alle Schritte brauchen einen **Globalen Administrator** des Mandanten.

Zeitbedarf: etwa 45 Minuten, plus Wartezeit auf die Admin-Zustimmung.

---

## 1. App-Registrierung anlegen

1. [entra.microsoft.com](https://entra.microsoft.com) öffnen
2. **Identität → Anwendungen → App-Registrierungen → Neue Registrierung**
3. Ausfüllen:
   - **Name:** `Akquisesystem`
   - **Unterstützte Kontotypen:** *Nur Konten in diesem Organisationsverzeichnis*
   - **Umleitungs-URI:** Plattform `Web`, Wert `https://IHRE-DOMAIN/api/auth/callback`
4. **Registrieren**

Von der Übersichtsseite in die `.env` übertragen:

| Angabe in Entra ID | Variable in `.env` |
|---|---|
| Anwendungs-ID (Client) | `MS_CLIENT_ID` |
| Verzeichnis-ID (Mandant) | `MS_TENANT_ID` |

> Die Umleitungs-URI muss **zeichengenau** mit `MS_REDIRECT_URI` übereinstimmen –
> inklusive `https://` und ohne Schrägstrich am Ende. Eine Abweichung führt zu
> `AADSTS50011` bei der Anmeldung.

---

## 2. Clientschlüssel erzeugen

1. **Zertifikate & Geheimnisse → Neuer geheimer Clientschlüssel**
2. Beschreibung `Akquisesystem`, Gültigkeit **24 Monate**
3. Den **Wert** (nicht die Geheimnis-ID) sofort kopieren → `MS_CLIENT_SECRET`

> Der Wert ist nur einmal sichtbar. **Ablaufdatum in den Kalender eintragen:**
> läuft der Schlüssel ab, steht das System ohne Vorwarnung still.

---

## 3. Berechtigungen für den persönlichen Zugriff

**API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph → Delegierte Berechtigungen**

Diese Berechtigungen wirken **im Namen der angemeldeten Person** – die App kann
genau das, was die Person selbst auch könnte, nicht mehr:

| Berechtigung | Wofür |
|---|---|
| `offline_access` | Zugriff über die Sitzung hinaus. **Ohne diese läuft nichts nachts.** |
| `User.Read` | Anzeigename und Mailadresse |
| `Mail.Read` | Postfach lesen (Import, Antworterkennung) |
| `Mail.Send` | Versand freigegebener Mails aus der echten Mailbox |
| `Contacts.Read` | Outlook-Adressbuch importieren |
| `Calendars.ReadWrite` | Termine lesen und anlegen |
| `OnlineMeetings.ReadWrite` | Teams-Besprechungen erzeugen |
| `OnlineMeetingTranscript.Read.All` | Transkripte nach dem Gespräch |
| `Tasks.ReadWrite` | Planner-Abgleich |
| `Group.Read.All` | Planner-Pläne auflisten |

Danach **„Administratorzustimmung für <Organisation> erteilen"** klicken.

Ohne Zustimmung würde jede Person beim ersten Login einzeln zustimmen müssen –
und `Group.Read.All` kann sie gar nicht selbst erteilen.

### Was passiert, wenn eine Berechtigung fehlt?

Das System bricht nicht ab, sondern schaltet die betroffene Funktion ab und
zeigt sie unter **Einstellungen → Microsoft 365** als eingeschränkt an.
Zwingend sind nur `Mail.Read`, `Mail.Send` und `Calendars.ReadWrite`.

---

## 4. Firmenweiter Postfachzugriff (optional, aber meist gewünscht)

Der Zugriff aus Schritt 3 umfasst nur die Postfächer der Personen, die sich
selbst am Dashboard anmelden. Sollen auch **gemeinsame Postfächer**
(`info@`, `angebote@`, `projekte@`) und die Postfächer von Kollegen ohne
eigenen Zugang durchsucht werden, braucht es die Anwendungsidentität.

### 4a. Anwendungsberechtigungen ergänzen

**API-Berechtigungen → Berechtigung hinzufügen → Microsoft Graph → Anwendungsberechtigungen**

| Berechtigung | Wofür |
|---|---|
| `Mail.Read` | Postfächer serverseitig lesen |
| `User.Read.All` | Postfächer des Mandanten auflisten |

Anschließend **Administratorzustimmung erteilen**.

### 4b. Zugriff eingrenzen — dieser Schritt ist nicht optional

Anwendungsberechtigungen gelten **standardmäßig für jedes Postfach der
Organisation**, auch für die Geschäftsführung und die Personalabteilung.
Das ist fast nie gewollt und arbeitsrechtlich heikel.

Die Eingrenzung erfolgt über eine `ApplicationAccessPolicy` in Exchange Online.
Zuerst eine Sicherheitsgruppe anlegen (z. B. `AkquiseSystem-Postfaecher`) und
nur die Postfächer aufnehmen, die tatsächlich durchsucht werden sollen.

Dann in der Exchange Online PowerShell:

```powershell
Connect-ExchangeOnline

New-ApplicationAccessPolicy `
  -AppId <MS_CLIENT_ID> `
  -PolicyScopeGroupId AkquiseSystem-Postfaecher@example.de `
  -AccessRight RestrictAccess `
  -Description "Akquisesystem darf nur die freigegebenen Postfaecher lesen"

# Prüfen – muss "Granted" für ein freigegebenes und "Denied" für ein
# nicht freigegebenes Postfach liefern:
Test-ApplicationAccessPolicy -Identity info@example.de     -AppId <MS_CLIENT_ID>
Test-ApplicationAccessPolicy -Identity geschaeftsfuehrung@example.de -AppId <MS_CLIENT_ID>
```

> Die Richtlinie braucht bis zu **einer Stunde**, bis sie greift. Bis dahin kann
> die Anwendung noch mehr sehen, als sie soll – deshalb `MS_APP_ONLY_ENABLED`
> erst danach auf `true` setzen.

### 4c. Aktivieren

In der `.env`:

```
MS_APP_ONLY_ENABLED=true
MS_MAILBOX_GROUP=AkquiseSystem-Postfaecher
```

Dann im Dashboard unter **Einstellungen → Firmenpostfächer → „Postfächer suchen"**.
Gefundene Postfächer werden **deaktiviert** angelegt. Für jedes Postfach ist
einzutragen, welcher Kollege für die daraus entstehenden Vorgänge zuständig
ist – erst dann lässt es sich aktivieren.

### 4d. Mitbestimmung

Der Zugriff auf Postfächer von Beschäftigten ist in Deutschland regelmäßig
mitbestimmungspflichtig. Vor dem Einschalten von `MS_APP_ONLY_ENABLED`:

- Betriebsrat einbeziehen, falls vorhanden
- Verzeichnis von Verarbeitungstätigkeiten ergänzen
- Betroffene informieren, welche Postfächer ausgewertet werden
- Auftragsverarbeitungsvertrag mit Anthropic prüfen (Mailinhalte gehen für
  Zusammenfassung und Entwürfe an die KI)

Das persönliche Modell aus Schritt 3 – jeder meldet sich selbst an – ist
datenschutzrechtlich deutlich einfacher. Wo es reicht, ist es die bessere Wahl.

---

## 5. Teams-Transkripte

Damit nach einem Gespräch eine Notiz entstehen kann, muss die Transkription
überhaupt laufen. Im **Teams Admin Center → Besprechungen → Besprechungsrichtlinien**:

- **Transkription:** Ein
- **Cloudaufzeichnung:** nach Bedarf

Zwei Einschränkungen aus der Praxis:

1. Ein Transkript entsteht nur, wenn es im Gespräch **gestartet** wurde –
   automatisch geschieht das nur, wenn die Richtlinie das erzwingt.
2. Microsoft stellt es mit einigen Minuten Verzögerung bereit. Das System
   prüft deshalb stündlich für 48 Stunden nach.

**Die Teilnehmer müssen der Aufzeichnung zustimmen.** Teams weist darauf hin;
bei externen Gesprächspartnern gehört ein kurzer Hinweis zum guten Ton und ist
je nach Konstellation rechtlich erforderlich.

---

## 6. Prüfen, ob alles läuft

Nach dem ersten Login unter **Einstellungen**:

| Was | Erwartung |
|---|---|
| Microsoft 365 → Verbundenes Postfach | die eigene Adresse |
| Eingeschränkte Funktionen | leer |
| Systemstatus → `mail:inbox` | Zeitstempel, kein Fehler |
| Systemstatus → `contacts` | Anzahl importierter Kontakte |

Wenn nach dem Login sofort wieder die Anmeldeseite erscheint, stimmt meist
`MS_REDIRECT_URI` nicht mit der Umleitungs-URI in Entra ID überein.

---

## Häufige Fehler

| Meldung | Ursache | Lösung |
|---|---|---|
| `AADSTS50011` Umleitungs-URI stimmt nicht | Abweichung zwischen Entra ID und `.env` | Beide Werte zeichenweise vergleichen |
| `AADSTS7000215` Ungültiges Clientgeheimnis | Geheimnis-ID statt Wert kopiert, oder abgelaufen | Neues Geheimnis erzeugen |
| Anmeldung endet mit `no_refresh_token` | `offline_access` fehlt oder wird im Mandanten blockiert | Berechtigung ergänzen, Zustimmung erneuern |
| `ErrorAccessDenied` beim Postfachzugriff | Postfach nicht in der Zugriffsrichtlinie | Postfach in die Sicherheitsgruppe aufnehmen, bis zu 1 Stunde warten |
| Planner wird übersprungen | `Tasks.ReadWrite` oder `Group.Read.All` fehlt | Berechtigung ergänzen; das System läuft ohne Planner weiter |
| Keine Transkripte | Transkription war im Gespräch aus | Besprechungsrichtlinie prüfen |
