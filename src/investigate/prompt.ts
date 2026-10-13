// The monitor's system prompt lives in agents/monitor/CLAUDE.md. This is the
// per-run task; the patrol summary goes alongside it as fenced data.
export function monitorTask(rowKeys: string[]): string {
  return [
    'Explain the rows this patrol flagged. The patrol summary below was computed by code (values are counts in the window).',
    '',
    'Row keys to cover (copy exactly into reports):',
    ...rowKeys.map((k) => `- ${k}`),
  ].join('\n');
}
