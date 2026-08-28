/**
 * Beispieldaten zum Ausprobieren.
 *
 * Zwei Bauvorhaben in unterschiedlichen Phasen, mit den Beteiligten, die bei
 * solchen Projekten tatsächlich am Tisch sitzen, und einem Schriftverkehr, der
 * die Regeln des Systems sichtbar macht: ein Vorgang, der auf Antwort wartet,
 * einer der überfällig ist, einer ohne nächste Aktion, eine Dublette und eine
 * mehrdeutige Mailzuordnung.
 *
 *   npm run demo:seed -w @salescrm/api
 *
 * Läuft nur im Demo-Modus und legt nichts an, wenn schon Projekte da sind.
 */
import { config } from '../config.js';
import { prisma, disconnectDb } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { normalizeCompanyName } from '../domain/parsing.js';

const DAY = 86_400_000;
const now = Date.now();
const daysAgo = (days: number): Date => new Date(now - days * DAY);
const daysAhead = (days: number): Date => new Date(now + days * DAY);

async function main(): Promise<void> {
  if (!config.DEMO_MODE) {
    console.error(
      'Beispieldaten gibt es nur im Demo-Modus. DEMO_MODE=true setzen – ' +
        'in ein produktiv genutztes System gehören sie nicht.',
    );
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.project.count();
  if (existing > 0) {
    console.log(`Es sind bereits ${existing} Projekte vorhanden – es wird nichts angelegt.`);
    return;
  }

  // --- Menschen im eigenen Haus -------------------------------------------

  const dustyn = await prisma.user.upsert({
    where: { email: config.DEMO_USER_EMAIL.toLowerCase() },
    create: {
      email: config.DEMO_USER_EMAIL.toLowerCase(),
      displayName: 'Demo-Benutzer',
      role: 'ADMIN',
    },
    update: { role: 'ADMIN' },
  });

  const kollege = await prisma.user.upsert({
    where: { email: 'kollege@example.de' },
    create: { email: 'kollege@example.de', displayName: 'Martin Weber', role: 'USER' },
    update: {},
  });

  // --- Firmen --------------------------------------------------------------

  const companies = await createCompanies(dustyn.id);

  // --- Kontakte ------------------------------------------------------------

  const contacts = await createContacts(companies, dustyn.id);

  // --- Projekt 1: laufende Ausführung, viele Beteiligte --------------------

  const logistik = await prisma.project.create({
    data: {
      number: `${new Date().getFullYear()}-041`,
      name: 'Neubau Logistikzentrum Ost',
      description:
        'Bodenverbesserung und Gründungsberatung für eine Logistikhalle mit 14.000 m² ' +
        'Grundfläche. Baugrund heterogen, Grundwasserstand hoch.',
      stage: 'EXECUTION',
      city: 'Magdeburg',
      postalCode: '39104',
      siteAddress: 'Industriestraße 40, 39104 Magdeburg',
      serviceArea: 'Bodenverbesserung, Gründungsberatung',
      companyId: companies.hochbau.id,
      leadUserId: dustyn.id,
      startsOn: daysAgo(120),
      aliases: ['BV Industriestraße', 'Logistikzentrum Ost'],
      lastActivityAt: daysAgo(2),
      members: {
        create: [
          { userId: dustyn.id, role: 'LEAD', canEdit: true },
          { userId: kollege.id, role: 'ENGINEER', canEdit: true },
        ],
      },
      contacts: {
        create: [
          { contactId: contacts.bauherr.id, companyId: companies.hochbau.id, role: 'CLIENT', isPrimary: true, lastContactAt: daysAgo(2) },
          { contactId: contacts.architekt.id, companyId: companies.planwerk.id, role: 'ARCHITECT', lastContactAt: daysAgo(9) },
          { contactId: contacts.statiker.id, companyId: companies.tragwerk.id, role: 'STRUCTURAL_ENGINEER', lastContactAt: daysAgo(16) },
          { contactId: contacts.bauleiter.id, companyId: companies.hochbau.id, role: 'SITE_MANAGER', lastContactAt: daysAgo(5) },
          // Aus dem Mailverkehr erkannt, Rolle noch nicht bestätigt – das ist
          // der Zustand, in dem die Beteiligtenliste im Alltag ankommt.
          { contactId: contacts.vermesser.id, role: 'OTHER', autoDetected: true, lastContactAt: daysAgo(21) },
        ],
      },
    },
  });

  // --- Projekt 2: Angebotsphase --------------------------------------------

  const schule = await prisma.project.create({
    data: {
      number: `${new Date().getFullYear()}-047`,
      name: 'Sanierung Grundschule Nordpark',
      description: 'Baugrundgutachten und Sanierungskonzept Gründung, Bestandsgebäude von 1968.',
      stage: 'QUOTED',
      city: 'Halle (Saale)',
      postalCode: '06108',
      serviceArea: 'Baugrundgutachten',
      companyId: companies.kommune.id,
      leadUserId: dustyn.id,
      startsOn: daysAgo(35),
      aliases: ['Grundschule Nordpark'],
      lastActivityAt: daysAgo(18),
      members: { create: [{ userId: dustyn.id, role: 'LEAD', canEdit: true }] },
      contacts: {
        create: [
          { contactId: contacts.amtsleiter.id, companyId: companies.kommune.id, role: 'CLIENT', isPrimary: true, lastContactAt: daysAgo(18) },
          { contactId: contacts.architekt.id, companyId: companies.planwerk.id, role: 'ARCHITECT', lastContactAt: daysAgo(30) },
        ],
      },
    },
  });

  logger.info({ logistik: logistik.number, schule: schule.number }, 'Projekte angelegt');

  // --- Vorgänge ------------------------------------------------------------

  const deals = await createDeals({
    dustynId: dustyn.id,
    kollegeId: kollege.id,
    companies,
    contacts,
    logistikId: logistik.id,
    schuleId: schule.id,
  });

  // --- Schriftverkehr ------------------------------------------------------

  await createActivities({ userId: dustyn.id, contacts, deals, logistikId: logistik.id, schuleId: schule.id });

  // --- Termine -------------------------------------------------------------

  await prisma.meeting.create({
    data: {
      subject: 'Abstimmung Gründungsvariante',
      startsAt: daysAhead(3),
      endsAt: new Date(daysAhead(3).getTime() + 45 * 60_000),
      status: 'SCHEDULED',
      organizerId: dustyn.id,
      dealId: deals.gruendung.id,
      projectId: logistik.id,
      attendeeEmails: [contacts.statiker.email, contacts.architekt.email],
      agenda: 'Vergleich Bodenaustausch gegen Rüttelstopfverdichtung, Kostenrahmen.',
      joinUrl: 'https://teams.microsoft.com/l/meetup-join/demo-nicht-echt',
    },
  });

  await prisma.meeting.create({
    data: {
      subject: 'Ortstermin Baugrube',
      startsAt: daysAgo(12),
      endsAt: new Date(daysAgo(12).getTime() + 60 * 60_000),
      status: 'HELD',
      organizerId: dustyn.id,
      dealId: deals.gruendung.id,
      projectId: logistik.id,
      attendeeEmails: [contacts.bauleiter.email],
      summary:
        'Aufschluss im Bereich Achse D zeigt weichere Schichten als im Gutachten angenommen. ' +
        'Zusätzliche Sondierung vereinbart.\n\nEntscheidungen:\n' +
        '• Zwei zusätzliche Rammsondierungen bis Ende der Woche\n\nAufgaben:\n' +
        '• Bauleitung: Zugang für das Sondiergerät klären (bis Freitag)',
      nextActionSuggestion: 'Ergebnis der Zusatzsondierung an Statiker weiterleiten',
      transcriptFetchedAt: daysAgo(12),
    },
  });

  // --- Prüfaufgaben (Bucket D) ---------------------------------------------

  await createReviewItems(dustyn.id, contacts, deals, logistik.id, schule.id);

  // --- Buchungslink --------------------------------------------------------

  await prisma.bookingLink.create({
    data: {
      slug: 'erstgespraech',
      ownerId: dustyn.id,
      title: 'Erstgespräch Baugrund',
      description:
        '20 Minuten zum Kennenlernen: worum geht es bei Ihrem Vorhaben, und ' +
        'welche Untersuchungen sind sinnvoll.',
      durationMinutes: 20,
    },
  });

  const counts = {
    projekte: await prisma.project.count(),
    vorgaenge: await prisma.deal.count(),
    kontakte: await prisma.contact.count(),
    mails: await prisma.activity.count(),
    entwuerfe: await prisma.emailDraft.count(),
    pruefaufgaben: await prisma.reviewItem.count({ where: { status: 'OPEN' } }),
  };

  console.log('\nBeispieldaten angelegt:');
  for (const [name, value] of Object.entries(counts)) {
    console.log(`  ${name.padEnd(16)} ${value}`);
  }
  console.log(`\nAnmelden unter ${config.PUBLIC_BASE_URL}/login → "Ohne Microsoft ansehen"\n`);
}

/* -------------------------------------------------------------------------- */

async function createCompanies(ownerId: string) {
  const make = (name: string, domain: string, industry: string, website?: string) =>
    prisma.company.create({
      data: {
        name,
        nameNormalized: normalizeCompanyName(name),
        emailDomain: domain,
        industry,
        website: website ?? `https://${domain}`,
        ownerId,
        trustLevel: 'MEDIUM',
        source: 'IMPORT',
      },
    });

  return {
    hochbau: await make('Nordbau Hochbau GmbH', 'nordbau.example', 'Bauunternehmen'),
    planwerk: await make('Planwerk Architekten PartGmbB', 'planwerk.example', 'Architekturbüro'),
    tragwerk: await make('Tragwerk Ingenieure GmbH', 'tragwerk.example', 'Tragwerksplanung'),
    kommune: await make('Stadt Halle, Fachbereich Hochbau', 'halle.example', 'Öffentlicher Auftraggeber'),
    vermessung: await make('Geodaten Mitte GbR', 'geodaten.example', 'Vermessung'),
  };
}

type Companies = Awaited<ReturnType<typeof createCompanies>>;

async function createContacts(companies: Companies, ownerId: string) {
  const make = (
    firstName: string,
    lastName: string,
    email: string,
    position: string,
    companyId: string,
    extra: { phone?: string; level?: 'DECISION_MAKER' | 'INFLUENCER' | 'UNKNOWN'; emails?: number } = {},
  ) =>
    prisma.contact.create({
      data: {
        email,
        firstName,
        lastName,
        displayName: `${firstName} ${lastName}`,
        position,
        companyId,
        ownerId,
        phone: extra.phone ?? null,
        decisionMakerLevel: extra.level ?? 'UNKNOWN',
        emailCount: extra.emails ?? 4,
        trustLevel: 'MEDIUM',
        source: 'OUTLOOK',
        lastInboundAt: daysAgo(6),
        lastOutboundAt: daysAgo(9),
      },
    });

  return {
    bauherr: await make('Katrin', 'Sommer', 'k.sommer@nordbau.example', 'Projektleitung Hochbau', companies.hochbau.id, {
      phone: '+49 391 5540120',
      level: 'DECISION_MAKER',
      emails: 23,
    }),
    bauleiter: await make('Jens', 'Ottweiler', 'j.ottweiler@nordbau.example', 'Bauleiter', companies.hochbau.id, {
      phone: '+49 171 2255880',
      level: 'INFLUENCER',
      emails: 11,
    }),
    architekt: await make('Meike', 'Brandhorst', 'm.brandhorst@planwerk.example', 'Projektarchitektin', companies.planwerk.id, {
      phone: '+49 345 7781200',
      level: 'INFLUENCER',
      emails: 17,
    }),
    statiker: await make('Ulrich', 'Rehberg', 'u.rehberg@tragwerk.example', 'Tragwerksplaner', companies.tragwerk.id, {
      level: 'INFLUENCER',
      emails: 8,
    }),
    amtsleiter: await make('Bernd', 'Kaltenbach', 'b.kaltenbach@halle.example', 'Fachbereichsleiter Hochbau', companies.kommune.id, {
      phone: '+49 345 2213400',
      level: 'DECISION_MAKER',
      emails: 6,
    }),
    vermesser: await make('Tobias', 'Lindner', 't.lindner@geodaten.example', 'Vermessungsingenieur', companies.vermessung.id, {
      emails: 3,
    }),
    // Dieselbe Person mit alter Adresse – erzeugt die Dublettenprüfung.
    architektAlt: await make('Meike', 'Brandhorst', 'brandhorst@planwerk-alt.example', 'Architektin', companies.planwerk.id, {
      emails: 2,
    }),
  };
}

type Contacts = Awaited<ReturnType<typeof createContacts>>;

async function createDeals(input: {
  dustynId: string;
  kollegeId: string;
  companies: Companies;
  contacts: Contacts;
  logistikId: string;
  schuleId: string;
}) {
  const { dustynId, kollegeId, companies, contacts, logistikId, schuleId } = input;

  // Wartet auf Antwort, Frist überschritten → Bucket A.
  const gruendung = await prisma.deal.create({
    data: {
      title: 'Zusatzsondierung Achse D',
      description: 'Nach dem Ortstermin: zwei ergänzende Rammsondierungen, Angebot liegt beim Kunden.',
      stage: 'AWAITING_REPLY',
      serviceArea: 'Baugrunderkundung',
      relevance: 'HIGH',
      ownerId: dustynId,
      projectId: logistikId,
      companyId: companies.hochbau.id,
      contactId: contacts.bauherr.id,
      nextAction: 'Nachfassen zur Freigabe der Zusatzsondierung',
      lastOutboundAt: daysAgo(19),
      lastContactAt: daysAgo(19),
      isOpen: true,
      openReasons: ['Seit 19 Tagen keine Antwort'],
      lastEvaluatedAt: daysAgo(1),
      source: 'OUTLOOK',
    },
  });

  // Angebot draußen, keine nächste Aktion → Bucket A, anderer Grund.
  const gutachten = await prisma.deal.create({
    data: {
      title: 'Baugrundgutachten Grundschule Nordpark',
      description: 'Angebot über Baugrundgutachten inkl. Sanierungsempfehlung Gründung.',
      stage: 'PROPOSAL_SENT',
      serviceArea: 'Baugrundgutachten',
      relevance: 'HIGH',
      ownerId: dustynId,
      projectId: schuleId,
      companyId: companies.kommune.id,
      contactId: contacts.amtsleiter.id,
      dueDate: daysAgo(4),
      lastOutboundAt: daysAgo(18),
      lastContactAt: daysAgo(18),
      isOpen: true,
      openReasons: ['Seit 18 Tagen keine Antwort', 'Keine nächste Aktion definiert', 'Fälligkeitsdatum überschritten'],
      lastEvaluatedAt: daysAgo(1),
      source: 'MANUAL',
    },
  });

  // Gehört dem Kollegen – im Projektteam trotzdem sichtbar.
  const beweissicherung = await prisma.deal.create({
    data: {
      title: 'Beweissicherung Nachbarbebauung',
      stage: 'IN_CLARIFICATION',
      serviceArea: 'Beweissicherung',
      relevance: 'MEDIUM',
      ownerId: kollegeId,
      projectId: logistikId,
      companyId: companies.hochbau.id,
      contactId: contacts.bauleiter.id,
      nextAction: 'Rückmeldung Eigentümer Flurstück 118 abwarten',
      followUpDate: daysAhead(6),
      lastInboundAt: daysAgo(5),
      lastOutboundAt: daysAgo(7),
      lastContactAt: daysAgo(5),
      isOpen: false,
      openReasons: ['Wiedervorlage liegt in der Zukunft'],
      lastEvaluatedAt: daysAgo(1),
      source: 'OUTLOOK',
    },
  });

  // Lange kein Kontakt → Bucket B.
  const reaktivierung = await prisma.deal.create({
    data: {
      title: 'Rahmenvereinbarung Tragwerk Ingenieure',
      description: 'Vor zwei Jahren angefragt, damals kein Projekt zustande gekommen.',
      stage: 'OPEN',
      serviceArea: 'Rahmenvereinbarung',
      relevance: 'MEDIUM',
      ownerId: dustynId,
      companyId: companies.tragwerk.id,
      contactId: contacts.statiker.id,
      lastOutboundAt: daysAgo(400),
      lastContactAt: daysAgo(400),
      isOpen: true,
      openReasons: ['Seit 400 Tagen keine Antwort', 'Keine nächste Aktion definiert'],
      lastEvaluatedAt: daysAgo(1),
      source: 'IMPORT',
    },
  });

  // Noch nie kontaktiert → Bucket C.
  const kalt = await prisma.deal.create({
    data: {
      title: 'Erstkontakt Geodaten Mitte',
      description: 'Taucht regelmäßig als Vermesser in unseren Projekten auf, aber nie direkt beauftragt.',
      stage: 'NEW',
      serviceArea: 'Zusammenarbeit Vermessung',
      relevance: 'LOW',
      ownerId: dustynId,
      companyId: companies.vermessung.id,
      contactId: contacts.vermesser.id,
      isOpen: true,
      openReasons: ['Keine nächste Aktion definiert', 'Status NEW'],
      lastEvaluatedAt: daysAgo(1),
      source: 'MANUAL',
    },
  });

  return { gruendung, gutachten, beweissicherung, reaktivierung, kalt };
}

type Deals = Awaited<ReturnType<typeof createDeals>>;

async function createActivities(input: {
  userId: string;
  contacts: Contacts;
  deals: Deals;
  logistikId: string;
  schuleId: string;
}): Promise<void> {
  const { userId, contacts, deals, logistikId, schuleId } = input;
  const projectNumber = `${new Date().getFullYear()}-041`;

  const mails = [
    {
      occurredAt: daysAgo(19),
      direction: 'OUTBOUND' as const,
      subject: `${projectNumber} – Angebot Zusatzsondierung Achse D`,
      bodyPreview:
        'Sehr geehrte Frau Sommer,\n\nwie am Ortstermin besprochen haben wir die zwei ergänzenden ' +
        'Rammsondierungen kalkuliert. Das Angebot liegt bei. Für die Terminplanung bräuchten wir ' +
        'die Freigabe bis Ende nächster Woche.\n\nMit freundlichen Grüßen',
      contactId: contacts.bauherr.id,
      dealId: deals.gruendung.id,
      projectId: logistikId,
      linkMethod: 'PROJECT_NUMBER' as const,
      linkScore: 100,
      replyPending: true,
      attachmentNames: ['Angebot_Zusatzsondierung.pdf'],
      hasPdf: true,
    },
    {
      occurredAt: daysAgo(21),
      direction: 'INBOUND' as const,
      subject: `AW: ${projectNumber} – Aufschluss Achse D`,
      bodyPreview:
        'Guten Tag,\n\nanbei die Einmessung der Sondierpunkte wie besprochen. Die Zufahrt für das ' +
        'Gerät ist über die Baustraße Nord möglich.\n\nViele Grüße\nTobias Lindner',
      contactId: contacts.vermesser.id,
      dealId: deals.gruendung.id,
      projectId: logistikId,
      linkMethod: 'PROJECT_NUMBER' as const,
      linkScore: 100,
      replyPending: false,
      attachmentNames: ['Einmessung_Sondierpunkte.pdf'],
      hasPdf: true,
    },
    {
      occurredAt: daysAgo(16),
      direction: 'INBOUND' as const,
      subject: 'Rückfrage Bemessungswerte',
      bodyPreview:
        'Hallo,\n\nfür die Bemessung der Bodenplatte brauche ich noch den Steifemodul aus dem ' +
        'Bereich Achse D. Können Sie den kurzfristig liefern?\n\nGruß\nU. Rehberg',
      contactId: contacts.statiker.id,
      dealId: deals.gruendung.id,
      projectId: logistikId,
      // Kein Betreff-Treffer: über den Mailverlauf zugeordnet.
      linkMethod: 'CONVERSATION' as const,
      linkScore: 90,
      replyPending: false,
      attachmentNames: [],
      hasPdf: false,
    },
    {
      occurredAt: daysAgo(9),
      direction: 'OUTBOUND' as const,
      subject: 'Terminabstimmung Gründungsvariante',
      bodyPreview:
        'Guten Tag zusammen,\n\nich schlage vor, wir gehen die beiden Gründungsvarianten gemeinsam ' +
        'durch. Passt Ihnen einer der folgenden Termine?\n\nMit freundlichen Grüßen',
      contactId: contacts.architekt.id,
      dealId: deals.gruendung.id,
      projectId: logistikId,
      // Zwei bekannte Beteiligte in der Mail.
      linkMethod: 'PARTICIPANTS' as const,
      linkScore: 75,
      replyPending: false,
      attachmentNames: [],
      hasPdf: false,
    },
    {
      occurredAt: daysAgo(18),
      direction: 'OUTBOUND' as const,
      subject: 'Angebot Baugrundgutachten Grundschule Nordpark',
      bodyPreview:
        'Sehr geehrter Herr Kaltenbach,\n\nanbei unser Angebot über das Baugrundgutachten ' +
        'einschließlich Empfehlung zur Gründungssanierung.\n\nMit freundlichen Grüßen',
      contactId: contacts.amtsleiter.id,
      dealId: deals.gutachten.id,
      projectId: schuleId,
      linkMethod: 'MANUAL' as const,
      linkScore: 100,
      replyPending: true,
      attachmentNames: ['Angebot_Baugrundgutachten.pdf', 'Leistungsbeschreibung.pdf'],
      hasPdf: true,
    },
    {
      occurredAt: daysAgo(5),
      direction: 'INBOUND' as const,
      subject: 'Beweissicherung – Zugang Flurstück 118',
      bodyPreview:
        'Moin,\n\nder Eigentümer von Flurstück 118 meldet sich nicht. Ich hake nächste Woche ' +
        'nochmal nach.\n\nJens',
      contactId: contacts.bauleiter.id,
      dealId: deals.beweissicherung.id,
      projectId: logistikId,
      linkMethod: 'PARTICIPANTS' as const,
      linkScore: 75,
      replyPending: false,
      attachmentNames: [],
      hasPdf: false,
    },
  ];

  for (const mail of mails) {
    await prisma.activity.create({
      data: {
        occurredAt: mail.occurredAt,
        direction: mail.direction,
        channel: 'EMAIL',
        subject: mail.subject,
        bodyPreview: mail.bodyPreview,
        replyPending: mail.replyPending,
        attachmentNames: mail.attachmentNames,
        hasPdfAttachment: mail.hasPdf,
        conversationId: `demo-thread-${mail.dealId}`,
        userId,
        contactId: mail.contactId,
        dealId: mail.dealId,
        projectId: mail.projectId,
        projectLinkMethod: mail.linkMethod,
        projectLinkScore: mail.linkScore,
      },
    });
  }

  // Ein fertiger Entwurf, damit die Freigabemaske gefüllt ist.
  await prisma.emailDraft.create({
    data: {
      dealId: deals.gruendung.id,
      userId,
      type: 'FOLLOW_UP',
      status: 'DRAFT',
      subject: `${projectNumber} – Freigabe Zusatzsondierung`,
      body:
        'Sehr geehrte Frau Sommer,\n\n' +
        'ich komme auf mein Angebot vom vergangenen Monat zur Zusatzsondierung an Achse D zurück. ' +
        'Für die Terminplanung des Sondiergeräts bräuchten wir eine kurze Rückmeldung.\n\n' +
        'Falls intern noch etwas offen ist: rufen Sie mich gern an, dann klären wir es in fünf Minuten.',
      toEmail: contacts.bauherr.email,
      toName: 'Katrin Sommer',
      model: 'Beispieldaten (kein Modellaufruf)',
      rationale:
        'Bezieht sich auf das konkrete Angebot und den Ortstermin, macht das Antworten leicht ' +
        'und übt keinen Druck aus.',
    },
  });

  await prisma.emailDraft.create({
    data: {
      dealId: deals.reaktivierung.id,
      userId,
      type: 'REACTIVATION',
      status: 'DRAFT',
      subject: 'Zusammenarbeit Tragwerksplanung – neuer Anlass',
      body:
        'Sehr geehrter Herr Rehberg,\n\n' +
        'vor gut einem Jahr hatten wir über eine Rahmenvereinbarung gesprochen, damals ohne ' +
        'konkretes Vorhaben. Inzwischen begleiten wir mehrere Projekte mit vergleichbarer ' +
        'Baugrundsituation und haben unsere Sondierkapazität erweitert.\n\n' +
        'Hätten Sie Interesse an einem kurzen Austausch, ob sich daraus für Ihre laufenden ' +
        'Projekte etwas ergibt?',
      toEmail: contacts.statiker.email,
      toName: 'Ulrich Rehberg',
      model: 'Beispieldaten (kein Modellaufruf)',
      rationale: 'Benennt den früheren Kontakt und liefert einen echten Anlass statt einer Floskel.',
    },
  });
}

async function createReviewItems(
  userId: string,
  contacts: Contacts,
  deals: Deals,
  logistikId: string,
  schuleId: string,
): Promise<void> {
  await prisma.reviewItem.createMany({
    data: [
      {
        type: 'DUPLICATE_CONTACT',
        dedupeKey: `demo-dup-contact`,
        title: 'Mögliche Dublette: Meike Brandhorst',
        detail:
          'm.brandhorst@planwerk.example und brandhorst@planwerk-alt.example scheinen dieselbe ' +
          'Person zu sein (Planwerk Architekten PartGmbB). Bitte prüfen: Adresswechsel oder zwei ' +
          'verschiedene Personen?',
        userId,
        contactId: contacts.architekt.id,
        relatedContactId: contacts.architektAlt.id,
      },
      {
        type: 'AMBIGUOUS_PROJECT_MAIL',
        dedupeKey: `demo-ambiguous-mail`,
        title: 'Mail passt zu mehreren Projekten: „Terminabstimmung nächste Woche"',
        detail:
          'Diese Mail lässt sich nicht eindeutig zuordnen. Infrage kommen: ' +
          `${new Date().getFullYear()}-041 Neubau Logistikzentrum Ost, ` +
          `${new Date().getFullYear()}-047 Sanierung Grundschule Nordpark. ` +
          'Beide haben dieselbe Architektin als Beteiligte. Bitte im Projekt-Tab manuell zuordnen.',
        userId,
        projectId: logistikId,
      },
      {
        type: 'STALE_DEAL',
        dedupeKey: `demo-stale-deal`,
        title: 'Deal ohne nächste Aktion: Baugrundgutachten Grundschule Nordpark',
        detail:
          'Das Angebot ist seit 18 Tagen beim Kunden, das Fälligkeitsdatum ist überschritten und ' +
          'es ist keine nächste Aktion hinterlegt.',
        userId,
        dealId: deals.gutachten.id,
        projectId: schuleId,
      },
      {
        type: 'PLANNER_TASK_MISSING',
        dedupeKey: `demo-planner-missing`,
        title: 'Follow-up fällig, keine Planner-Aufgabe: Zusatzsondierung Achse D',
        detail:
          'Für diesen Vorgang ist ein Follow-up fällig, in Planner existiert dazu keine offene ' +
          'Aufgabe. (Im Demo-Modus ist Planner nicht verbunden – der Eintrag zeigt, wie ein ' +
          'echter Konflikt aussieht.)',
        userId,
        dealId: deals.gruendung.id,
      },
    ],
  });
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'Beispieldaten konnten nicht angelegt werden');
    process.exit(1);
  })
  .finally(() => void disconnectDb());
