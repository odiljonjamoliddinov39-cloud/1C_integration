import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

import { AskBox } from "./components/AskBox";
import { Layout } from "./components/Layout";
import { PageHeader, Spinner } from "./components/ui";
import "./index.css";
import { I18nProvider, useT } from "./lib/i18n";
import { SessionProvider, useSession } from "./lib/session";
import { AdminPage } from "./pages/Admin";
import { DashboardPage } from "./pages/Dashboard";
import { DocumentsPage } from "./pages/Documents";
import { FindingsPage } from "./pages/Findings";
import { FixDetailPage, FixesPage } from "./pages/Fixes";
import { BulkInvoicesPage, InvoiceFormPage, InvoicesPage } from "./pages/Invoices";
import { Login } from "./pages/Login";
import { SettingsPage } from "./pages/Settings";

function OwnerOnly({ children }: { children: ReactNode }) {
  const { isOwner } = useSession();
  return isOwner ? <>{children}</> : <Navigate to="/" replace />;
}

function AskPage() {
  const { t } = useT();
  return (
    <>
      <PageHeader title={t("ask.title")} subtitle={t("ask.pageSubtitle")} />
      <AskBox />
    </>
  );
}

function App() {
  const { user, loading } = useSession();
  if (loading) return <Spinner />;
  if (!user) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<DashboardPage />} />
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="findings" element={<FindingsPage />} />
        <Route path="fixes" element={<FixesPage />} />
        <Route path="fixes/:id" element={<FixDetailPage />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="invoices/new" element={<InvoiceFormPage />} />
        <Route path="invoices/bulk" element={<BulkInvoicesPage />} />
        <Route path="invoices/:id" element={<InvoiceFormPage />} />
        <Route path="ask" element={<AskPage />} />
        <Route path="admin" element={<OwnerOnly><AdminPage /></OwnerOnly>} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <I18nProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </I18nProvider>
    </BrowserRouter>
  </StrictMode>,
);
