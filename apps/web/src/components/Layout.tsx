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
    </div>
  );
}
