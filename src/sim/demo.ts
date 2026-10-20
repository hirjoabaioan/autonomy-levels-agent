import { createApp } from '../app.js';
import { Meter } from '../metering/meter.js';
import { providerFromSpec } from '../providers/index.js';
import { handleLine, type Session } from './commands.js';

const { provider, model } = providerFromSpec(process.env.LLM);
const meter = new Meter();
const app = createApp({ provider, model, meter, level: 'auto' });
const maria = app.store.patients[0];
const andrei = app.store.patients[1];
const session: Session = { phone: maria?.phone ?? '', seq: 0 };

const script = [
  `-- ${maria?.name} asks a question (auto: the bot replies directly)`,
  'What are your opening hours?',
  '-- she books; nothing happens until she confirms',
  'I would like to book a cleaning',
  'yes',
  '-- cancelling needs two confirmations',
  'Please cancel my appointment',
  'yes',
  'yes',
  '-- an unknown number cannot act on appointments',
  '/as +15550999999',
  'Please cancel my appointment',
  '-- suggest level: the bot drafts, a human sends',
  `/as ${andrei?.phone}`,
  '/level suggest',
  'When is my appointment?',
  '/drafts',
  '/approve 1',
  '-- asking for a person switches the chat to operator-only',
  'I want to talk to a human',
  'hello?',
  '/handoffs',
  `/release ${andrei?.phone}`,
];

for (const line of script) {
  if (line.startsWith('--')) {
    console.log(`\n${line}`);
    continue;
  }
  console.log(`${line.startsWith('/') ? 'op' : `you(${session.phone.slice(-4)})`}> ${line}`);
  for (const l of (await handleLine(app, session, line)) ?? []) console.log(l);
}
meter.close();
console.log('\nRun `npm run report` for latency and cost per conversation.');
