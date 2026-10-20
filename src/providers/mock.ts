import type { ChatRequest, ChatResponse, Message, Provider, ToolCall } from './types.js';
import { ProviderError } from './types.js';

export interface MockReply {
  text?: string;
  toolCalls?: { name: string; args: Record<string, unknown>; id?: string }[];
  usage?: { in: number; out: number };
}

export type MockStep = MockReply | ProviderError | ((req: ChatRequest) => MockReply | ProviderError);

/** Scriptable provider for tests: each chat() call shifts one step off the queue. */
export class MockProvider implements Provider {
  readonly calls: ChatRequest[] = [];
  private queue: MockStep[] = [];
  private idSeq = 0;

  constructor(public readonly name = 'mock') {}

  push(...steps: MockStep[]): this {
    this.queue.push(...steps);
    return this;
  }

  get pending(): number {
    return this.queue.length;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.calls.push(req);
    const step = this.queue.shift();
    if (step === undefined) throw new Error('MockProvider: response queue is empty');
    const reply = typeof step === 'function' ? step(req) : step;
    if (reply instanceof ProviderError) throw reply;
    const toolCalls: ToolCall[] | undefined = reply.toolCalls?.map((c) => ({
      id: c.id ?? `mock-call-${++this.idSeq}`,
      name: c.name,
      args: c.args,
    }));
    return { text: reply.text, toolCalls, usage: reply.usage ?? { in: 100, out: 20 } };
  }
}

type Json = Record<string, unknown>;

function thisTurn(messages: Message[]): { user: string; calls: string[]; results: Map<string, Json> } {
  let at = messages.length - 1;
  while (at >= 0 && messages[at]?.role !== 'user') at--;
  const user = (messages[at] as { content: string } | undefined)?.content ?? '';
  const calls: string[] = [];
  const results = new Map<string, Json>();
  for (const m of messages.slice(at + 1)) {
    if (m.role === 'assistant') calls.push(...(m.toolCalls ?? []).map((c) => c.name));
    if (m.role === 'tool') {
      for (const r of m.results) {
        const body = /<tool_result[^>]*>\n([\s\S]*?)\n<\/tool_result>/.exec(r.content)?.[1] ?? '{}';
        results.set(r.name, JSON.parse(body) as Json);
      }
    }
  }
  return { user, calls, results };
}

/**
 * Keyword-driven stand-in for an LLM so `npm run sim` and `npm run demo` work without API keys.
 * It is not a model: it recognises a handful of intents and drives the real tools.
 */
export class RuleMockProvider implements Provider {
  readonly name = 'mock';

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const usage = { in: 400, out: 40 };
    const reply = (r: MockReply): ChatResponse => ({
      text: r.text,
      toolCalls: r.toolCalls?.map((c, i) => ({ id: `rule-${req.messages.length}-${i}`, name: c.name, args: c.args })),
      usage,
    });
    const { user, calls, results } = thisTurn(req.messages);
    const text = user.toLowerCase();
    const today = /Now: (\d{4}-\d{2}-\d{2})/.exec(req.system)?.[1] ?? '2026-01-01';
    const call = (name: string, args: Json = {}) => reply({ toolCalls: [{ name, args }] });
    const last = [...results.values()].pop();
    const error = typeof last?.error === 'string' ? last.error : undefined;
    if (error) return reply({ text: `Sorry, I could not do that: ${error}` });

    const appts = (results.get('my_appointments')?.appointments ?? []) as { id: string; service: string; dentist: string; start: string }[];
    const slots = (results.get('find_free_slots')?.slots ?? []) as { dentistId: string; start: string }[];
    const service = /fill/.test(text) ? 's-filling' : /whiten/.test(text) ? 's-whitening' : /check/.test(text) ? 's-checkup' : 's-cleaning';
    const listAppts = () =>
      appts.length ? `Your upcoming appointments:\n${appts.map((a) => `- ${a.id}: ${a.service} with ${a.dentist}, ${a.start}`).join('\n')}` : 'You have no upcoming appointments.';

    if (/cancel|anul/.test(text)) {
      if (!calls.includes('my_appointments')) return call('my_appointments');
      return appts[0] ? call('cancel_appointment', { appointmentId: appts[0].id }) : reply({ text: listAppts() });
    }
    if (/reschedule|move|change|reprogram|muta/.test(text)) {
      if (!calls.includes('my_appointments')) return call('my_appointments');
      if (!appts[0]) return reply({ text: listAppts() });
      if (!calls.includes('find_free_slots')) return call('find_free_slots', { fromDate: today });
      return slots[0] ? call('reschedule_appointment', { appointmentId: appts[0].id, start: slots[0].start }) : reply({ text: 'No free slots found soon.' });
    }
    if (/my appointment|when is|programarile mele|programarea mea/.test(text)) {
      return calls.includes('my_appointments') ? reply({ text: listAppts() }) : call('my_appointments');
    }
    if (/book|appointment|schedule|programare|programa/.test(text)) {
      if (!calls.includes('find_free_slots')) return call('find_free_slots', { fromDate: today, serviceId: service });
      return slots[0]
        ? call('book_appointment', { dentistId: slots[0].dentistId, serviceId: service, start: slots[0].start })
        : reply({ text: 'I could not find a free slot in the next two weeks.' });
    }
    if (/open|hours|address|where|located|program|adres/.test(text)) {
      return calls.includes('clinic_info')
        ? reply({ text: 'We are at 12 Quay Street, Harborview. Open Mon-Fri 09:00-17:00 UTC.' })
        : call('clinic_info');
    }
    if (/service|price|cost|how much|pret/.test(text)) {
      const list = (results.get('list_services')?.services ?? []) as { name: string; minutes: number; priceUsd: number }[];
      return calls.includes('list_services')
        ? reply({ text: list.map((s) => `${s.name}: ${s.minutes} min, $${s.priceUsd}`).join('\n') })
        : call('list_services');
    }
    return reply({ text: 'Hi! I can book, reschedule or cancel appointments, and answer questions about the clinic. What do you need?' });
  }
}
