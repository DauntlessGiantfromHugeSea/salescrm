# Architektur

## Der Grundsatz

Die eigene Datenbank ist das führende System. Outlook, Teams und Planner sind
Quellen – sie liefern Daten, aber bei Widersprüchen gewinnt das CRM.

Der zweite Grundsatz steht in Kapitel 4.3 der Spezifikation und zieht sich durch
den gesamten Code: **unsichere Daten werden markiert, nicht geändert.** Keine
automatische Zusammenführung, kein automatisches Löschen, kein automatischer
Versand.

## Aufbau

```
Microsoft 365                    Eigener Server
─────────────                    ──────────────

Postfächer  ─┐
Kontakte     │                   ┌──────────┐      ┌────────────┐
Kalender     ├─── Graph API ───→ │  Worker  │ ───→ │ PostgreSQL │
Teams        │                   └──────────┘      └────────────┘
Planner     ─┘                         │                  ↑
                                       ↓                  │
                                  ┌────────┐         ┌─────────┐
Claude API  ←───────────────────  │ Redis  │         │   API   │
                                  └────────┘         └─────────┘
                                                          ↑
                                                     ┌─────────┐
                                                     │  Caddy  │ ← eigene Domain
                                                     └─────────┘
                                                          ↑
                                          Dashboard (React) + Buchungsseite
```

### Prozesse

| Dienst | Aufgabe | Warum getrennt |
|---|---|---|
| `api` | HTTP, Anmeldung, Dashboard-Daten | Muss immer antworten |
| `worker` | Import, Tageslauf, KI, Transkripte | Der Erstimport läuft stundenlang und darf keine Anfrage blockieren |
| `web` | Statisches Dashboard | Wird vom Reverse Proxy direkt ausgeliefert |
| `caddy` | TLS, Reverse Proxy | Holt und erneuert das Zertifikat selbst |
| `db`, `redis` | Daten und Jobwarteschlange | Kein Port nach außen |

## Zwei Wege in die Postfächer

**Persönlich (delegiert).** Wer sich am Dashboard anmeldet, gibt der Anwendung
Zugriff auf sein eigenes Postfach. Die Anwendung kann genau so viel wie die
Person selbst – nicht mehr. Endet der Zugang, endet der Zugriff.

**Firmenweit (Anwendungsidentität).** Für gemeinsame Postfächer und Kollegen
ohne eigenen Zugang. Braucht Admin-Zustimmung und – zwingend – eine
`ApplicationAccessPolicy`, die die Reichweite begrenzt. Siehe
[AZURE_SETUP.md](AZURE_SETUP.md), Abschnitt 4.

Mails aus einem gemeinsamen Postfach brauchen einen zuständigen Kollegen: ohne
ihn kann das System die entstehenden Vorgänge niemandem zuordnen und überspringt
das Postfach.

## Der Tag im System

```
03:00 UTC   Nächtlicher Abgleich
            └─ je Postfach ein Job: neue Mails über Delta-Abfrage holen,
               Kontakte und Firmen ergänzen, Mails Projekten zuordnen
            └─ je Person ein Job: Adressbuch, Kalender, Planner

04:30 UTC   Tageslauf (werktags)
            └─ alle Vorgänge neu bewerten (offen / nicht offen)
            └─ Buckets A/B/C füllen
            └─ Bucket D: Dubletten, Planner-Konflikte, unklare Zuordnungen
            └─ Entwürfe für die dringendsten Follow-ups vorproduzieren

stündlich   Transkripte abgelaufener Besprechungen holen und zusammenfassen

tagsüber    Mensch: Tagesübersicht durchgehen, Entwürfe prüfen, freigeben
```

## Wann ist ein Vorgang offen?

Die Regeln stehen in `packages/shared/src/rules.ts` – bewusst als reine
Funktionen ohne Datenbankzugriff, damit sie testbar sind und an genau einer
Stelle stehen.

Die Ausschlusskriterien haben Vorrang. Greift eines, ist der Vorgang nicht
offen, egal was sonst noch zutrifft:

- Status *Gewonnen*, *Verloren* oder *Pausiert*
- Der Kontakt hat nach unserer letzten Mail geantwortet
- Ein Termin ist bestätigt
- Die Wiedervorlage liegt in der Zukunft

Sonst ist er offen, wenn eines zutrifft:

- Seit *n* Tagen keine Antwort auf unsere letzte Mail (Vorgabe: 14)
- Keine nächste Aktion hinterlegt
- Fälligkeitsdatum überschritten
- Planner-Aufgabe überfällig
- Status *Neu* oder *Follow-up fällig*

Das Ergebnis wird am Vorgang zwischengespeichert (`isOpen`, `openReasons`),
damit die Tagesübersicht ohne Neuberechnung lädt. Die Begründungen stehen im
Dashboard als Chips am Vorgang – so ist nachvollziehbar, warum etwas heute in
der Liste steht.

## Wie Mails zu Bauprojekten finden

Das ist die Stelle mit dem größten praktischen Nutzen und dem größten
Fehlerpotenzial. Die Logik steht in
`packages/shared/src/projectMatching.ts` und ist nach Verlässlichkeit gestaffelt:

| Punkte | Signal |
|---|---|
| 100 | Projektnummer steht im Betreff |
| 92 | Ein hinterlegter Projekt-Alias steht im Betreff |
| 90 | Eine frühere Mail desselben Verlaufs hängt am Projekt |
| 85 | Der zugeordnete Vorgang gehört zum Projekt |
| 75 | Zwei oder mehr Projektbeteiligte stehen in der Mail |
| 45 | Ein Projektbeteiligter steht in der Mail |
| 25 | Nur die Firmendomain passt |

Ab 60 Punkten wird zugeordnet. Liegen zwei Projekte weniger als 15 Punkte
auseinander, gilt die Zuordnung als mehrdeutig: die Mail landet als Prüfaufgabe
in Bucket D, statt geraten zu werden.

Abgeschlossene Projekte werden auf 60 % abgewertet, damit sie laufende nicht
überstimmen.

Zwei Konsequenzen für die tägliche Arbeit:

1. **Die Projektnummer im Betreff ist Gold wert.** Wer sie konsequent setzt,
   bekommt eine praktisch fehlerfreie Projektakte.
2. Eine manuelle Korrektur im Dashboard wirkt auf den ganzen Mailverlauf, nicht
   nur auf die eine Mail.

## Wer sieht was

| Rolle | Sicht |
|---|---|
| Administrator | alles |
| Benutzer | eigene Vorgänge **plus** alles zu Projekten, in denen er Teammitglied ist |

Die zweite Hälfte ist der Punkt: ohne sie könnte ein Team nicht gemeinsam an
einem Bauvorhaben arbeiten. Der Filter steht in
`apps/api/src/routes/helpers.ts` und wird von jeder Abfrage benutzt – keine
Route entscheidet das selbst.

## Wie ein automatischer Versand verhindert wird

Vier voneinander unabhängige Sperren:

1. Es gibt **keinen Endpunkt**, der einen Entwurf erzeugt und sendet. Erzeugen
   und Freigeben sind getrennte Aufrufe.
2. Bei der Freigabe müssen Betreff und Empfänger mit dem übereinstimmen, was der
   Bearbeiter gesehen hat. Ein veralteter Browser-Tab kann nichts senden.
3. Der Zeitstempel der letzten Änderung muss stimmen – ein zwischenzeitlich
   geänderter Entwurf wird abgelehnt.
4. Der Statuswechsel auf `SENDING` wirkt als Sperre gegen Doppelversand; ein
   zweiter paralleler Aufruf findet den Entwurf nicht mehr im Zustand `APPROVED`.

Zusätzlich prüft `sendApprovedDraft` den Status noch einmal selbst – auch wenn
die Route das schon getan hat. Ein einzelner Fehler in einer Route darf keine
Mail nach draußen lassen.

Jede Freigabe und jeder Versand steht mit Zeitstempel, Person und IP im
Protokoll (`AuditLog`).

## Was nicht gespeichert wird

- **PDF- und Office-Inhalte.** Nur Dateiname und ein Kennzeichen. Das ist der
  Grund, warum aus einem 150-GB-Archiv 10–20 GB werden.
- **Vollständige Mailbodies.** Nur die ersten 4000 Zeichen des um Zitate und
  Signatur bereinigten Textes.
- **Refresh-Tokens im Klartext.** AES-256-GCM, Schlüssel in `ENCRYPTION_KEY`.
  Ein Datenbank-Abzug allein öffnet kein Postfach.

## Modell-Routing

Statisch konfiguriert, nicht zur Laufzeit entschieden – so bleiben Kosten und
Verhalten vorhersagbar:

| Aufgabe | Modell | Warum |
|---|---|---|
| Mailentwürfe, Besprechungsnotizen | `AI_MODEL_DRAFTING` | Wenige Aufrufe, hohe Qualitätsanforderung |
| Mailklassifikation, Firmenprofile | `AI_MODEL_CLASSIFY` | Hohe Stückzahl, einfache Aufgabe |
