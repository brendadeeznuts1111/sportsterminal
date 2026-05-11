import { describe, expect, test } from 'bun:test';
import { initDatabase } from '../src/database';
import type { EnrichedWager } from '../src/risk/AlertEngine';
import { evaluateRules, upsertRule } from '../src/services/RulesEngine';

describe('RulesEngine featureThreshold', () => {
  test('triggers rules from behavioral feature vectors', async () => {
    const db = await initDatabase(':memory:');
    try {
      const saved = await upsertRule(db, {
        name: 'Chronic CLV beater',
        condition: {
          type: 'featureThreshold',
          threshold: 5,
          feature: 'clv_beat_count',
          op: '>=',
          value: 5,
        },
        action: 'flag',
        severity: 'high',
        enabled: true,
      });

      const wager: EnrichedWager = {
        WagerNumber: 1,
        AgentID: 'AG1',
        CustomerID: 'CUST1',
        Login: 'CUST1',
        WagerType: 'M',
        AmountWagered: 100,
        ToWinAmount: 90,
        VolumeAmount: 100,
        InsertDateTime: new Date().toISOString(),
        TicketWriter: 'Internet',
        ShortDesc: 'NBA test',
        VIP: '0',
        AgentLogin: 'AG1',
      };

      const triggered = await evaluateRules(
        db,
        wager,
        { behavioralFeatures: { clv_beat_count: 7 } },
        null,
        { clvPercent: 0, isBeater: false, source: 'none' }
      );

      expect(saved.id).toBeGreaterThan(0);
      expect(triggered.map((rule) => rule.name)).toContain('Chronic CLV beater');
    } finally {
      await db.close();
    }
  });
});
