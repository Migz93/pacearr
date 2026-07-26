import { useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { History, LayoutDashboard, ListVideo, LogOut, Settings, Sparkles, Users } from "lucide-react";
import { apiGet } from "../lib/api";
import { getPlexImageSrc } from "../lib/plexImage";
import type { AboutInfo, SessionUser } from "../../shared/types";

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/shows", label: "Shows", icon: ListVideo },
  { to: "/recommendations", label: "Recommendations", icon: Sparkles },
  { to: "/users", label: "Users", icon: Users },
  { to: "/history", label: "History", icon: History },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function Layout({ user, onLogout, children }: { user: SessionUser | null; onLogout: () => void; children: React.ReactNode }) {
  const [accountOpen, setAccountOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) setAccountOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [accountOpen]);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><img className="brand-logo" src="/pacearr-logo.svg" alt="Pacearr" /></div>
          <div className="brand-copy">
            <div className="brand-title">Pacearr</div>
            <div className="brand-subtitle">Rolling Episode Control</div>
          </div>
        </div>
        <nav className="nav">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
              <Icon size={18} strokeWidth={1.75} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-account" ref={accountRef}>
          {user && <>
            {accountOpen && (
              <div className="account-popup">
                <div className="account-popup-heading">
                  <div>{user.username}</div>
                  {user.email && <small>{user.email}</small>}
                </div>
                <button onClick={() => { setAccountOpen(false); onLogout(); }}><LogOut size={16} strokeWidth={1.75} /> Sign out</button>
              </div>
            )}
            <button className="account-button" onClick={() => setAccountOpen((open) => !open)} aria-expanded={accountOpen}>
              {getPlexImageSrc(user.avatarUrl)
                ? <img src={getPlexImageSrc(user.avatarUrl)!} alt={user.displayName} className="sidebar-avatar" />
                : <span className="sidebar-avatar sidebar-avatar-fallback">{user.displayName.charAt(0).toUpperCase()}</span>}
              <span>{user.displayName}</span>
            </button>
          </>}
        </div>
        <VersionFooter />
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}

function VersionFooter() {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  useEffect(() => { void apiGet<AboutInfo>("/api/settings/about").then(setInfo).catch(() => undefined); }, []);
  const subLabel = !info
    ? "..."
    : info.buildChannel === "stable"
      ? `v${info.version}`
      : info.commitSha === "local"
        ? "local"
        : info.commitSha.slice(0, 7);
  const label = !info || info.buildChannel === "stable"
    ? "Pacearr"
    : `Pacearr ${info.buildChannel}`;

  return (
    <div className="sidebar-version">
      <Link to="/settings?tab=about">
        <span className="version-mark"><img className="version-logo" src="/pacearr-logo.svg" alt="" /></span>
        <span><strong>{label}</strong><small>{subLabel}</small></span>
      </Link>
    </div>
  );
}
