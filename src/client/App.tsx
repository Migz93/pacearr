import { useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { RefreshCw } from "lucide-react";
import { apiGet, apiPost } from "./lib/api";
import Layout from "./components/Layout";
import { PlexOAuth } from "./lib/plexOAuth";
import Dashboard from "./pages/Dashboard";
import Shows from "./pages/Shows";
import Users from "./pages/Users";
import History from "./pages/History";
import Settings from "./pages/Settings";
import type { BootstrapStatus, SessionUser } from "../shared/types";

export default function App() {
  const [boot, setBoot] = useState<BootstrapStatus | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  if (window.location.pathname === "/login/plex/loading") {
    return <PlexPopupLoading />;
  }
  if (window.location.pathname === "/login/plex/done") {
    return <PlexPopupDone />;
  }

  async function refresh() {
    try {
      const [status, session] = await Promise.all([
        apiGet<BootstrapStatus>("/api/bootstrap/status"),
        apiGet<{ authenticated: boolean; user: SessionUser | null }>("/api/auth/session"),
      ]);
      setUser(session.authenticated ? session.user : null);
      setBoot(status);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function logout() {
    await apiPost("/api/auth/logout");
    setUser(null);
    navigate("/login");
  }

  if (loading || !boot) return <div className="centered">Loading Pacearr...</div>;

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLogin={refresh} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Layout user={user} onLogout={logout}>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/shows" element={<Shows />} />
        <Route path="/shows/:seriesId" element={<Shows />} />
        <Route path="/recommendations" element={<Navigate to="/shows?tab=recommendations" replace />} />
        <Route path="/users" element={<Users />} />
        <Route path="/history" element={<History />} />
        <Route path="/settings" element={<Settings onSaved={refresh} />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
}

function PlexPopupLoading() {
  return (
    <div className="centered">
      <RefreshCw size={28} className="spin" />
    </div>
  );
}

function PlexPopupDone() {
  useEffect(() => {
    window.close();

    // Some browsers ignore a window.close() call fired before the page has
    // fully settled — retry once shortly after in case the first call is dropped.
    const retryId = window.setTimeout(() => {
      window.close();
    }, 250);

    return () => window.clearTimeout(retryId);
  }, []);

  return <div className="centered">Plex authorized. You can close this window.</div>;
}

function Login({ onLogin }: { onLogin: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function plexLogin() {
    setBusy(true);
    setError(null);
    const oauth = new PlexOAuth();
    try {
      oauth.preparePopup();
      const authToken = await oauth.login();
      await apiPost("/api/auth/plex", { authToken });
      await onLogin();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }


  return (
    <main className="login-page">
      <div className="login-content">
        <div className="login-brand">
          <div className="login-brand-mark"><img className="login-brand-logo" src="/pacearr-logo.svg" alt="Pacearr" /></div>
          <h1>Pacearr</h1>
        </div>
        <section className="login-card" aria-labelledby="login-title">
          <h2 id="login-title">Sign in to continue</h2>
          {error && <div className="error">{error}</div>}
          <button type="button" className="plex-login-button" disabled={busy} onClick={() => void plexLogin()}>
            {busy ? <span>Waiting for Plex...</span> : <><span>Login with</span><PlexLogo /></>}
          </button>
        </section>
      </div>
    </main>
  );
}

function PlexLogo() {
  return (
    <svg height="20" viewBox="0 0 361 157" aria-label="Plex" xmlns="http://www.w3.org/2000/svg">
      <path fill="currentColor" d="M59.3,28.2c-14.3,0-23.5,3.9-31.3,13v-10H.4v123.7s.5.2,1.9.5c1.9.5,12.1,2.5,19.6-3.4,6.5-5.3,8-11.4,8-18.3v-17.8c8,8,17,11.4,29.6,11.4,27.2,0,48-20.8,48-48.4s-20.1-50.7-48.3-50.7h0ZM54,103.8c-15.3,0-27.4-11.9-27.4-26.3s14.3-25.6,27.4-25.6,27.4,11.2,27.4,25.8-12.1,26-27.4,26Z" />
      <path fill="currentColor" d="M146.9,75.9c0,10.7,1.2,23.7,12.4,37.9.2.2.7.9.7.9-4.6,7.3-10.2,12.3-17.7,12.3s-11.6-3-16.5-8c-5.1-5.5-7.5-12.6-7.5-20.1V.4h28.4l.2,75.6Z" />
      <polygon fill="#eaaf20" points="286.4 77.8 252.9 31.2 287.3 31.2 320.6 77.8 287.3 124.1 252.9 124.1 286.4 77.8" />
      <polygon fill="currentColor" points="329.5 72.5 359.4 31.2 324.9 31.2 312.6 48.3 329.5 72.5" />
      <path fill="currentColor" d="M312.6,107.2l5.8,7.5c5.6,8.2,12.9,12.3,21.3,12.3,9-.2,15.3-7.5,17.7-10.3,0,0-4.4-3.7-9.9-9.8-7.5-8.2-17.5-23.3-17.7-24l-17.2,24.2Z" />
      <path fill="currentColor" d="M227.4,97.4c-5.8,5-9.7,7.8-17.7,7.8-14.3,0-22.6-9.6-23.8-20.1h75.9c.5-1.4.7-3.2.7-6.2,0-29-22.6-50.7-52.2-50.7s-51.2,22.1-51.2,49.8,23,49.1,51.9,49.1,37.6-10.7,47.1-29.7h-30.8ZM210.7,50.1c12.6,0,22.1,7.8,24.3,18h-48c2.4-10.7,11.4-18,23.8-18h0Z" />
    </svg>
  );
}
