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
import MonthlyPlanPage from './pages/MonthlyPlanPage';
import ReportReviewPage from './pages/ReportReviewPage';
import ReadyForAccountsPage from './pages/ReadyForAccountsPage';
import ReadyForClientPage from './pages/ReadyForClientPage';
import UsersPage from './pages/UsersPage';
import HistoricalJobsPage from './pages/HistoricalJobsPage';
import VideosWithoutReportPage from './pages/VideosWithoutReportPage';
import WasteReportsPage from './pages/WasteReportsPage';
import TechnicianShell from './technician/TechnicianShell';
import DayViewPage from './technician/DayViewPage';
import JobFilePage from './technician/JobFilePage';
import JobReportPage from './technician/JobReportPage';
import CompletedPage from './technician/CompletedPage';
import WasteShell from './waste/WasteShell';
import NewWasteReportPage from './waste/NewWasteReportPage';
import WasteReportSentPage from './waste/WasteReportSentPage';
import MyWasteReportsPage from './waste/MyWasteReportsPage';

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

  // A waste reporter gets the waste-report screens and nothing else (the database refuses him everything else as well).
  if (role === 'waste_reporter') {
    return (
      <Routes>
        <Route element={<WasteShell />}>
          <Route path="/waste" element={<NewWasteReportPage />} />
          <Route path="/waste/sent/:reportId" element={<WasteReportSentPage />} />
          <Route path="/waste/reports" element={<MyWasteReportsPage />} />
          <Route path="*" element={<Navigate to="/waste" replace />} />
        </Route>
      </Routes>
    );
  }

  // Only a manager reaches the manager app. Any role this app does not know is refused here, never shown the manager screens.
  if (role !== 'manager') return <UnauthorizedPage />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/jobs" replace />} />
        <Route path="/jobs" element={<AllLiveJobsPage />} />
        <Route path="/buildings" element={<BuildingsPage />} />
        <Route path="/buildings/:buildingId" element={<BuildingFilePage />} />
        <Route path="/this-week" element={<ThisWeekPage />} />
        <Route path="/monthly-plan" element={<MonthlyPlanPage />} />
        <Route path="/month-matrix" element={<MonthMatrixPage />} />
        <Route path="/report-review" element={<ReportReviewPage />} />
        <Route path="/ready-for-accounts" element={<ReadyForAccountsPage />} />
        <Route path="/ready-for-client" element={<ReadyForClientPage />} />
        <Route path="/videos-without-report" element={<VideosWithoutReportPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/historical-jobs" element={<HistoricalJobsPage />} />
        <Route path="/waste-reports" element={<WasteReportsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/jobs" replace />} />
    </Routes>
  );
}
