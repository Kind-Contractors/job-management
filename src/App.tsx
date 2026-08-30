import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import LoginPage from './pages/LoginPage';
import UnauthorizedPage from './pages/UnauthorizedPage';
import AuthCheckFailedPage from './pages/AuthCheckFailedPage';
import AppShell from './components/shell/AppShell';
import AllLiveJobsPage from './pages/AllLiveJobsPage';
import BuildingsPage from './pages/BuildingsPage';
import BuildingFilePage from './pages/BuildingFilePage';
import ThisWeekPage from './pages/ThisWeekPage';

function AuthLoadingScreen() {
  return (
    <div className="flex h-screen items-center justify-center bg-neutral-200">
      <div className="font-heading text-[11px] font-semibold tracking-[0.16em] text-neutral-500 uppercase">
        Loading…
      </div>
    </div>
  );
}

export default function App() {
  const { status } = useAuth();

  if (status === 'loading') return <AuthLoadingScreen />;
  if (status === 'signed_out') return <LoginPage />;
  if (status === 'unauthorized') return <UnauthorizedPage />;
  if (status === 'check_failed') return <AuthCheckFailedPage />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/jobs" replace />} />
        <Route path="/jobs" element={<AllLiveJobsPage />} />
        <Route path="/buildings" element={<BuildingsPage />} />
        <Route path="/buildings/:buildingId" element={<BuildingFilePage />} />
        <Route path="/this-week" element={<ThisWeekPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/jobs" replace />} />
    </Routes>
  );
}
