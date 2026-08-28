import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyBucket, evaluateDeal, DEFAULT_RULE_CONFIG, type DealRuleInput } from './rules.js';

const NOW = new Date('2026-06-15T10:00:00Z');

function deal(overrides: Partial<DealRuleInput> = {}): DealRuleInput {
  return {
    stage: 'OPEN',
    nextAction: 'Angebot nachfassen',
    dueDate: null,
    followUpDate: null,
    lastOutboundAt: null,
    lastInboundAt: null,
    hasConfirmedMeeting: false,
    hasOverduePlannerTask: false,
    ...overrides,
  };
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 86400_000);
}

describe('evaluateDeal – nicht offen', () => {
  test('gewonnene und verlorene Deals sind nie offen', () => {
    for (const stage of ['WON', 'LOST', 'ON_HOLD'] as const) {
      const result = evaluateDeal(deal({ stage, nextAction: null }), DEFAULT_RULE_CONFIG, NOW);
      assert.equal(result.isOpen, false, `${stage} darf nicht offen sein`);
    }
  });

  test('eine Antwort des Kontakts schließt den Deal aus der Tagesliste aus', () => {
    const result = evaluateDeal(
      deal({ lastOutboundAt: daysAgo(30), lastInboundAt: daysAgo(2), nextAction: null }),
      DEFAULT_RULE_CONFIG,
      NOW,
    );
    assert.equal(result.isOpen, false);
    assert.ok(result.reasons.some((r) => r.includes('Antwort')));
  });

  test('ein bestätigter Termin setzt die Follow-up-Regel aus', () => {
    const result = evaluateDeal(
      deal({ lastOutboundAt: daysAgo(60), hasConfirmedMeeting: true }),
      DEFAULT_RULE_CONFIG,
      NOW,
    );
    assert.equal(result.isOpen, false);
  });

  test('eine Wiedervorlage in der Zukunft hält den Deal zurück', () => {
    const result = evaluateDeal(
      deal({ lastOutboundAt: daysAgo(60), followUpDate: new Date(NOW.getTime() + 5 * 86400_000) }),
      DEFAULT_RULE_CONFIG,
      NOW,
    );
    assert.equal(result.isOpen, false);
  });
});

describe('evaluateDeal – offen', () => {
  test('keine Antwort seit mehr als 14 Tagen macht den Deal offen', () => {
    const result = evaluateDeal(deal({ lastOutboundAt: daysAgo(20) }), DEFAULT_RULE_CONFIG, NOW);
    assert.equal(result.isOpen, true);
    assert.equal(result.suggestedStage, 'FOLLOW_UP_DUE');
    assert.ok(result.reasons.some((r) => r.includes('20 Tagen')));
  });

  test('genau an der Schwelle greift die Regel', () => {
    const result = evaluateDeal(deal({ lastOutboundAt: daysAgo(14) }), DEFAULT_RULE_CONFIG, NOW);
    assert.equal(result.isOpen, true);
  });

  test('einen Tag vor der Schwelle greift sie noch nicht', () => {
    const result = evaluateDeal(deal({ lastOutboundAt: daysAgo(13) }), DEFAULT_RULE_CONFIG, NOW);
    assert.equal(result.isOpen, false);
  });

  test('eine fehlende nächste Aktion macht den Deal offen', () => {
    const result = evaluateDeal(deal({ nextAction: null }), DEFAULT_RULE_CONFIG, NOW);
    assert.equal(result.isOpen, true);
    assert.ok(result.reasons.some((r) => r.includes('nächste Aktion')));
  });

  test('leerer Text zählt wie eine fehlende Aktion', () => {
    const result = evaluateDeal(deal({ nextAction: '   ' }), DEFAULT_RULE_CONFIG, NOW);
    assert.equal(result.isOpen, true);
  });

  test('ein überschrittenes Fälligkeitsdatum macht den Deal offen', () => {
    const result = evaluateDeal(deal({ dueDate: daysAgo(1) }), DEFAULT_RULE_CONFIG, NOW);
    assert.equal(result.isOpen, true);
    assert.ok(result.reasons.some((r) => r.includes('Fälligkeitsdatum')));
  });

  test('eine überfällige Planner-Aufgabe macht den Deal offen', () => {
    const result = evaluateDeal(deal({ hasOverduePlannerTask: true }), DEFAULT_RULE_CONFIG, NOW);
    assert.equal(result.isOpen, true);
  });

  test('die Schwelle ist konfigurierbar', () => {
    const result = evaluateDeal(
      deal({ lastOutboundAt: daysAgo(20) }),
      { ...DEFAULT_RULE_CONFIG, followUpAfterDays: 42 },
      NOW,
    );
    assert.equal(result.isOpen, false);
  });
});

describe('classifyBucket', () => {
  test('ohne jede Kommunikation ist es Kaltakquise', () => {
    assert.equal(classifyBucket({ lastOutboundAt: null, lastInboundAt: null }, DEFAULT_RULE_CONFIG, NOW), 'C_COLD_OUTREACH');
  });

  test('letzter Kontakt vor über einem halben Jahr ist Reaktivierung', () => {
    assert.equal(
      classifyBucket({ lastOutboundAt: daysAgo(200), lastInboundAt: null }, DEFAULT_RULE_CONFIG, NOW),
      'B_REACTIVATION',
    );
  });

  test('kürzlicher Kontakt ist Follow-up', () => {
    assert.equal(
      classifyBucket({ lastOutboundAt: daysAgo(20), lastInboundAt: null }, DEFAULT_RULE_CONFIG, NOW),
      'A_FOLLOW_UP',
    );
  });

  test('der jüngste Kontakt entscheidet, egal aus welcher Richtung', () => {
    assert.equal(
      classifyBucket({ lastOutboundAt: daysAgo(300), lastInboundAt: daysAgo(10) }, DEFAULT_RULE_CONFIG, NOW),
      'A_FOLLOW_UP',
    );
  });
});
