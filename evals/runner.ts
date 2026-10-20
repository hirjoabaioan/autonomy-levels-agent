import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.js';
import type { Outcome } from '../src/autonomy/dispatcher.js';
import { MIN } from '../src/domain/time.js';
import { Meter } from '../src/metering/meter.js';
import { percentile } from '../src/metering/report.js';
import { KEY_VARS, providersFromEnv } from '../src/providers/index.js';
import type { Provider } from '../src/providers/types.js';
import { loadFixtures, ReplayProvider, VirtualTimer, type Fixtures } from './replay.js';
import { scoreFinal, scoreStep } from './scorers.js';
import { GROUPS, PIPELINE_GROUPS, type EvalCase, type Group } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// Fixed clock and seed anchor (a Monday) so every case sees identical data and relative dates.
const ANCHOR = Date.parse('2026-10-19T00:00:00Z');
const START = ANCHOR + 8 * 3600_000;
const DEFAULT_SENDER = '+15550100001';

export interface CaseResult {
  id: string;
  group: Group;
  pass: boolean;
  failures: string[];
  durations: number[];
  costUsd: number;
  costIncomplete: boolean;
  deliberateFailure?: string;
}

export interface RunSummary {
  label: string;
  cases: CaseResult[];
}

export function loadCases(dir = join(HERE, 'cases')): EvalCase[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .flatMap((f) => readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as EvalCase));
}

interface Target {
  label: string;
  provider: Provider;
  model: string;
  timer?: () => number;
  begin?: (caseId: string) => void;
}

export async function runCase(c: EvalCase, t: Target, meter: Meter, fixtures?: Fixtures): Promise<CaseResult> {
  const clock = { t: START };
  const rowsBefore = meter.rows().length;
  t.begin?.(c.id);
  const app = createApp({
    provider: t.provider, model: t.model, level: c.level ?? 'auto', now: () => clock.t, anchor: ANCHOR, meter, timer: t.timer,
    business: c.rateLimitMax ? { rateLimit: { maxReplies: c.rateLimitMax, windowMs: 10 * MIN } } : undefined,
  });
  for (const n of c.notes ?? []) app.store.setNote(n.appointmentId, n.text);
  const to = app.business.numbers[0] as string;

  const failures: string[] = [];
  let offset = 0;
  for (const [i, step] of c.steps.entries()) {
    offset = step.atMs ?? (i === 0 ? 0 : offset + MIN);
    clock.t = START + offset;
    for (const w of step.world ?? []) {
      app.store.book({ ...w.book, start: Date.parse(w.book.start) });
    }
    app.transport.failSends = Boolean(step.failSend);
    const phone = step.from ?? c.sender ?? DEFAULT_SENDER;
    const msg = {
      channel: 'whatsapp', externalId: `${c.id}-m${i + 1}`, from: phone, to, body: step.body, receivedAt: clock.t, fromMe: step.fromMe,
    };
    let duplicates = 0;
    if (step.stuck) {
      app.receive(msg);
      app.queue.claim(1);
      clock.t += 11 * MIN;
    } else {
      for (let d = 0; d < (step.deliveries ?? 1); d++) if (!app.receive(msg)) duplicates++;
    }
    const run = await app.worker.runOnce();
    if (process.env.EVAL_TRACE) {
      const o = run.outcomes[0] as Outcome | undefined;
      console.error(`[${c.id} #${i + 1}] > ${step.body}\n    < ${JSON.stringify(o)?.slice(0, 600)}`);
    }
    failures.push(...scoreStep(step, { outcome: run.outcomes[0] as Outcome | undefined, app, phone, duplicates, reclaimed: run.reclaimed }, `step ${i + 1}`));
  }
  failures.push(...scoreFinal(c.final, app));

  const rows = meter.rows().slice(rowsBefore).filter((r) => r.success === 1);
  return {
    id: c.id, group: c.group, pass: failures.length === 0, failures,
    durations: rows.map((r) => r.duration_ms),
    costUsd: rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
    costIncomplete: rows.some((r) => r.cost_usd === null),
    deliberateFailure: fixtures?.cases[c.id]?.deliberateFailure,
  };
}

async function runCases(cases: EvalCase[], t: Target, fixtures?: Fixtures): Promise<CaseResult[]> {
  const meter = new Meter(':memory:');
  const out: CaseResult[] = [];
  for (const c of cases) out.push(await runCase(c, t, meter, fixtures));
  meter.close();
  return out;
}

function replayTarget(fixtures: Fixtures): Target {
  const timer = new VirtualTimer();
  const provider = new ReplayProvider(fixtures, timer);
  return { label: `replay (${fixtures.route.model}, hand-authored)`, provider, model: fixtures.route.model, timer: timer.now, begin: (id) => provider.begin(id) };
}

/** Pipeline guarantees never need a live model, so they always run on the recorded replies. */
async function runAll(cases: EvalCase[], llm: Target[], fixtures: Fixtures): Promise<{ models: RunSummary[]; pipeline: RunSummary }> {
  const isPipeline = (c: EvalCase) => PIPELINE_GROUPS.includes(c.group);
  const pipeline = { label: 'pipeline guarantees (recorded replies)', cases: await runCases(cases.filter(isPipeline), replayTarget(fixtures), fixtures) };
  const models: RunSummary[] = [];
  for (const t of llm) {
    console.log(`running ${cases.filter((c) => !isPipeline(c)).length} cases against ${t.label} ...`);
    models.push({ label: t.label, cases: await runCases(cases.filter((c) => !isPipeline(c)), t, t.begin ? fixtures : undefined) });
  }
  return { models, pipeline };
}

export async function runReplay(): Promise<{ models: RunSummary[]; pipeline: RunSummary }> {
  const fixtures = loadFixtures(join(HERE, 'fixtures'));
  return runAll(loadCases(), [replayTarget(fixtures)], fixtures);
}

/** `--models` is a comma list of provider:model; models whose API key is missing are skipped. */
export function liveTargets(spec: string, log: (m: string) => void = console.log, env = process.env): Target[] {
  const available = providersFromEnv(env);
  const targets: Target[] = [];
  for (const item of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = item.indexOf(':');
    const provider = item.slice(0, i);
    const model = item.slice(i + 1);
    if (i < 1 || !model) log(`skipping "${item}": expected provider:model`);
    else if (!(provider in KEY_VARS)) log(`skipping "${item}": unknown provider (use ${Object.keys(KEY_VARS).join(', ')})`);
    else if (!available[provider]) log(`skipping "${item}": ${KEY_VARS[provider]} is not set`);
    else targets.push({ label: item, provider: available[provider] as Provider, model });
  }
  return targets;
}

const pct = (n: number, d: number) => (d === 0 ? '-' : `${((n / d) * 100).toFixed(0)}% (${n}/${d})`);

function rows(run: RunSummary, groups: readonly Group[]): string[] {
  const line = (name: string, cs: CaseResult[]) => {
    const d = cs.flatMap((c) => c.durations);
    const cost = cs.reduce((a, c) => a + c.costUsd, 0);
    const star = cs.some((c) => c.costIncomplete) ? '*' : '';
    return `| ${run.label} | ${name} | ${pct(cs.filter((c) => c.pass).length, cs.length)} | ${d.length ? cost.toFixed(5) + star : 'n/a'} | ${d.length ? percentile(d, 50) : '-'} | ${d.length ? percentile(d, 95) : '-'} |`;
  };
  const per = groups.map((g) => line(g, run.cases.filter((c) => c.group === g)));
  return [...per, line('**all**', run.cases)];
}

export function formatMarkdown(models: RunSummary[], pipeline: RunSummary, mode: 'live' | 'replay', stamp: string): string {
  const header = ['| Model | Group | Pass | Cost (USD) | p50 ms | p95 ms |', '|---|---|---|---|---|---|'];
  const llmGroups = GROUPS.filter((g) => !PIPELINE_GROUPS.includes(g));
  const lines = [
    '# Eval results',
    '',
    mode === 'replay'
      ? 'Mode: offline replay of hand-authored fixtures (no network). Latency is the recorded latency; cost is computed from recorded token counts at list prices.'
      : `Mode: live, run at ${stamp}. Cost and latency come from the meter (one row per LLM call).`,
    '',
    '## Model behaviour',
    '',
    ...header,
    ...models.flatMap((m) => rows(m, llmGroups)),
    '',
    '## Pipeline guarantees',
    '',
    'Dedup, self-echo, loop breaker, rate limit, stuck-row reclaim and the three autonomy levels do not depend on the model, so they always run on recorded replies.',
    '',
    ...header,
    ...rows(pipeline, PIPELINE_GROUPS),
  ];
  if (models.some((m) => m.cases.some((c) => c.costIncomplete))) lines.push('', '`*` some calls used a model without a price entry and are excluded from the cost.');
  for (const r of [...models, pipeline]) {
    const failed = r.cases.filter((c) => !c.pass);
    if (failed.length === 0) continue;
    lines.push('', `## Failures: ${r.label}`, '');
    for (const c of failed) lines.push(`- \`${c.id}\` (${c.group})${c.deliberateFailure ? ' **deliberate**' : ''}: ${c.failures.join('; ')}`);
  }
  return lines.join('\n') + '\n';
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const replay = argv.includes('--replay');
  const only = process.env.EVAL_CASES?.split(",");
  const cases = loadCases().filter((c) => !only || only.includes(c.id));
  const fixtures = loadFixtures(join(HERE, 'fixtures'));
  let llm: Target[];
  if (replay) {
    llm = [replayTarget(fixtures)];
  } else {
    llm = liveTargets(arg(argv, '--models') ?? '');
    if (llm.length === 0) {
      console.error('No runnable models. Pass --models provider:model[,..] with the matching API keys set (see .env.example), or use --replay.');
      return 2;
    }
  }
  const { models, pipeline } = await runAll(cases, llm, fixtures);

  const mode = replay ? 'replay' : 'live';
  const stamp = new Date().toISOString();
  const md = formatMarkdown(models, pipeline, mode, stamp);
  const outDir = arg(argv, '--out') ?? join(HERE, 'results');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${stamp.replace(/[:.]/g, '-')}.json`), JSON.stringify({ mode, stamp, models, pipeline }, null, 2) + '\n');
  writeFileSync(join(outDir, replay ? 'latest.md' : 'latest-live.md'), md);
  console.log(md);

  if (replay) {
    // Replay is a regression check: exactly the deliberately broken cases must fail, nothing else.
    const unexpected = [...models.flatMap((m) => m.cases), ...pipeline.cases].filter((c) => c.pass === Boolean(c.deliberateFailure));
    if (unexpected.length) {
      console.error(`Replay mismatch: ${unexpected.map((c) => c.id).join(', ')} did not score as the fixtures declare.`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
