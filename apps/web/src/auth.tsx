import type { MeResponse, UserDto } from '@s-maker/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { api, ApiError, setCsrfToken } from './api';

interface AuthState {
  user: UserDto | null;
  loading: boolean;
  /** Store the session returned by login / invite acceptance. */
  signedIn(me: MeResponse): void;
  setUser(user: UserDto): void;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<MeResponse>('GET', '/api/auth/me')
      .then((me) => {
        setCsrfToken(me.csrfToken);
        setUserState(me.user);
      })
      .catch((e: unknown) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      })
      .finally(() => setLoading(false));
  }, []);

  const signedIn = useCallback((me: MeResponse) => {
    setCsrfToken(me.csrfToken);
    setUserState(me.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api('POST', '/api/auth/logout');
    } finally {
      setCsrfToken(null);
      setUserState(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, signedIn, setUser: setUserState, logout }),
    [user, loading, signedIn, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

/** Renders children only for logged-in users (admins only with `admin`); otherwise redirects to login. */
export function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="page muted">Loading…</div>;
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (admin && user.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}
