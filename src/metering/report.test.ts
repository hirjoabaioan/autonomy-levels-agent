import { describe, expect, it } from 'vitest';
import { Meter } from './meter.js';
import { formatReport, percentile, perConversation } from './report.js';

describe('report', () => {
  it('computes nearest-rank percentiles', () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it('aggregates per conversation', () => {
    const meter = new Meter(':memory:');
    const rec = (c: string, iteration: number, ms: number, cost: number | null) =>
      meter.record({ conversationId: c, iteration, provider: 'p', model: 'm', success: true, tokensIn: 10, tokensOut: 5, costUsd: cost, durationMs: ms });
    rec('a', 1, 100, 0.01);
    rec('a', 2, 300, 0.02);
    rec('b', 1, 50, null);
    const stats = perConversation(meter.rows());
    expect(stats.find((s) => s.key === 'a')).toMatchObject({ calls: 2, iterations: 2, tokens: 30, p50Ms: 100, p95Ms: 300, costIncomplete: false });
    expect(stats.find((s) => s.key === 'a')?.costUsd).toBeCloseTo(0.03);
    expect(stats.find((s) => s.key === 'b')?.costIncomplete).toBe(true);
    expect(formatReport(meter.rows())).toContain('ALL');
    expect(formatReport([])).toBe('No calls recorded yet.');
  });
});
