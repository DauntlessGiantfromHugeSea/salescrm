import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './lib/api';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/DashboardPage';
import { DraftsPage } from './pages/DraftsPage';
import { DealsPage } from './pages/DealsPage';
import { DealDetailPage } from './pages/DealDetailPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { ContactsPage } from './pages/ContactsPage';
import { ContactDetailPage } from './pages/ContactDetailPage';
import { ReviewsPage } from './pages/ReviewsPage';
import { SettingsPage } from './pages/SettingsPage';
import { LoginPage } from './pages/LoginPage';
import { BookingPage } from './pages/BookingPage';

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  role: 'ADMIN' | 'USER';
  timezone: string;
  hasMailboxConnected: boolean;
  mailboxAddress: string | null;
  connectionError: string | null;
  unavailableFeatures: Array<{ scope: string; feature: string }>;
}

export function App() {
  const { data: user, isLoading, isError } = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<SessionUser>('/api/auth/me'),
    retry: false,
    staleTime: 5 * 60_000,
  });

  return (
    <Routes>
      {/* Öffentlich, ohne Anmeldung */}
      <Route path="/b/:slug" element={<BookingPage />} />
      <Route path="/login" element={<LoginPage />} />

      <Route
        path="/*"
        element={
          isLoading ? (
            <div className="empty">
              <span className="spinner" /> Wird geladen …
            </div>
          ) : isError || !user ? (
            <Navigate to="/login" replace />
          ) : (
            <Layout user={user}>
              <Routes>
                <Route path="/" element={<DashboardPage user={user} />} />
                <Route path="/entwuerfe" element={<DraftsPage />} />
                <Route path="/vorgaenge" element={<DealsPage />} />
                <Route path="/vorgaenge/:id" element={<DealDetailPage user={user} />} />
                <Route path="/projekte" element={<ProjectsPage />} />
                <Route path="/projekte/:id" element={<ProjectDetailPage user={user} />} />
                <Route path="/kontakte" element={<ContactsPage />} />
                <Route path="/kontakte/:id" element={<ContactDetailPage />} />
                <Route path="/pruefen" element={<ReviewsPage />} />
                <Route path="/einstellungen" element={<SettingsPage user={user} />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          )
        }
      />
    </Routes>
  );
}
