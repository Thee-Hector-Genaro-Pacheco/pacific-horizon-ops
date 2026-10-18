import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import { DataProvider } from './data/DataProvider';
import { NowProvider } from './lib/useNow';
import { ActivityPage } from './pages/ActivityPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { ApprovalsPage } from './pages/ApprovalsPage';
import { CalendarPage } from './pages/CalendarPage';
import { CallsPage } from './pages/CallsPage';
import { CommandCenterPage } from './pages/CommandCenterPage';
import { CustomerProfilePage } from './pages/CustomerProfilePage';
import { CustomersPage } from './pages/CustomersPage';
import { InboxPage } from './pages/InboxPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { LeadsPage } from './pages/LeadsPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { SettingsPage } from './pages/SettingsPage';
import { AppShell } from './shell/AppShell';

export function App() {
  return (
    <BrowserRouter>
      <NowProvider>
        <ToastProvider>
          <DataProvider>
            <Routes>
              <Route element={<AppShell />}>
                <Route index element={<CommandCenterPage />} />
                <Route path="inbox/:id?" element={<InboxPage />} />
                <Route path="approvals/:id?" element={<ApprovalsPage />} />
                <Route path="calls/:id?" element={<CallsPage />} />
                <Route path="calendar" element={<CalendarPage />} />
                <Route path="leads" element={<LeadsPage />} />
                <Route path="customers" element={<CustomersPage />} />
                <Route path="customers/:id" element={<CustomerProfilePage />} />
                <Route path="activity" element={<ActivityPage />} />
                <Route path="analytics" element={<AnalyticsPage />} />
                <Route path="knowledge" element={<KnowledgePage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </DataProvider>
        </ToastProvider>
      </NowProvider>
    </BrowserRouter>
  );
}
