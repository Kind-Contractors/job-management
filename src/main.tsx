import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import './styles/global.css';
import App from './App';
import { AuthProvider } from './auth/AuthProvider';
import { UserScopedQueryProvider } from './auth/UserScopedQueryProvider';
import { removeLegacySharedQueryCache } from './lib/userQueryCache';

ModuleRegistry.registerModules([AllCommunityModule]);

// The old implementation persisted ONE query cache shared by every user of
// this browser under this key. It's never read again — removing it here means
// its stale, cross-user data can't be restored by anything. Only this one key
// is touched; the IndexedDB offline queue and Supabase's auth token are not.
removeLegacySharedQueryCache();

// Read-side offline access (a previously-fetched job stays viewable after a
// reload with no connectivity) still comes from the persisted TanStack Query
// cache — now one client + one localStorage entry PER authenticated user, see
// UserScopedQueryProvider/userQueryCache. Deliberately separate from the
// write-side offline queue (src/technician/offline/), which is IndexedDB-backed
// (photo Blobs aren't JSON-serializable) and is owner-scoped there.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <UserScopedQueryProvider>
          <App />
        </UserScopedQueryProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
