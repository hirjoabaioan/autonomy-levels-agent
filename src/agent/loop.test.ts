import { describe, expect, it } from 'vitest';
import { Meter } from '../metering/meter.js';
import { MockProvider } from '../providers/mock.js';
import { ProviderError } from '../providers/types.js';
import { seededStore } from '../domain/seed.js';
import { ANCHOR, MARIA, NOW } from '../testing/helpers.js';
import { MAX_ITERATIONS, runAgent } from './loop.js';

function run(provider: MockProvider, meter?: Meter) {
  const store = seededStore(42, ANCHOR);
  return runAgent({
    provider, model: 'claude-haiku-4-5', system: 's', messages: [{ role: 'user', content: 'hi' }],
    ctx: { store, now: NOW, sender: store.patientByPhone(MARIA) }, conversationId: 'c1', meter, timer: () => 0,
  });
}

describe('agent loop', () => {
  it('stops after 4 iterations', async () => {
    const provider = new MockProvider();
    for (let i = 0; i < 6; i++) provider.push({ toolCalls: [{ name: 'list_services', args: {} }] });
    const res = await run(provider);
    expect(res).toMatchObject({ kind: 'error', reason: 'max_iterations' });
    expect(provider.calls).toHaveLength(MAX_ITERATIONS);
  });

  it('records one meter row per LLM call with the iteration number', async () => {
    const meter = new Meter(':memory:');
    const provider = new MockProvider().push(
      { toolCalls: [{ name: 'clinic_info', args: {} }], usage: { in: 1000, out: 100 } },
      { text: 'We open at nine.', usage: { in: 1200, out: 30 } },
    );
    const res = await run(provider, meter);
    expect(res).toMatchObject({ kind: 'text', requested: ['clinic_info'] });
    const rows = meter.rows();
    expect(rows.map((r) => [r.conversation_id, r.iteration, r.provider, r.model, r.tokens_in, r.tokens_out])).toEqual([
      ['c1', 1, 'mock', 'claude-haiku-4-5', 1000, 100],
      ['c1', 2, 'mock', 'claude-haiku-4-5', 1200, 30],
    ]);
    expect(rows[0]?.cost_usd).toBeCloseTo((1000 * 1 + 100 * 5) / 1e6);
  });

  it('returns an error (not a throw) on provider failure and still meters it', async () => {
    const meter = new Meter(':memory:');
    const res = await run(new MockProvider().push(new ProviderError('server', 'down')), meter);
    expect(res).toMatchObject({ kind: 'error' });
    expect(meter.rows()[0]?.success).toBe(0);
  });

  it('turns invalid arguments and unknown tools into tool errors the model can see', async () => {
    const provider = new MockProvider().push(
      { toolCalls: [{ name: 'find_free_slots', args: { serviceId: 5 } }, { name: 'drop_database', args: {} }] },
      { text: 'ok' },
    );
    const res = await run(provider);
    expect(res).toMatchObject({ kind: 'text', requested: ['find_free_slots', 'drop_database'] });
    const last = provider.calls[1]?.messages.at(-1);
    expect(last?.role === 'tool' && last.results.map((r) => r.content.includes('"error"'))).toEqual([true, true]);
  });

  it('wraps tool output as data', async () => {
    const provider = new MockProvider().push({ toolCalls: [{ name: 'clinic_info', args: {} }] }, { text: 'ok' });
    await run(provider);
    const last = provider.calls[1]?.messages.at(-1);
    expect(last?.role === 'tool' && last.results[0]?.content).toContain('<tool_result name="clinic_info">');
  });
});
