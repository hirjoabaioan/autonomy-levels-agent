/** True when the sender already received `max` bot replies inside the window. */
export function rateLimitExceeded(replyTimes: number[], now: number, max: number, windowMs: number): boolean {
  return replyTimes.filter((t) => t > now - windowMs && t <= now).length >= max;
}
