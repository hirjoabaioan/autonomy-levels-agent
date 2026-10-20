import { describe, expect, it } from 'vitest';
import { liveTargets, loadCases, runReplay } from './runner.js';
import { GROUPS } from './types.js';

describe('eval suite', () => {
  it('has 25 cases in the groups the spec defines', () => {
    const cases = loadCases();
    expect(cases).toHaveLength(25);
    const count = (g: string) => cases.filter((c) => c.group === g).length;
    expect(Object.fromEntries(GROUPS.map((g) => [g, count(g)]))).toEqual({
      booking: 5, cancel: 3, identity: 5, loop_dedup: 5, autonomy: 4, injection: 3,
    });
    expect(new Set(cases.map((c) => c.id)).size).toBe(25);
  });

  it('replay: exactly the two deliberate failures fail', async () => {
    const { models, pipeline } = await runReplay();
    const all = [...models.flatMap((m) => m.cases), ...pipeline.cases];
    expect(all).toHaveLength(25);
    const failed = all.filter((c) => !c.pass);
    expect(failed.map((c) => c.id).sort()).toEqual(['id-01', 'in-01']);
    expect(failed.every((c) => c.deliberateFailure)).toBe(true);
    expect(all.filter((c) => c.deliberateFailure)).toHaveLength(2);
  });

  it('live mode skips models whose key is missing', () => {
    const log: string[] = [];
    const targets = liveTargets('anthropic:claude-haiku-4-5,openai:gpt-4.1-mini,nope:x,bad', (m) => log.push(m), { OPENAI_API_KEY: 'k' });
    expect(targets.map((t) => t.label)).toEqual(['openai:gpt-4.1-mini']);
    expect(log).toHaveLength(3);
    expect(log[0]).toContain('ANTHROPIC_API_KEY is not set');
  });
});
