import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider, useSession } from './lib/session';
import { ToastProvider } from './lib/toast';
import { applyTheme, readTheme } from './lib/theme';
import { Shell } from './components/Shell';
import { SignIn } from './views/SignIn';
import { Dashboard } from './views/Dashboard';
import { Documents } from './views/Documents';
import { Settings } from './views/Settings';
import { Expenses, Invoices, Leads, ProjectDetail, Projects, Quotes, Tasks } from './views/Simple';
import { Reports, Team, Timesheet } from './views/Rest';
import './app.css';

// Before first paint, so there is no flash of the wrong theme.
applyTheme(readTheme());

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000,
      refetchOnWindowFocus: false,
      // A 401 means the session ended; retrying just delays the sign-in screen.
      retry: (count, err) => count < 2 && (err as { status?: number }).status !== 401,
    },
  },
});

function App() {
  const { user, loading } = useSession();
  if (loading) return <div className="spin">Loading…</div>;
  if (!user) return <SignIn />;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/quotes" element={<Quotes />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/projects/:id" element={<ProjectDetail />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/time" element={<Timesheet />} />
        <Route path="/expenses" element={<Expenses />} />
        <Route path="/invoices" element={<Invoices />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/team" element={<Team />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <SessionProvider>
        <ToastProvider>
          <BrowserRouter><App /></BrowserRouter>
        </ToastProvider>
      </SessionProvider>
    </QueryClientProvider>
  </StrictMode>,
);
