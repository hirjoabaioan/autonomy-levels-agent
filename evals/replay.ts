import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatResponse, Provider } from '../src/providers/types.js';

export interface RecordedStep {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
  usage: { in: number; out: number };
  latencyMs: number;
}

export interface FixtureCase {
  /** Present only on cases that are wrong on purpose; the value says why. */
  deliberateFailure?: string;
  /** Model responses in the order the agent asks for them across the whole conversation. */
  steps: Record<string, RecordedStep>;
}

export interface Fixtures {
  route: { provider: string; model: string };
  cases: Record<string, FixtureCase>;
}

export function loadFixtures(dir: string): Fixtures {
  const merged: Fixtures = { route: { provider: 'replay', model: 'claude-haiku-4-5' }, cases: {} };
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const data = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Fixtures;
    merged.route = data.route;
    Object.assign(merged.cases, data.cases);
  }
  return merged;
}

/** A virtual timer lets replay report the recorded latency without sleeping. */
export class VirtualTimer {
  t = 0;
  now = (): number => this.t;
}

/** Serves recorded responses by (case, call number). Never touches the network. */
export class ReplayProvider implements Provider {
  readonly name = 'replay';
  private caseId = '';
  private call = 0;

  constructor(
    private fixtures: Fixtures,
    private timer: VirtualTimer,
  ) {}

  begin(caseId: string): void {
    this.caseId = caseId;
    this.call = 0;
  }

  async chat(): Promise<ChatResponse> {
    const rec = this.fixtures.cases[this.caseId]?.steps[String(++this.call)];
    if (!rec) throw new Error(`No recorded response for case ${this.caseId} call ${this.call}`);
    this.timer.t += rec.latencyMs;
    return {
      text: rec.text,
      toolCalls: rec.toolCalls?.map((c, i) => ({ id: `replay-${this.call}-${i}`, name: c.name, args: c.args })),
      usage: rec.usage,
    };
  }
}
