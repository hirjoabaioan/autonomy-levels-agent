import { pathToFileURL } from 'node:url';
import { Meter, type CallRow } from './meter.js';

export interface GroupStats {
  key: string;
  calls: number;
  iterations: number;
  tokens: number;
  p50Ms: number;
  p95Ms: number;
  costUsd: number;
  costIncomplete: boolean;
}

/** Nearest-rank percentile: the smallest value with at least p% of samples at or below it. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] as number;
}

export function summarize(key: string, rows: CallRow[]): GroupStats {
  const durations = rows.map((r) => r.duration_ms);
  return {
    key,
    calls: rows.length,
    iterations: Math.max(0, ...rows.map((r) => r.iteration)),
    tokens: rows.reduce((a, r) => a + r.tokens_in + r.tokens_out, 0),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    costUsd: rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
    costIncomplete: rows.some((r) => r.cost_usd === null),
  };
}

export function perConversation(rows: CallRow[]): GroupStats[] {
  const groups = new Map<string, CallRow[]>();
  for (const r of rows) groups.set(r.conversation_id, [...(groups.get(r.conversation_id) ?? []), r]);
  return [...groups].map(([k, rs]) => summarize(k, rs));
}

export function formatReport(rows: CallRow[]): string {
  if (rows.length === 0) return 'No calls recorded yet.';
  const usd = (s: GroupStats) => `$${s.costUsd.toFixed(5)}${s.costIncomplete ? '*' : ''}`;
  const line = (s: GroupStats) =>
    `${s.key.padEnd(34)} ${String(s.calls).padEnd(6)} ${String(s.iterations).padEnd(6)} ${String(s.tokens).padEnd(8)} ${String(s.p50Ms).padEnd(7)} ${String(s.p95Ms).padEnd(7)} ${usd(s)}`;
  const header = `${'conversation'.padEnd(34)} calls  iters  tokens   p50ms   p95ms   cost`;
  const lines = [header, ...perConversation(rows).map(line), '', line(summarize('ALL', rows))];
  if (rows.some((r) => r.cost_usd === null)) lines.push('', '* includes calls on a model without a price entry (not counted).');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const meter = new Meter();
  console.log(formatReport(meter.rows()));
  meter.close();
}
