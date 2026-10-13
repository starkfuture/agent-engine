import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Card } from './card.js';

// Cards always land on disk; Slack only when a webhook is configured AND the
// caller asked to post.
export class CardSink {
  constructor(
    private readonly outDir: string,
    private readonly webhook?: string,
  ) {}

  async emit(card: Card, name: string, post: boolean): Promise<string> {
    const dir = join(this.outDir, 'cards');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.md`);
    writeFileSync(file, card.markdown + '\n');
    if (post && this.webhook) {
      const res = await fetch(this.webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: card.text, blocks: card.blocks }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Slack webhook: HTTP ${res.status} ${await res.text()}`);
    }
    return file;
  }
}
