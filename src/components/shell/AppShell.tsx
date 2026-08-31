import { Outlet } from 'react-router-dom';
import TopBar from './TopBar';
import NavRail from './NavRail';

export default function AppShell() {
  return (
    <div className="flex h-screen min-h-[640px] flex-col overflow-hidden">
      <TopBar />
      <div className="grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)]">
        <NavRail />
        <div className="flex min-h-0 min-w-0">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
