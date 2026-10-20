import { describe, expect, it } from 'vitest';
import { wantsHuman } from './handoff.js';

describe('wantsHuman', () => {
  it.each(['I want a human', 'Let me talk to an operator', 'agent please', 'vreau un om', 'vreau o persoană', 'Persoana, vă rog', 'can I speak to someone?', 'vreau sa vorbesc cu cineva'])(
    'matches %s',
    (t) => expect(wantsHuman(t)).toBe(true),
  );
  it.each(['book a cleaning', 'I am a chemist', 'omelette', 'What are your hours?'])('ignores %s', (t) => expect(wantsHuman(t)).toBe(false));
});
