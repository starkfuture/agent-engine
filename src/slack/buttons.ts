import { z } from 'zod';
import { MUTE_DAYS, type Click, type Disposition, type FixState, type Issue, type Issues } from '../patrol/issues.js';
import { queueRootUpdate, type SlackOutbox } from '../output/slack.js';

// The buttons on an issue's Slack message: "On it" and "Not an issue", and
// Undo. A click is recorded on the issue (patrol/issues.ts) and changes what
// the patrol posts and investigates (runner.ts); Slack gets one update of that
// message and a reply only the clicker sees. Nothing is posted to the channel.
// Anyone in the channel may click; the issue's events say who did. With the
// fix App configured, a third button, Draft a fix, goes through the same
// checks to src/fix/draft.ts.

export const ACTION: Record<Click, string> = { acknowledged: 'issue_on_it', dismissed: 'issue_not_an_issue', undo: 'issue_undo' };
const CLICK = Object.fromEntries(Object.entries(ACTION).map(([k, v]) => [v, k as Click])) as Record<string, Click>;
export const FIX_ACTION = 'issue_draft_fix';

const hhmm = (iso: string) => `${iso.slice(11, 16)}Z`;
const day = (iso: string) => iso.slice(5, 10);
const when = (iso: string) => `${day(iso)} ${hhmm(iso)}`;
const plain = (text: string) => ({ type: 'plain_text', text });
const button = (click: Click, issue: string, text: string, extra: Record<string, unknown> = {}) => ({ type: 'button', action_id: ACTION[click], text: plain(text), value: issue, ...extra });

const NOT_AN_ISSUE_CONFIRM = {
  title: plain('Not an issue?'),
  text: plain(`Its reports won't be posted and its rows get no AI run until it resolves, at most ${MUTE_DAYS} days. A protected journey or a rise to critical still posts. Undo is on the message.`),
  confirm: plain('Not an issue'),
  deny: plain('Cancel'),
  style: 'danger',
};

// The blocks under the issue's first message: who clicked what, and the buttons that apply.
// `fix`: Draft a fix is on, and where the issue's fix stands.
export function issueControls(issue: Issue, d: Disposition | undefined, before: Array<{ by: string; at: string }> = [], fix?: { state: FixState | undefined }): unknown[] {
  const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
  if (issue.status === 'resolved') return [context(`✅ ${issue.id} resolved at ${when(issue.resolved_at ?? '')}`)];
  const lines: string[] = [];
  if (d?.kind === 'acknowledged') lines.push(`👀 On it: <@${d.by}> since ${when(d.at)}. Reports stay in the thread; no daily reminder.`);
  if (d?.kind === 'dismissed') lines.push(`🔕 Not an issue: <@${d.by}> at ${when(d.at)}. Muted until it resolves, at most until ${when(d.until ?? '')}.`);
  if (!d && before.length) lines.push(`Marked Not an issue before by <@${before.at(-1)!.by}> on ${day(before.at(-1)!.at)}${before.length > 1 ? ` (${before.length} times)` : ''}.`);
  const f = fix?.state;
  if (f?.kind === 'pending') lines.push(`🛠 Drafting a fix in ${f.repo}: asked by <@${f.by}> at ${when(f.at)}.`);
  if (f?.kind === 'drafted') lines.push(`🛠 Draft fix: <${f.url}|${f.repo}#${f.number}>, asked by <@${f.by}>. Review it before marking it ready.`);
  const notAnIssue = button('dismissed', issue.id, 'Not an issue', { confirm: NOT_AN_ISSUE_CONFIRM });
  const buttons = !d ? [button('acknowledged', issue.id, 'On it', { style: 'primary' }), notAnIssue] : d.kind === 'acknowledged' ? [notAnIssue, button('undo', issue.id, 'Undo')] : [button('undo', issue.id, 'Undo')];
  if (fix && f?.kind !== 'pending') buttons.push({ type: 'button', action_id: FIX_ACTION, text: plain('Draft a fix'), value: issue.id });
  return [...(lines.length ? [context(lines.join('\n'))] : []), { type: 'actions', block_id: 'issue_buttons', elements: buttons }];
}

// The outbox's `controls`: the blocks for an issue as it now stands. `fix`:
// Draft a fix is on (its GitHub App is configured).
export function controlsFor(issues: Issues, now: () => Date = () => new Date(), fix = false): (id: string) => unknown[] | undefined {
  return (id) => {
    const i = issues.get(id);
    return i && issueControls(i, issues.disposition(id, now()), issues.dismissals(id), fix ? { state: issues.fix(id) } : undefined);
  };
}

// At start: open issues whose first message was drawn with another set of
// buttons (Draft a fix turned on, or off) get it redrawn, once. The outbox
// records the set it drew, so a restart redraws nothing more.
export function redrawControls(issues: Issues, outbox: SlackOutbox): string[] {
  const ids = outbox.drawnOtherwise().filter((id) => issues.get(id)?.status === 'open');
  for (const id of ids) outbox.updateRoot(id);
  return ids;
}

// The parts of a block_actions payload we read. Anything else is ignored.
const TS = /^\d{10}\.\d{6}$/;
const Payload = z.object({
  type: z.literal('block_actions'),
  api_app_id: z.string(),
  team: z.object({ id: z.string() }).nullish(),
  user: z.object({ id: z.string().regex(/^[UW][A-Z0-9]{2,30}$/), team_id: z.string().optional() }),
  channel: z.object({ id: z.string() }).nullish(),
  container: z.object({ type: z.string(), message_ts: z.string().optional(), channel_id: z.string().optional(), is_ephemeral: z.boolean().optional() }),
  response_url: z.string().max(500).optional(),
  actions: z.array(z.object({ action_id: z.string(), value: z.string().max(20).optional(), action_ts: z.string().regex(TS) })).length(1),
});

// Ephemeral replies go to the response_url Slack sent with the click, and nowhere else.
export const RESPONSE_URL = /^https:\/\/hooks\.slack\.com\/actions\/[A-Za-z0-9/_-]+$/;

export interface ButtonIds {
  app: string; // A…: our Slack app
  team: string; // T…: the workspace the bot is in
  channel: string; // C…: the channel it posts to
}

export interface ClickResult {
  reply?: string; // for the clicker only
  respondTo?: string; // where to send it (the payload's response_url)
  updated?: string; // the issue whose message was queued for an update
  after?: () => Promise<void>; // work that starts once Slack is acknowledged (a draft fix)
}

// Draft a fix (src/fix/draft.ts), when its GitHub App is configured. Called
// after the checks below, before Slack is acknowledged.
export interface FixButton {
  click(c: { issue: string; by: string; actionTs: string; now: Date; respondTo?: string | undefined }): ClickResult;
  stop?(reason: string): void; // the buttons stop: no fix writes to GitHub after this
}

// One button click, recorded before Slack is acknowledged. The ids are checked
// on every payload; a click from elsewhere, or on a message that isn't an
// open issue's, changes nothing and gets a reply saying so.
export function onClick(body: unknown, o: { issues: Issues; outbox: SlackOutbox; ids: ButtonIds; now?: () => Date; log?: (s: string) => void; fix?: FixButton | undefined }): ClickResult {
  const p = Payload.safeParse(body);
  if (!p.success) return {};
  const b = p.data;
  const a = b.actions[0]!;
  const click = CLICK[a.action_id];
  const fix = a.action_id === FIX_ACTION;
  if (!click && !fix) return {};
  const respondTo = b.response_url && RESPONSE_URL.test(b.response_url) ? b.response_url : undefined;
  const nothing = (reply: string): ClickResult => ({ reply: `${reply} Nothing changed.`, ...(respondTo ? { respondTo } : {}) });
  const team = b.team?.id ?? b.user.team_id;
  if (b.api_app_id !== o.ids.app || team !== o.ids.team || b.channel?.id !== o.ids.channel || (b.container.channel_id && b.container.channel_id !== o.ids.channel)) return nothing('These buttons work only in the monitor channel.');
  const ts = b.container.type === 'message' && !b.container.is_ephemeral && b.container.message_ts && TS.test(b.container.message_ts) ? b.container.message_ts : undefined;
  const id = ts ? o.outbox.issueAt(ts) : undefined;
  if (!id || a.value !== id) return nothing("This message isn't an issue the engine tracks.");
  const now = (o.now ?? (() => new Date()))();
  if (fix) return o.fix ? o.fix.click({ issue: id, by: b.user.id, actionTs: a.action_ts, now, respondTo }) : nothing('Draft a fix is off on this engine.');
  if (!click) return {};
  // The click and its message update commit together.
  const r = o.issues.click(id, click, b.user.id, now, a.action_ts, o.outbox.buttons ? (db) => queueRootUpdate(db, id, now) : undefined);
  if (r.result === 'unknown') return nothing("This message isn't an issue the engine tracks.");
  if (r.result === 'stale') return nothing(`${id} has a later click than this one.`);
  if (r.result === 'resolved') return nothing(`${id} is resolved.`);
  if (r.result === 'unchanged')
    return nothing(click === 'undo' ? `${id} has no On it or Not an issue to undo.` : `${id} is already marked ${click === 'acknowledged' ? 'On it' : 'Not an issue'} by you.`);
  o.log?.(`${id}: ${click === 'undo' ? 'Undo' : click === 'acknowledged' ? 'On it' : 'Not an issue'} (Slack button)`);
  const reply =
    click === 'acknowledged'
      ? `On it: ${id} is yours. Its reports stay in the thread with no daily reminder, and a row that gets worse gets one line there instead of an AI run.`
      : click === 'dismissed'
        ? `Not an issue: ${id} is muted until it resolves, at most until ${when(r.now?.until ?? '')}. Its reports aren't posted and its rows get no AI run. A protected journey or a rise to critical still posts. Admins see it as a noise-rule candidate.`
        : `Undone: nobody is on ${id} and it isn't muted.`;
  return { reply, updated: id, ...(respondTo ? { respondTo } : {}) };
}
