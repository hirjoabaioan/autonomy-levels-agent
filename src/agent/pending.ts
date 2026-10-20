import { MIN } from '../domain/time.js';

export const PENDING_TTL_MS = 15 * MIN;

export type WriteToolName = 'book_appointment' | 'reschedule_appointment' | 'cancel_appointment';

/** A validated write request waiting for the customer to confirm it. */
export interface PreparedAction {
  tool: WriteToolName;
  /** Tool input with `patientId` already bound to the resolved sender. */
  args: Record<string, unknown>;
  summary: string;
  /** Confirmations needed before execution: 2 for cancellations. */
  required: 1 | 2;
}

export interface PendingAction extends PreparedAction {
  confirmations: number;
  createdAt: number;
  expiresAt: number;
}

export type PendingState = { state: 'none' } | { state: 'expired' } | { state: 'active'; action: PendingAction };

export class PendingStore {
  private byKey = new Map<string, PendingAction>();

  create(key: string, action: PreparedAction, now: number): PendingAction {
    const p: PendingAction = { ...action, confirmations: 0, createdAt: now, expiresAt: now + PENDING_TTL_MS };
    this.byKey.set(key, p);
    return p;
  }

  peek(key: string, now: number): PendingState {
    const p = this.byKey.get(key);
    if (!p) return { state: 'none' };
    if (now >= p.expiresAt) {
      this.byKey.delete(key);
      return { state: 'expired' };
    }
    return { state: 'active', action: p };
  }

  clear(key: string): void {
    this.byKey.delete(key);
  }
}

export type Verdict = 'confirm' | 'decline' | 'other';

const normalize = (s: string): string =>
  s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

const CORE = 'yes|yep|yeah|yup|ok|okay|sure|confirm|confirmed|da|confirma|confirmam|confirmat|sigur|desigur|bine|perfect';
const TAIL = 'yes|ok|okay|confirm|confirmed|da|please|thanks|thank you|te rog|va rog|multumesc|mersi';
const CONFIRM = new RegExp(
  `^(?:(?:${CORE})(?: (?:${TAIL}))*|go ahead(?: please)?|do it|please confirm|that works|sounds good|de acord)$`,
);
const DECLINE = /^(?:no|nope|nah|nu|no thanks|no thank you|nu multumesc|never mind|nevermind|stop|dont|nu mai)$/;

/** Whole-message match only: "yes but make it 3pm" is a new request, not a confirmation. */
export function matchConfirmation(text: string): Verdict {
  if (text.trim() === '👍') return 'confirm';
  const t = normalize(text);
  if (CONFIRM.test(t)) return 'confirm';
  if (DECLINE.test(t)) return 'decline';
  return 'other';
}
