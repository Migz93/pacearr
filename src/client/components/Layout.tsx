import { useEffect, useRef, useState } from "react";
import { Link, NavLink } from "react-router-dom";
import { Beaker, Code2, History, LayoutDashboard, ListVideo, LogOut, Menu, Server, Settings, Users } from "lucide-react";
import { apiGet } from "../lib/api";
import { getPlexImageSrc } from "../lib/plexImage";
import { useDialogA11y } from "../hooks/useDialogA11y";
import type { AboutInfo, SessionUser } from "../../shared/types";

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/shows", label: "Shows", icon: ListVideo },
  { to: "/users", label: "Users", icon: Users },
  { to: "/history", label: "History", icon: History },
  { to: "/settings", label: "Settings", icon: Settings },
];

export default function Layout({ user, onLogout, children }: { user: SessionUser | null; onLogout: () => void; children: React.ReactNode }) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!accountOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) setAccountOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [accountOpen]);

  const sidebarRef = useDialogA11y<HTMLElement>(mobileOpen, () => setMobileOpen(false));

  return (
    <div className="flex min-h-screen bg-background text-on-surface">
      {mobileOpen && <button type="button" className="fixed inset-0 z-30 bg-black/50 md:hidden" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
      <aside
        id="mobile-sidebar"
        ref={sidebarRef}
        role={mobileOpen ? "dialog" : undefined}
        aria-modal={mobileOpen ? true : undefined}
        aria-label={mobileOpen ? "Navigation menu" : undefined}
        tabIndex={-1}
        className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-outline-variant/30 bg-background-container-low transition-transform duration-300 md:translate-x-0 ${mobileOpen ? "translate-x-0" : "-translate-x-full"}`}
      >
        <div className="flex items-center gap-3 border-b border-outline-variant/30 px-6 py-5">
          <div className="grid size-8 shrink-0 place-items-center"><img className="block size-8" src="/pacearr-logo.svg" alt="Pacearr" /></div>
          <div className="min-w-0">
            <div className="font-headline text-sm font-bold leading-[1.1]">Pacearr</div>
            <div className="mt-0.5 text-xs leading-tight text-on-surface-variant">Rolling Episode Control</div>
          </div>
        </div>
        <nav className="grid flex-1 content-start gap-0.5 overflow-y-auto px-3 py-4">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) => `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium leading-5 no-underline ${isActive ? "bg-primary-dim text-on-surface" : "text-on-surface-variant hover:bg-background-container-high hover:text-on-surface"}`}
            >
              <Icon size={18} strokeWidth={1.75} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="relative border-t border-outline-variant/30 px-3 pt-4 pb-2" ref={accountRef}>
          {user && <>
            {accountOpen && (
              <div className="absolute bottom-[calc(100%+8px)] left-3 right-3 z-10 overflow-hidden rounded-xl border border-outline-variant/30 bg-background-container-highest shadow-lg">
                <div className="overflow-hidden text-ellipsis whitespace-nowrap border-b border-outline-variant/30 px-4 py-3 text-sm font-medium">
                  <div>{user.username}</div>
                  {user.email && <small className="mt-0.5 block overflow-hidden text-ellipsis text-xs font-normal text-on-surface-variant">{user.email}</small>}
                </div>
                <button type="button" className="flex w-full items-center gap-3 border-0 bg-transparent px-4 py-2.5 text-left text-sm font-medium text-on-surface-variant hover:bg-background-bright hover:text-on-surface" onClick={() => { setAccountOpen(false); onLogout(); }}><LogOut size={16} strokeWidth={1.75} /> Sign out</button>
              </div>
            )}
            <button type="button" className="flex w-full min-w-0 items-center gap-3 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-sm font-medium text-on-surface hover:bg-background-container-high" onClick={() => setAccountOpen((open) => !open)} aria-expanded={accountOpen}>
              {getPlexImageSrc(user.avatarUrl)
                ? <img src={getPlexImageSrc(user.avatarUrl)!} alt={user.displayName} className="size-8 shrink-0 rounded-full object-cover" />
                : <span className="grid size-8 shrink-0 place-items-center rounded-full bg-background-bright text-xs font-semibold text-on-surface-variant">{user.displayName.charAt(0).toUpperCase()}</span>}
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{user.displayName}</span>
            </button>
          </>}
        </div>
        <VersionFooter onNavigate={() => setMobileOpen(false)} />
      </aside>
      <div className="flex-1 md:ml-64">
        <div className="flex items-center gap-3 border-b border-outline-variant/30 bg-background-container-low px-4 py-3 md:hidden">
          <button type="button" className="rounded-lg p-1.5 text-on-surface-variant hover:bg-background-container-high hover:text-on-surface" onClick={() => setMobileOpen((open) => !open)} aria-label="Toggle navigation" aria-expanded={mobileOpen} aria-controls="mobile-sidebar">
            <Menu size={20} />
          </button>
          <img className="size-6 shrink-0" src="/pacearr-logo.svg" alt="Pacearr" />
          <span className="font-headline text-sm font-bold">Pacearr</span>
        </div>
        {children}
      </div>
    </div>
  );
}

const CHANNEL_CONFIG = {
  stable: { label: "Pacearr Stable", Icon: Server },
  develop: { label: "Pacearr Develop", Icon: Beaker },
  custom: { label: "Custom Build", Icon: Code2 },
} as const;

function getChannelConfig(buildChannel: string) {
  return CHANNEL_CONFIG[buildChannel as keyof typeof CHANNEL_CONFIG] ?? CHANNEL_CONFIG.custom;
}

function VersionFooter({ onNavigate }: { onNavigate: () => void }) {
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [info, setInfo] = useState<AboutInfo | null>(null);
  useEffect(() => {
    void apiGet<AboutInfo>("/api/settings/about")
      .then((result) => { setInfo(result); setStatus("loaded"); })
      .catch(() => setStatus("error"));
  }, []);

  // Don't render a channel label until the API has responded — any guess
  // before that point could misrepresent the build (e.g. showing "Stable"
  // for a develop image during the load window).
  if (status === "loading") {
    return (
      <div className="px-3 pb-3">
        <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
          <div className="size-8 shrink-0 rounded-lg bg-background-container-highest" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold leading-tight text-on-surface-variant">Pacearr</div>
            <div className="mt-0.5 text-xs leading-tight text-on-surface-variant">...</div>
          </div>
        </div>
      </div>
    );
  }

  if (status === "error" || !info) {
    return (
      <div className="px-3 pb-3">
        <div className="flex items-center gap-3 rounded-lg px-3 py-2.5">
          <div className="size-8 shrink-0 rounded-lg bg-background-container-highest" />
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold leading-tight text-on-surface-variant">Pacearr</div>
            <div className="mt-0.5 text-xs leading-tight text-on-surface-variant">Version unavailable</div>
          </div>
        </div>
      </div>
    );
  }

  const { label, Icon } = getChannelConfig(info.buildChannel);
  const subLabel = info.buildChannel === "stable"
    ? `v${info.version}`
    : info.commitSha === "local"
      ? "local"
      : info.commitSha.slice(0, 7);

  return (
    <div className="px-3 pb-3">
      <Link className="group flex items-center gap-3 rounded-lg px-3 py-2.5 text-on-surface no-underline hover:bg-background-container-high" to="/settings?tab=about" onClick={onNavigate}>
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-background-bright text-on-surface-variant group-hover:text-on-surface"><Icon size={16} strokeWidth={1.75} /></span>
        <span><strong className="block text-xs font-semibold leading-tight">{label}</strong><small className="mt-0.5 block font-mono text-xs leading-tight text-on-surface-variant">{subLabel}</small></span>
      </Link>
    </div>
  );
}
