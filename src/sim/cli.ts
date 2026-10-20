import { createInterface } from 'node:readline/promises';
import { createApp } from '../app.js';
import { Meter } from '../metering/meter.js';
import { providerFromSpec } from '../providers/index.js';
import { HELP, handleLine, type Session } from './commands.js';

const { provider, model } = providerFromSpec(process.env.LLM);
const meter = new Meter();
const app = createApp({ provider, model, meter, level: 'auto' });
const session: Session = { phone: app.store.patients[0]?.phone ?? '', seq: 0 };

console.log(`Harbor Dental sim. LLM: ${provider.name}:${model}. Level: ${app.business.level}.`);
console.log(`Chatting as ${session.phone} (${app.store.patients[0]?.name}).\n${HELP}\n`);

const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
rl.prompt();
for await (const line of rl) {
  const out = await handleLine(app, session, line);
  if (out === undefined) break;
  for (const l of out) console.log(l);
  // stdin may already be closed when input is piped; prompting then throws.
  if (!process.stdin.readableEnded) rl.prompt();
}
rl.close();
meter.close();
