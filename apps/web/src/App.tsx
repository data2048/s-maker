import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ComposePage } from './pages/ComposePage';
import { AuthProvider, RequireAuth } from './auth';
import { Layout } from './components/Layout';
import { AdminPage } from './pages/AdminPage';
import { HomePage } from './pages/HomePage';
import { ImportPage } from './pages/ImportPage';
import { InvitePage } from './pages/InvitePage';
import { LoginPage } from './pages/LoginPage';
import { PlaygroundPage } from './pages/PlaygroundPage';
import { ProfilePage } from './pages/ProfilePage';
import { SongPage } from './pages/SongPage';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<HomePage />} />
            <Route path="songs/:id" element={<SongPage />} />
            <Route path="import" element={<ImportPage />} />
            <Route path="compose" element={<ComposePage />} />
            <Route path="playground" element={<PlaygroundPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route
              path="admin"
              element={
                <RequireAuth admin>
                  <AdminPage />
                </RequireAuth>
              }
            />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
}
