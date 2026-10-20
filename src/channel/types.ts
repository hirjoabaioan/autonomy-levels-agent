export interface InboundMessage {
  channel: string;
  /** Provider-assigned id; the dedup key together with `channel`. */
  externalId: string;
  from: string;
  /** The business number the message was sent to. */
  to: string;
  body: string;
  receivedAt: number;
  fromMe?: boolean;
  system?: boolean;
}

export interface OutboundMessage {
  channel: string;
  from: string;
  to: string;
  body: string;
}

export interface Transport {
  /** Throws when delivery fails. */
  send(msg: OutboundMessage): Promise<void>;
}
