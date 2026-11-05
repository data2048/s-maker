import { useEffect, useState } from 'react';
import type { HealthResponse } from '@s-maker/shared';

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    fetch('/health')
      .then((r) => (r.ok ? (r.json() as Promise<HealthResponse>) : null))
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <main className="centered">
      <h1 className="logo">s-maker</h1>
      <p className="muted">Make music with Strudel.</p>
      <p className="muted small">Server: {health ? `ok (${health.version})` : 'unreachable'}</p>
    </main>
  );
}
