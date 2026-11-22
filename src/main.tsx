import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./index.css";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { Layout } from "./components/Layout";
import { FullPageSpinner, Toaster } from "./components/ui";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { NewDocument } from "./pages/NewDocument";
import { Editor } from "./pages/Editor";
import { DocumentDetail } from "./pages/DocumentDetail";
import { Admin } from "./pages/Admin";
import { Sign } from "./pages/Sign";
import { Templates } from "./pages/Templates";
import { BulkSend } from "./pages/BulkSend";
import { PublicLinks } from "./pages/PublicLinks";
import { PublicForm } from "./pages/PublicForm";

function Protected() {
  const { loading, session, profile } = useAuth();
  if (loading) return <FullPageSpinner />;
  if (!session || !profile) return <Login />;
  return <Layout />;
}

function AdminOnly({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth();
  return profile?.role === "admin" ? <>{children}</> : <Navigate to="/" replace />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Toaster />
      <Routes>
        {/* Página pública dos signatários: não usa a sessão dos colaboradores */}
        <Route path="/s/:token" element={<Sign />} />
        <Route path="/f/:slug" element={<PublicForm />} />
        <Route
          path="*"
          element={
            <AuthProvider>
              <Routes>
                <Route element={<Protected />}>
                  <Route index element={<Dashboard />} />
                  <Route path="novo" element={<NewDocument />} />
                  <Route path="modelos" element={<Templates />} />
                  <Route path="modelos/:id/envio-em-massa" element={<BulkSend />} />
                  <Route path="links" element={<PublicLinks />} />
                  <Route path="documentos/:id/editar" element={<Editor />} />
                  <Route path="documentos/:id" element={<DocumentDetail />} />
                  <Route
                    path="admin"
                    element={
                      <AdminOnly>
                        <Admin />
                      </AdminOnly>
                    }
                  />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Route>
              </Routes>
            </AuthProvider>
          }
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
