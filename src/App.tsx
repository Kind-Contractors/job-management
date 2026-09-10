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
import MonthMatrixPage from './pages/MonthMatrixPage';
import ReportReviewPage from './pages/ReportReviewPage';
import ReadyForAccountsPage from './pages/ReadyForAccountsPage';
import UsersPage from './pages/UsersPage';
import TechnicianShell from './technician/TechnicianShell';
import DayViewPage from './technician/DayViewPage';
import JobFilePage from './technician/JobFilePage';
import JobReportPage from './technician/JobReportPage';
import CompletedPage from './technician/CompletedPage';

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
  const { status, role } = useAuth();

  if (status === 'loading') return <AuthLoadingScreen />;
  if (status === 'signed_out') return <LoginPage />;
  if (status === 'unauthorized') return <UnauthorizedPage />;
  if (status === 'check_failed') return <AuthCheckFailedPage />;

  if (role === 'technician') {
    return (
      <Routes>
        <Route element={<TechnicianShell />}>
          <Route index element={<DayViewPage />} />
          <Route path="/technician" element={<DayViewPage />} />
          <Route path="/technician/visits/:visitId" element={<JobFilePage />} />
          <Route path="/technician/visits/:visitId/report" element={<JobReportPage />} />
          <Route path="/technician/visits/:visitId/completed" element={<CompletedPage />} />
          <Route path="*" element={<Navigate to="/technician" replace />} />
        </Route>
      </Routes>
    );
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/jobs" replace />} />
        <Route path="/jobs" element={<AllLiveJobsPage />} />
        <Route path="/buildings" element={<BuildingsPage />} />
        <Route path="/buildings/:buildingId" element={<BuildingFilePage />} />
        <Route path="/this-week" element={<ThisWeekPage />} />
        <Route path="/month-matrix" element={<MonthMatrixPage />} />
        <Route path="/report-review" element={<ReportReviewPage />} />
        <Route path="/ready-for-accounts" element={<ReadyForAccountsPage />} />
        <Route path="/users" element={<UsersPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/jobs" replace />} />
    </Routes>
  );
}
