import { useOnlineStatus } from '../hooks/useOnlineStatus.js';

export default function ConnectionBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div className="conn-banner" role="alert">
      ⚠ You are offline. <b>Internet connection required to complete sale.</b> Nothing is lost — reconnect and retry.
    </div>
  );
}
