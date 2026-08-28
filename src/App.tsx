import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './components/shell/AppShell';
import AllLiveJobsPage from './pages/AllLiveJobsPage';

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/jobs" replace />} />
        <Route path="/jobs" element={<AllLiveJobsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/jobs" replace />} />
    </Routes>
  );
}
