import type { App } from '../app.js';
import { LEVELS, type Level } from '../autonomy/config.js';
import type { Outcome } from '../autonomy/dispatcher.js';

export interface Session {
  phone: string;
  seq: number;
}

export const HELP = `Type a message to chat as the current phone number. Commands:
  /as <phone>          chat as another number (try an unknown one)
  /drafts              list drafts waiting in the operator queue
  /approve <id>        send a draft as written
  /edit <id> <text>    send a draft with different text
  /discard <id>        drop a draft
  /level <off|suggest|auto>
  /release <phone>     end a human handoff for a sender
  /handoffs            list senders in operator-only mode
  /failsend <on|off>   make the channel fail, to see the draft fallback
  /patients            show the first patients and their numbers
  /help, /quit`;

function describe(o: Outcome): string {
  if (o.reply === 'sent') return `bot: ${o.body}`;
  if (o.reply === 'draft') return `[draft #${o.draftId} queued for the operator${o.skip ? `, ${o.skip}` : ''}] ${o.body}`;
  return `[no reply: ${o.skip}]`;
}

export async function chat(app: App, session: Session, text: string): Promise<string[]> {
  app.receive({
    channel: 'whatsapp', externalId: `sim-${++session.seq}`, from: session.phone,
    to: app.business.numbers[0] as string, body: text, receivedAt: app.now(),
  });
  const { outcomes } = await app.worker.runOnce();
  return outcomes.map(describe);
}

/** Returns the lines to print, or undefined for /quit. */
export async function handleLine(app: App, session: Session, line: string): Promise<string[] | undefined> {
  const text = line.trim();
  if (!text) return [];
  if (!text.startsWith('/')) return chat(app, session, text);
  const [cmd = '', ...rest] = text.split(/\s+/);
  const arg = rest[0] ?? '';
  switch (cmd) {
    case '/quit':
      return undefined;
    case '/help':
      return [HELP];
    case '/as':
      if (!arg) return ['usage: /as <phone>'];
      session.phone = arg;
      return [`now chatting as ${arg}${app.store.patientByPhone(arg) ? ` (${app.store.patientByPhone(arg)?.name})` : ' (unknown sender)'}`];
    case '/patients':
      return app.store.patients.slice(0, 5).map((p) => `${p.phone}  ${p.name}`);
    case '/level': {
      if (!(LEVELS as readonly string[]).includes(arg)) return [`usage: /level <${LEVELS.join('|')}>`];
      app.config.setLevel(app.business.id, arg as Level);
      return [`autonomy level is now ${arg}`];
    }
    case '/drafts': {
      const open = app.operator.listOpen();
      return open.length ? open.map((d) => `#${d.id} to ${d.phone} [${d.kind}, ${d.reason}]: ${d.body}`) : ['no open drafts'];
    }
    case '/approve':
    case '/edit': {
      const id = Number(arg);
      const edited = cmd === '/edit' ? rest.slice(1).join(' ') : undefined;
      if (!Number.isInteger(id) || (cmd === '/edit' && !edited)) return [`usage: ${cmd} <id>${cmd === '/edit' ? ' <text>' : ''}`];
      try {
        await app.dispatcher.approve(id, edited);
        return [`draft #${id} sent`];
      } catch (e) {
        return [`could not send: ${(e as Error).message}`];
      }
    }
    case '/discard':
      app.operator.discard(Number(arg));
      return [`draft #${arg} discarded`];
    case '/release':
      return [app.operator.release(arg) ? `released ${arg}` : `${arg} was not in handoff`];
    case '/handoffs': {
      const list = app.operator.handoffs();
      return list.length ? list.map((h) => `${h.phone} (${h.reason})`) : ['no handoffs'];
    }
    case '/failsend':
      app.transport.failSends = arg === 'on';
      return [`channel sends will ${arg === 'on' ? 'fail' : 'succeed'}`];
    default:
      return [`unknown command ${cmd}; try /help`];
  }
}
