import { useAuth } from '../auth';

export function HomePage() {
  const { user } = useAuth();
  return (
    <section>
      <h1>Hi, {user?.displayName}</h1>
      <p className="muted">Songs, MIDI import and the agent are coming next.</p>
    </section>
  );
}
