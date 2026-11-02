export interface NotificationPolicy {
  timezone: string;
  quiet?: { startMinute: number; endMinute: number; weekends: boolean };
  dailyHealth: boolean;
  healthChanges: boolean;
  dailyMinute: number;
}
export function localClock(at: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, minute: Number(get('hour')) * 60 + Number(get('minute')), weekend: ['Sat', 'Sun'].includes(get('weekday')) };
}
export function isQuiet(at: Date, p?: NotificationPolicy): boolean {
  if (!p?.quiet) return false;
  const t = localClock(at, p.timezone),
    q = p.quiet;
  return (q.weekends && t.weekend) || (q.startMinute > q.endMinute ? t.minute >= q.startMinute || t.minute < q.endMinute : t.minute >= q.startMinute && t.minute < q.endMinute);
}
function minute(s: string, name: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw new Error(`${name} must use HH:MM`);
  const [h, m] = s.split(':').map(Number);
  return h! * 60 + m!;
}
export function notificationPolicy(env: NodeJS.ProcessEnv): NotificationPolicy | undefined {
  if (!env.SLACK_QUIET_HOURS && env.SLACK_DAILY_HEALTH !== '1' && env.SLACK_HEALTH_NOTICES !== '1') return undefined;
  if (env.SLACK_QUIET_HOURS && !env.SLACK_TIMEZONE) throw new Error('SLACK_QUIET_HOURS needs an explicit SLACK_TIMEZONE');
  const timezone = env.SLACK_TIMEZONE ?? 'UTC';
  try {
    localClock(new Date(), timezone);
  } catch {
    throw new Error('SLACK_TIMEZONE must be a valid IANA timezone');
  }
  let quiet: NotificationPolicy['quiet'];
  if (env.SLACK_QUIET_HOURS) {
    const [start, end, ...extra] = env.SLACK_QUIET_HOURS.split('-');
    if (!start || !end || extra.length) throw new Error('SLACK_QUIET_HOURS must use HH:MM-HH:MM');
    const startMinute = minute(start, 'SLACK_QUIET_HOURS'),
      endMinute = minute(end, 'SLACK_QUIET_HOURS');
    if (startMinute === endMinute) throw new Error('Quiet hours must leave an open delivery window');
    quiet = { startMinute, endMinute, weekends: env.SLACK_QUIET_WEEKENDS === '1' };
  }
  return {
    timezone,
    quiet,
    dailyHealth: env.SLACK_DAILY_HEALTH === '1',
    healthChanges: env.SLACK_HEALTH_NOTICES === '1',
    dailyMinute: minute(env.SLACK_DAILY_HEALTH_TIME ?? '09:00', 'SLACK_DAILY_HEALTH_TIME'),
  };
}
