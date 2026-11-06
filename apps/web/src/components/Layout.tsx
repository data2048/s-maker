import { NavLink, Outlet, useNavigate } from 'react-router';
import { useAuth } from '../auth';

export function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const onLogout = async () => {
    await logout();
    navigate('/login');
  };

  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to="/" className="brand">
          s-maker
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/import">Import MIDI</NavLink>
          <NavLink to="/playground">Playground</NavLink>
          {user?.role === 'admin' && <NavLink to="/admin">Admin</NavLink>}
        </nav>
        <div className="spacer" />
        <NavLink to="/profile" className="user-chip" title="Profile">
          {user?.displayName}
        </NavLink>
        <button type="button" className="btn ghost small" onClick={onLogout}>
          Log out
        </button>
      </header>
      <main className="page">
        <Outlet />
      </main>
      <footer className="footer">
        s-maker is free software (AGPL-3.0) ·{' '}
        <a href="https://github.com/data2048/s-maker" target="_blank" rel="noreferrer">
          source code
        </a>{' '}
        · music engine:{' '}
        <a href="https://strudel.cc" target="_blank" rel="noreferrer">
          Strudel
        </a>
      </footer>
    </div>
  );
}
