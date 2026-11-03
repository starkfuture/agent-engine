import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card } from './card.js';
import type { FlushResult, PostKind, SlackOutbox } from './slack.js';

export interface EmitSlack {
  kind: PostKind;
  keys: string[]; // the rows this card is about: they pick the Slack thread
  broadcast: boolean; // show it in the channel when it lands in an older thread (in an issue's thread: exactly as given)
  issue?: string | undefined; // the issue it is about: its thread wins over the rows'
  repeat?: boolean | undefined; // a quiet reply in the issue's thread, or not posted at all
}

// Cards always land on disk; Slack only when an outbox is configured AND the
// caller asked to post. Posts are queued and sent by flush(), which never throws.
export class CardSink {
  constructor(
    private readonly outDir: string,
    readonly outbox?: SlackOutbox,
  ) {}

  emit(card: Card, name: string, slack?: EmitSlack): string {
    const dir = join(this.outDir, 'cards');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.md`);
    writeFileSync(file, card.markdown + '\n');
    if (slack && this.outbox) this.outbox.enqueue({ ...slack, message: { text: card.text, blocks: card.blocks }, file });
    return file;
  }

  async flush(log?: (s: string) => void): Promise<FlushResult | undefined> {
    return this.outbox?.flush(log);
  }
}
