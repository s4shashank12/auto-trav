const LABELS = {
  running: 'Running',
  sleeping: 'Waiting',
  stopped: 'Stopped',
  error: 'Error',
  captcha: 'CAPTCHA',
};

export default function StatusBadge({ status }) {
  return <span className={`badge badge-${status ?? 'stopped'}`}>{LABELS[status] ?? status}</span>;
}
