import { useEffect, useState } from 'react';
import { phone } from '../api.js';
import { Icon } from './ui.jsx';

// Android app only: whether the phone lets the bot keep playing with the app closed and the
// screen off, with buttons to Android's settings for what is missing.
export default function PhoneCard() {
  const [status, setStatus] = useState(() => phone?.status() ?? null);

  useEffect(() => {
    if (!phone) return undefined;
    // Re-read when coming back from Android's settings, and now and then.
    const refresh = () => setStatus(phone.status());
    const timer = setInterval(refresh, 5000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  if (!phone || !status) return null;
  const ready = status.batteryUnrestricted && status.notifications;

  return (
    <div className="card phone-card">
      <div className="card-head">
        <div>
          <h3>This phone</h3>
          <p className="muted small">{status.model} · Android {status.android} · app v{status.app}</p>
        </div>
        {ready
          ? <span className="status status-good"><Icon name="check" size={12} />Ready to play in the background</span>
          : <span className="status status-serious"><Icon name="alert" size={12} />Needs attention</span>}
      </div>
      <ul className="phone-checks">
        <li className={status.batteryUnrestricted ? 'ok' : 'todo'}>
          <Icon name={status.batteryUnrestricted ? 'check' : 'alert'} />
          <div>
            <strong>Battery</strong>
            <p className="muted small">
              {status.batteryUnrestricted
                ? 'Not restricted: rounds run on time with the screen off.'
                : 'Restricted: Android may pause the bot while the screen is off.'}
            </p>
          </div>
          {!status.batteryUnrestricted && <button type="button" className="btn primary small" onClick={() => phone.allowBackground()}>Allow</button>}
        </li>
        <li className={status.notifications ? 'ok' : 'todo'}>
          <Icon name={status.notifications ? 'check' : 'alert'} />
          <div>
            <strong>Notification</strong>
            <p className="muted small">
              {status.notifications
                ? 'Shows which accounts run, with a Stop all button.'
                : 'Hidden: you will not see that the bot is running or be able to stop it from there.'}
            </p>
          </div>
          {!status.notifications && <button type="button" className="btn small" onClick={() => phone.allowNotifications()}>Allow</button>}
        </li>
        {!status.multiProfile && (
          <li className="todo">
            <Icon name="alert" />
            <div>
              <strong>Android System WebView</strong>
              <p className="muted small">
                {status.webView} cannot keep accounts apart, so they take turns. Update Android System WebView
                (or Chrome) from the Play Store to let them play at the same time.
              </p>
            </div>
          </li>
        )}
      </ul>
      <p className="muted small">
        Started accounts keep playing with the app closed. Keep the phone charged and online; some phone makers
        also have their own battery savers (look for &quot;auto-launch&quot; or &quot;background activity&quot; for this app).
      </p>
    </div>
  );
}
