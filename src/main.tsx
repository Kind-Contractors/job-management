import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { ModuleRegistry, AllCommunityModule } from 'ag-grid-community';
import './styles/global.css';
import App from './App';
import { AuthProvider } from './auth/AuthProvider';

ModuleRegistry.registerModules([AllCommunityModule]);

const queryClient = new QueryClient();

// Persists the query cache (jobRows/visits/technician visit-detail/etc.)
// to localStorage and rehydrates it on load — the read-side half of the
// Technician App's offline-first requirement: a previously-fetched job
// stays viewable even after a reload with no connectivity. Deliberately
// separate from the write-side offline queue (src/technician/offline/),
// which is IndexedDB-backed for the same reason it isn't handled here:
// photo Blobs aren't JSON-serializable, and a queue needs per-item status,
// not just "the last known read." maxAge caps how stale a rehydrated
// cache entry is allowed to be treated as fresh-enough-to-show; TanStack
// Query still refetches in the background the moment it's actually online.
const persister = createAsyncStoragePersister({ storage: window.localStorage, key: 'kind-contractors-query-cache' });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: 1000 * 60 * 60 * 24 }}>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </PersistQueryClientProvider>
  </StrictMode>,
);