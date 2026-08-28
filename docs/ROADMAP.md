# Roadmap

## Stand

**Fertig gebaut (Phase 1):**

- Microsoft-Anmeldung, persönlicher und firmenweiter Postfachzugriff
- Import von Mails, Kontakten, Kalender, Planner – ohne PDF-Inhalte
- Bauprojekte mit Beteiligtenrollen, Team und automatischer Mailzuordnung
- Regelwerk für offene Vorgänge, Tagesübersicht A–D
- KI-Entwürfe in drei Varianten, Freigabe und Versand aus der echten Mailbox
- Teams: Termin aus dem Vorgang, Terminvorschläge, öffentliche Buchungsseite,
  Transkriptauswertung
- Dublettenerkennung, Prüfliste, Excel-Export
- Mehrbenutzerbetrieb mit Projektteams

## Phase 2 – Verwaltung, Angebote, Abrechnung

Ausdrücklich zurückgestellt, bis Phase 1 im Alltag läuft. Der Grund ist derselbe
wie in der ursprünglichen Spezifikation: Automatisierung auf schlechter
Datengrundlage erzeugt Fehler und Misstrauen.

Das Datenmodell ist vorbereitet – `Project` trägt bereits `budgetCents`,
`currency` und `serviceArea`, `Deal` trägt `serviceArea`. Die folgenden
Objekte kommen additiv dazu, ohne dass Bestehendes umgebaut wird:

### Geplante Objekte

```
Quote  (Angebot)
  ├─ projectId, dealId, companyId, contactId
  ├─ number, version, status (ENTWURF|VERSENDET|ANGENOMMEN|ABGELEHNT|ABGELAUFEN)
  ├─ validUntil, sentAt, decidedAt
  └─ items → QuoteItem[]

QuoteItem  (Leistungsposition)
  ├─ position, description, serviceCode
  ├─ quantity, unit, unitPriceCents
  └─ optional (Eventualposition ja/nein)

ServiceCatalogItem  (Leistungskatalog)
  ├─ code, name, defaultUnit, defaultPriceCents
  └─ Grundlage wiederkehrender Positionen

Invoice  (Rechnung)
  ├─ projectId, quoteId
  ├─ number, type (ABSCHLAG|SCHLUSS|GUTSCHRIFT)
  ├─ issuedAt, dueAt, paidAt, status
  └─ items → InvoiceItem[]

TimeEntry  (Leistungserfassung)
  ├─ projectId, userId, date, hours
  └─ serviceCode, billable, invoiceItemId
```

### Was die Anbindung an Phase 1 bringt

Der eigentliche Wert entsteht durch die Verbindung mit dem, was schon da ist:

- Ein Angebot wird **aus einem Vorgang** erzeugt – Firma, Ansprechpartner,
  Projekt und Leistungsbereich stehen bereits fest.
- Der Versand läuft über denselben Freigabeweg wie jede andere Mail:
  Entwurf ansehen, freigeben, aus der echten Mailbox senden.
- Der Vorgang wandert automatisch auf *Angebot versendet*; die vorhandene
  Follow-up-Regel greift damit auch für Angebote.
- Eine Zahlungserinnerung ist ein weiterer Entwurfstyp, kein neues System.
- Der Projektbildschirm zeigt Angebote und Rechnungen neben Beteiligten und
  Schriftverkehr.

### Offene Fragen für Phase 2

Vor dem Bau zu klären:

1. **Rechnungsstellung selbst oder Export?** Läuft die Buchhaltung über DATEV,
   Lexoffice oder sevDesk, ist ein Export sinnvoller als ein zweites
   Rechnungssystem. Dann bleibt hier die Leistungserfassung, und die Rechnung
   entsteht dort.
2. **HOAI-Honorare oder freie Positionen?** Eine HOAI-Berechnung (Anrechenbare
   Kosten, Honorarzone, Leistungsphasen) ist ein eigenes Vorhaben und lohnt nur,
   wenn die Angebote tatsächlich so kalkuliert werden.
3. **§14 UStG und GoBD.** Rechnungsnummern müssen lückenlos sein und
   ausgestellte Rechnungen unveränderbar. Das ist ein deutlich strengerer
   Anspruch als beim übrigen System und beeinflusst das Datenmodell.
4. **E-Rechnung.** Seit 2025 besteht für inländische B2B-Umsätze
   Empfangspflicht; die Ausstellungspflicht greift gestaffelt. Ob XRechnung
   bzw. ZUGFeRD hier entstehen oder im Buchhaltungssystem, hängt an Frage 1.

## Phase 3 – aus der ursprünglichen Spezifikation

Weiterhin bewusst nicht gebaut:

- **PDF-Inhalte auswerten** (eigenes Wissensdatenbank-Vorhaben). Der größte
  einzelne Hebel: Leistungsverzeichnisse, Gutachten und Ausschreibungen
  durchsuchbar zu machen.
- LinkedIn-Anbindung
- Website-Auswertung für Kaltakquise
- Semantische Suche über den gesamten Schriftverkehr
- Vollautomatischer Versand ohne Freigabe – in Phase 1 ausgeschlossen, und es
  spricht wenig dafür, das je zu ändern
