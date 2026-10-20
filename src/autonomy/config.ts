import { MIN } from '../domain/time.js';

export const LEVELS = ['off', 'suggest', 'auto'] as const;
export type Level = (typeof LEVELS)[number];

export interface BusinessConfig {
  id: string;
  name: string;
  /** The business's own numbers: a message from one of them is a self-echo. */
  numbers: string[];
  level: Level;
  channels: Record<string, { enabled: boolean }>;
  rateLimit: { maxReplies: number; windowMs: number };
  loop: { k: number; gapMs: number; similarity: number };
}

export function harborDental(overrides: Partial<BusinessConfig> = {}): BusinessConfig {
  return {
    id: 'harbor-dental',
    name: 'Harbor Dental',
    numbers: ['+15550190000', '+15550190001'],
    level: 'auto',
    channels: { whatsapp: { enabled: true } },
    rateLimit: { maxReplies: 6, windowMs: 10 * MIN },
    loop: { k: 3, gapMs: 10_000, similarity: 0.8 },
    ...overrides,
  };
}

export class ConfigStore {
  constructor(private businesses: BusinessConfig[]) {}

  forNumber(number: string): BusinessConfig | undefined {
    return this.businesses.find((b) => b.numbers.includes(number));
  }

  get(id: string): BusinessConfig | undefined {
    return this.businesses.find((b) => b.id === id);
  }

  setLevel(id: string, level: Level): void {
    const b = this.get(id);
    if (!b) throw new Error(`unknown business ${id}`);
    b.level = level;
  }
}
