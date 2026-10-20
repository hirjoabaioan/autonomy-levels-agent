import type { MeterSink } from '../metering/meter.js';
import { costUsd } from '../metering/pricing.js';
import type { ChatResponse, Message, Provider, ToolResultMessage } from '../providers/types.js';
import type { PreparedAction } from './pending.js';
import { wrapToolResult } from './prompts.js';
import { TOOL_BY_NAME, UserError, bindIdentity, isPendingResult, toolSpecs, type ToolContext } from './tools.js';

export const MAX_ITERATIONS = 4;

export type AgentResult =
  | { kind: 'text'; text: string; requested: string[] }
  | { kind: 'pending'; action: PreparedAction; requested: string[] }
  | { kind: 'error'; reason: string; requested: string[] };

export interface AgentOptions {
  provider: Provider;
  model: string;
  system: string;
  messages: Message[];
  ctx: ToolContext;
  conversationId: string;
  meter?: MeterSink;
  /** Monotonic millisecond timer; replaced in replay so latency comes from the fixtures. */
  timer?: () => number;
  maxIterations?: number;
  timeoutMs?: number;
}

const errorResult = (message: string) => JSON.stringify({ error: message });

export async function runAgent(o: AgentOptions): Promise<AgentResult> {
  const timer = o.timer ?? (() => performance.now());
  const specs = toolSpecs();
  const messages = [...o.messages];
  const requested: string[] = [];

  for (let iteration = 1; iteration <= (o.maxIterations ?? MAX_ITERATIONS); iteration++) {
    const t0 = timer();
    let res: ChatResponse;
    try {
      res = await o.provider.chat({ model: o.model, system: o.system, messages, tools: specs, timeoutMs: o.timeoutMs ?? 30_000 });
    } catch (e) {
      o.meter?.record({
        conversationId: o.conversationId, iteration, provider: o.provider.name, model: o.model, success: false,
        tokensIn: 0, tokensOut: 0, costUsd: null, durationMs: timer() - t0,
      });
      return { kind: 'error', reason: `provider_failure: ${e instanceof Error ? e.message : String(e)}`, requested };
    }
    o.meter?.record({
      conversationId: o.conversationId, iteration, provider: o.provider.name, model: o.model, success: true,
      tokensIn: res.usage.in, tokensOut: res.usage.out, costUsd: costUsd(o.model, res.usage.in, res.usage.out), durationMs: timer() - t0,
    });

    const calls = res.toolCalls ?? [];
    if (calls.length === 0) return { kind: 'text', text: res.text ?? '', requested };
    messages.push({ role: 'assistant', content: res.text, toolCalls: calls });

    const results: ToolResultMessage[] = [];
    for (const call of calls) {
      requested.push(call.name);
      const reply = (content: string) => results.push({ id: call.id, name: call.name, content: wrapToolResult(call.name, content) });
      const tool = TOOL_BY_NAME.get(call.name);
      if (!tool) {
        reply(errorResult(`Unknown tool "${call.name}".`));
        continue;
      }
      const parsed = tool.input.safeParse(bindIdentity(call.args, o.ctx.sender));
      if (!parsed.success) {
        reply(errorResult(`Invalid arguments: ${parsed.error.message}`));
        continue;
      }
      try {
        const out = tool.run(parsed.data as never, o.ctx);
        if (isPendingResult(out)) return { kind: 'pending', action: out.pending_action, requested };
        reply(JSON.stringify(out));
      } catch (e) {
        if (!(e instanceof UserError)) throw e;
        reply(errorResult(e.message));
      }
    }
    messages.push({ role: 'tool', results });
  }
  return { kind: 'error', reason: 'max_iterations', requested };
}
