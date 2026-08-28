import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchMailToProject,
  normalizeSubject,
  projectNumberPattern,
  type ProjectCandidate,
} from './projectMatching.js';

function project(overrides: Partial<ProjectCandidate> = {}): ProjectCandidate {
  return {
    id: 'p1',
    number: '2026-041',
    name: 'Neubau Logistikzentrum Ost',
    aliases: [],
    participantEmails: ['architekt@planwerk.de', 'bauleitung@hochtief.de'],
    participantDomains: ['planwerk.de', 'hochtief.de'],
    isActive: true,
    ...overrides,
  };
}

describe('normalizeSubject', () => {
  test('entfernt Antwort- und Weiterleitungspräfixe', () => {
    assert.equal(normalizeSubject('AW: Re: WG: Statik 2026-041'), 'Statik 2026-041');
    assert.equal(normalizeSubject('Fwd: Angebot'), 'Angebot');
  });

  test('lässt normale Betreffs unverändert', () => {
    assert.equal(normalizeSubject('Bodengutachten Baugrube'), 'Bodengutachten Baugrube');
  });
});

describe('projectNumberPattern', () => {
  test('erkennt die üblichen Schreibweisen', () => {
    const pattern = projectNumberPattern('2026-041');
    assert.ok(pattern.test('Betreff 2026-041 Statik'));
    assert.ok(pattern.test('Projekt 2026/041'));
    assert.ok(pattern.test('BV 2026 041 Rückfrage'));
  });

  test('greift nicht mitten in einer längeren Zahl', () => {
    const pattern = projectNumberPattern('2026-041');
    assert.equal(pattern.test('12026-0415'), false);
  });
});

describe('matchMailToProject', () => {
  test('die Projektnummer im Betreff gewinnt', () => {
    const result = matchMailToProject(
      { subject: 'AW: 2026-041 Baugrundgutachten', bodyPreview: '', participantEmails: ['neu@fremd.de'] },
      [project()],
    );
    assert.equal(result.match?.projectId, 'p1');
    assert.equal(result.match?.method, 'PROJECT_NUMBER');
    assert.equal(result.match?.score, 100);
  });

  test('der Mailverlauf zieht die Zuordnung nach', () => {
    const result = matchMailToProject(
      {
        subject: 'Rückfrage',
        bodyPreview: '',
        participantEmails: ['unbekannt@extern.de'],
        conversationProjectId: 'p1',
      },
      [project()],
    );
    assert.equal(result.match?.projectId, 'p1');
    assert.equal(result.match?.method, 'CONVERSATION');
  });

  test('zwei bekannte Beteiligte reichen für eine sichere Zuordnung', () => {
    const result = matchMailToProject(
      {
        subject: 'Abstimmung Termin',
        bodyPreview: '',
        participantEmails: ['architekt@planwerk.de', 'bauleitung@hochtief.de'],
      },
      [project()],
    );
    assert.equal(result.match?.projectId, 'p1');
    assert.equal(result.match?.method, 'PARTICIPANTS');
  });

  test('ein einzelner Beteiligter reicht nicht – das entscheidet ein Mensch', () => {
    const result = matchMailToProject(
      { subject: 'Frage', bodyPreview: '', participantEmails: ['architekt@planwerk.de'] },
      [project()],
    );
    assert.equal(result.match, null);
    assert.equal(result.ranked[0]?.score, 45);
  });

  test('zwei gleich gut passende Projekte gelten als mehrdeutig', () => {
    const shared = ['architekt@planwerk.de', 'bauleitung@hochtief.de'];
    const result = matchMailToProject(
      { subject: 'Terminabstimmung', bodyPreview: '', participantEmails: shared },
      [
        project({ id: 'p1', number: '2026-041', participantEmails: shared }),
        project({ id: 'p2', number: '2026-042', name: 'Umbau Halle West', participantEmails: shared }),
      ],
    );
    assert.equal(result.match, null);
    assert.equal(result.ambiguous, true);
  });

  test('eine Projektnummer schlägt eine gleichzeitige Beteiligtenübereinstimmung', () => {
    const shared = ['architekt@planwerk.de', 'bauleitung@hochtief.de'];
    const result = matchMailToProject(
      { subject: '2026-042 Freigabe', bodyPreview: '', participantEmails: shared },
      [
        project({ id: 'p1', number: '2026-041', participantEmails: shared }),
        project({ id: 'p2', number: '2026-042', name: 'Umbau Halle West', participantEmails: shared }),
      ],
    );
    assert.equal(result.match?.projectId, 'p2');
  });

  test('ein Alias im Betreff zählt wie eine Projektnummer', () => {
    const result = matchMailToProject(
      { subject: 'Bauvorhaben Seestraße – Nachtrag', bodyPreview: '', participantEmails: ['x@y.de'] },
      [project({ aliases: ['Bauvorhaben Seestraße'] })],
    );
    assert.equal(result.match?.projectId, 'p1');
  });

  test('abgeschlossene Projekte werden abgewertet', () => {
    const shared = ['architekt@planwerk.de', 'bauleitung@hochtief.de'];
    const result = matchMailToProject(
      { subject: 'Neue Anfrage', bodyPreview: '', participantEmails: shared },
      [project({ isActive: false, participantEmails: shared })],
    );
    assert.equal(result.match, null, 'abgeschlossenes Projekt zieht 75 auf 45 herunter');
  });

  test('ohne jedes Signal gibt es keine Zuordnung', () => {
    const result = matchMailToProject(
      { subject: 'Newsletter', bodyPreview: '', participantEmails: ['info@fremd.de'] },
      [project()],
    );
    assert.equal(result.match, null);
    assert.equal(result.ambiguous, false);
  });

  test('nur die Firmendomain reicht nie für eine automatische Zuordnung', () => {
    const result = matchMailToProject(
      { subject: 'Hallo', bodyPreview: '', participantEmails: ['ganz.neu@planwerk.de'] },
      [project({ participantEmails: [] })],
    );
    assert.equal(result.match, null);
    assert.equal(result.ranked[0]?.score, 25);
  });
});
