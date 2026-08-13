import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Pencil, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { formatRelativeTime } from "../lib/utils";
import { Avatar } from "../components/Avatar";
import { compactPrimaryButtonClass, compactSecondaryButtonClass, iconButtonClass, secondaryButtonClass, ToggleField } from "../components/FormControls";
import { ErrorBanner, Page, PageHeader, PageLoading } from "../components/Page";
import { useDialogA11y } from "../hooks/useDialogA11y";
import type { UnmappedTautulliUser, UserListItem, UserShowActivity } from "../../shared/types";


function tautulliDisplayName(user: UnmappedTautulliUser): string {
  return user.username?.trim() || user.friendlyName?.trim() || "Unknown Tautulli user";
}

function tautulliUsername(user: UnmappedTautulliUser): string | null {
  return user.username?.trim() || user.friendlyName?.trim() || null;
}

export default function Users() {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [disabledOpen, setDisabledOpen] = useState(false);
  const [unmappedOpen, setUnmappedOpen] = useState(false);
  const [unmappedTautulliUsers, setUnmappedTautulliUsers] = useState<UnmappedTautulliUser[]>([]);
  const [mappingId, setMappingId] = useState<string | null>(null);
  const [mappingSelections, setMappingSelections] = useState<Record<string, string>>({});
  const [showsUserId, setShowsUserId] = useState<number | null>(null);
  const [editUserId, setEditUserId] = useState<number | null>(null);

  // Three sections, not two. "Active" is an enabled viewer who is currently keeping at
  // least one show expanded — the people whose switch actually has an effect right now.
  // They appear only there, so Enabled is everyone else who is switched on.
  const activeUsers = useMemo(() => users.filter((user) => user.enabled && user.activeShowCount > 0), [users]);
  const enabledUsers = useMemo(() => users.filter((user) => user.enabled && user.activeShowCount === 0), [users]);
  const disabledUsers = useMemo(() => users.filter((user) => !user.enabled), [users]);
  const showsUser = useMemo(() => users.find((user) => user.id === showsUserId) ?? null, [users, showsUserId]);
  const editUser = useMemo(() => users.find((user) => user.id === editUserId) ?? null, [users, editUserId]);

  async function load() {
    try {
      const [userResponse, unmappedResponse] = await Promise.all([
        apiGet<{ users: UserListItem[] }>("/api/users"),
        apiGet<{ users: UnmappedTautulliUser[] }>("/api/users/unmapped-tautulli"),
      ]);
      setUsers(userResponse.users);
      setUnmappedTautulliUsers(unmappedResponse.users);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  async function mapTautulliUser(tautulliUser: UnmappedTautulliUser, userId: number) {
    try {
      setMappingId(tautulliUser.tautulliUserId);
      await apiPost(`/api/users/${userId}/tautulli`, {
        tautulliUserId: tautulliUser.tautulliUserId,
        tautulliUsername: tautulliUsername(tautulliUser),
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setMappingSelections((current) => ({ ...current, [tautulliUser.tautulliUserId]: "" }));
    } finally {
      setMappingId(null);
    }
  }
  useEffect(() => { void load(); }, []);

  async function discover() {
    try {
      setDiscovering(true);
      setUsers((await apiPost<{ users: UserListItem[] }>("/api/users/discover")).users);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDiscovering(false);
    }
  }

  async function bulkSetEnabled(enabled: boolean) {
    if (selectedIds.length === 0) return;
    const selected = users.filter((user) => selectedIds.includes(user.id));
    setUsers((current) => current.map((user) => selectedIds.includes(user.id) ? { ...user, enabled } : user));
    setSelectedIds([]);
    try {
      await Promise.all(selected.map((user) => apiPatch(`/api/users/${user.id}`, { enabled })));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      await load();
    }
  }

  function toggleSelected(id: number) {
    setSelectedIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);
  }

  if (loading && users.length === 0) {
    return (
      <Page>
        <PageLoading label="Loading users..." />
      </Page>
    );
  }

  // Distinct from "no users match" below: a failed initial load must not render the
  // grids' empty-state copy, which reads as a genuinely empty result rather than a
  // request that never actually succeeded.
  if (error && users.length === 0) {
    return (
      <Page>
        <PageHeader title="Users">
          <button type="button" className={secondaryButtonClass} disabled={discovering} onClick={() => void load()}>
            <RefreshCw size={16} className={discovering ? "animate-spin" : ""} />
            Retry
          </button>
        </PageHeader>
        <ErrorBanner message={error} />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader title="Users">
        <button type="button" className={secondaryButtonClass} disabled={discovering} onClick={() => void discover()}>
          <RefreshCw size={16} className={discovering ? "animate-spin" : ""} />
          {discovering ? "Refreshing..." : "Refresh"}
        </button>
      </PageHeader>
      {error && <ErrorBanner message={error} />}

      {selectedIds.length > 0 && (
        <div className="mb-[18px] flex flex-wrap items-center gap-2">
          <button type="button" className={compactPrimaryButtonClass} onClick={() => void bulkSetEnabled(true)}>Enable selected</button>
          <button type="button" className={compactSecondaryButtonClass} onClick={() => void bulkSetEnabled(false)}>Disable selected</button>
        </div>
      )}

      <UserGrid title="Active" users={activeUsers} emptyLabel="No viewer is currently keeping a show expanded" selectedIds={selectedIds} onToggleSelected={toggleSelected} onOpenShows={setShowsUserId} onEdit={setEditUserId} />
      <UserGrid title="Enabled" users={enabledUsers} emptyLabel="No other enabled users" selectedIds={selectedIds} onToggleSelected={toggleSelected} onOpenShows={setShowsUserId} onEdit={setEditUserId} />

      <div className="mb-6">
        <button type="button" className="inline-flex items-center gap-1.5 border-0 bg-transparent p-0 text-xs font-extrabold uppercase text-on-surface-variant hover:text-on-surface" aria-expanded={disabledOpen} onClick={() => setDisabledOpen((open) => !open)}>
          {disabledOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Disabled ({disabledUsers.length})
        </button>
        {disabledOpen && (
          disabledUsers.length > 0 ? (
            <div className="mt-3 grid grid-cols-6 gap-3 max-[820px]:grid-cols-2 min-[821px]:max-[1120px]:grid-cols-4 min-[1121px]:max-[1320px]:grid-cols-5">
              {disabledUsers.map((user) => (
                <UserCard
                  key={user.id}
                  user={user}
                  selected={selectedIds.includes(user.id)}
                  onToggleSelected={() => toggleSelected(user.id)}
                  onOpenShows={() => setShowsUserId(user.id)}
                  onEdit={() => setEditUserId(user.id)}
                />
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-on-surface-variant">No disabled users</p>
          )
        )}
      </div>

      <div className="mb-6">
        <button type="button" className="inline-flex items-center gap-1.5 border-0 bg-transparent p-0 text-xs font-extrabold uppercase text-on-surface-variant hover:text-on-surface" aria-expanded={unmappedOpen} onClick={() => setUnmappedOpen((open) => !open)}>
          {unmappedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Unmapped Tautulli users ({unmappedTautulliUsers.length})
        </button>
        {unmappedOpen && (
          unmappedTautulliUsers.length > 0 ? (
            <div className="mt-3 grid gap-2.5">
              {unmappedTautulliUsers.map((tautulliUser) => (
                <article key={tautulliUser.tautulliUserId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-outline-variant/30 bg-background-container p-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-on-surface">{tautulliDisplayName(tautulliUser)}</p>
                    <p className="text-xs text-on-surface-variant">{tautulliUser.friendlyName?.trim() && tautulliUser.friendlyName.trim() !== tautulliDisplayName(tautulliUser) ? `${tautulliUser.friendlyName.trim()} · ` : ""}{tautulliUser.eventCount} unmatched watch event{tautulliUser.eventCount === 1 ? "" : "s"} · last watched {formatRelativeTime(tautulliUser.lastWatchedAt)}</p>
                  </div>
                  <select
                    className="min-h-10 rounded-lg border border-outline-variant/30 bg-background-container-high px-3 text-sm text-on-surface"
                    value={mappingSelections[tautulliUser.tautulliUserId] ?? ""}
                    disabled={mappingId === tautulliUser.tautulliUserId}
                    aria-label={`Map ${tautulliDisplayName(tautulliUser)} to a Pacearr user`}
                    onChange={(event) => {
                      const selectedUserId = event.target.value;
                      setMappingSelections((current) => ({ ...current, [tautulliUser.tautulliUserId]: selectedUserId }));
                      const userId = Number(selectedUserId);
                      if (userId) void mapTautulliUser(tautulliUser, userId);
                    }}
                  >
                    <option value="">{mappingId === tautulliUser.tautulliUserId ? "Mapping..." : "Map to Pacearr user..."}</option>
                    {users.map((user) => <option key={user.id} value={user.id}>{user.displayName} ({user.username})</option>)}
                  </select>
                </article>
              ))}
            </div>
          ) : <p className="mt-3 text-xs text-on-surface-variant">All imported Tautulli users are mapped.</p>
        )}
      </div>

      {showsUser && <UserShowsDialog user={showsUser} onClose={() => setShowsUserId(null)} />}
      {editUser && <UserEditDialog user={editUser} onClose={() => setEditUserId(null)} onSaved={load} />}
    </Page>
  );
}

function UserGrid({ title, users, emptyLabel, selectedIds, onToggleSelected, onOpenShows, onEdit }: {
  title: string;
  users: UserListItem[];
  emptyLabel: string;
  selectedIds: number[];
  onToggleSelected: (id: number) => void;
  onOpenShows: (id: number) => void;
  onEdit: (id: number) => void;
}) {
  return (
    <section className="mb-6">
      <h2 className="mb-3 text-xs font-extrabold uppercase text-on-surface-variant">{title} ({users.length})</h2>
      {users.length > 0 ? (
        <div className="grid grid-cols-6 gap-3 max-[820px]:grid-cols-2 min-[821px]:max-[1120px]:grid-cols-4 min-[1121px]:max-[1320px]:grid-cols-5">
          {users.map((user) => (
            <UserCard
              key={user.id}
              user={user}
              selected={selectedIds.includes(user.id)}
              onToggleSelected={() => onToggleSelected(user.id)}
              onOpenShows={() => onOpenShows(user.id)}
              onEdit={() => onEdit(user.id)}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-on-surface-variant">{emptyLabel}</p>
      )}
    </section>
  );
}

function UserCard({
  user,
  selected,
  onToggleSelected,
  onOpenShows,
  onEdit
}: {
  user: UserListItem;
  selected: boolean;
  onToggleSelected: () => void;
  onOpenShows: () => void;
  onEdit: () => void;
}) {
  return (
    <article className={`relative grid grid-cols-[36px_minmax(0,1fr)_auto] grid-rows-[38px_auto] items-center gap-x-2.5 gap-y-2 rounded-lg border p-2.5 transition-colors hover:bg-background-container-high ${selected ? "border-primary/55 bg-background-container-high" : "border-outline-variant/30 bg-background-container"}`}>
      <label className="relative col-start-1 row-start-1 block size-[18px] cursor-pointer" title={selected ? "Deselect user" : "Select user"}>
        <input className="peer absolute inset-0 m-0 size-[18px] cursor-pointer opacity-0" type="checkbox" aria-label={`Select ${user.username}`} checked={selected} onChange={onToggleSelected} />
        <span className="grid size-[18px] place-items-center rounded-[5px] border border-on-surface/28 bg-background text-on-surface transition-colors peer-checked:border-primary peer-checked:bg-primary-dim peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary">{selected && <Check size={12} />}</span>
      </label>

      <div className={`col-start-2 row-start-1 min-w-0 self-center ${!user.enabled ? "opacity-[.62]" : ""}`}>
        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-bold leading-none text-on-surface" title={user.username}>{user.username}</div>
      </div>

      <button
        type="button"
        className="col-start-3 row-start-1 grid size-7 shrink-0 place-items-center rounded-md border-0 bg-transparent text-on-surface-variant hover:bg-background-bright hover:text-on-surface"
        onClick={onEdit}
        title={`Edit ${user.username}`}
        aria-label={`Edit ${user.username}`}
      >
        <Pencil size={14} />
      </button>

      {/* The count is the link into the shows panel — the page's actual question is
          "what is this viewer keeping on disk?", not "is the switch on?". */}
      <div className="col-span-full flex items-end justify-between gap-2">
        <button
          type="button"
          className="grid gap-0.5 rounded-lg border-0 bg-transparent p-0 text-left hover:[&>span:first-child]:text-primary"
          onClick={onOpenShows}
          aria-label={`Show what ${user.username} is watching`}
        >
          <span className="text-xs font-bold text-on-surface">
            {user.activeShowCount > 0 ? `${user.activeShowCount} show${user.activeShowCount === 1 ? "" : "s"} active` : "No active shows"}
          </span>
          <span className="text-xs text-on-surface-variant">{user.lastWatchedAt ? formatRelativeTime(user.lastWatchedAt) : "Never"}</span>
        </button>
        <span className={!user.enabled ? "opacity-[.62]" : ""}><Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} size={28} /></span>
      </div>
    </article>
  );
}

function UserEditDialog({ user, onClose, onSaved }: {
  user: UserListItem;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(user.enabled);
  const [tautulliUsername, setTautulliUsername] = useState(user.tautulliUsername ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A save in flight must not be dismissable — Cancel/backdrop/X/Escape all route
  // through here so none of them can back out of a dialog whose PATCH will land anyway.
  const requestClose = () => { if (!saving) onClose(); };
  const dialogRef = useDialogA11y<HTMLDivElement>(true, requestClose);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`/api/users/${user.id}`, { enabled, tautulliUsername });
      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell titleId="user-edit-title" onClose={requestClose} dialogRef={dialogRef} maxWidth="460px" user={user} title={user.username}>
      {error && <ErrorBanner message={error} />}
      <div className="grid gap-5">
        <ToggleField
          label="Enabled"
          hint="Only enabled viewers keep a season expanded."
          checked={enabled}
          onChange={setEnabled}
        />
        <label className="grid gap-1.5">
          <span className="text-sm font-bold text-on-surface">Tautulli user</span>
          <span className="text-xs text-on-surface-variant">The Tautulli username linked to this Pacearr user.</span>
          <input
            className="min-h-10 rounded-lg border border-outline-variant/30 bg-background-container-high px-3 text-sm text-on-surface"
            value={tautulliUsername}
            onChange={(event) => setTautulliUsername(event.target.value)}
            placeholder="Tautulli username"
          />
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={compactSecondaryButtonClass} disabled={saving} onClick={requestClose}>Cancel</button>
        <button type="button" className={compactPrimaryButtonClass} disabled={saving} onClick={() => void save()}>{saving ? "Saving..." : "Save"}</button>
      </div>
    </DialogShell>
  );
}

function DialogShell({ titleId, title, subtitle, user, maxWidth, dialogRef, onClose, children }: {
  titleId: string;
  title: string;
  subtitle?: string;
  user: UserListItem;
  maxWidth: string;
  dialogRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-[18px]">
      <button type="button" tabIndex={-1} className="absolute inset-0 cursor-default border-0 bg-transparent p-0" aria-label="Close dialog" onClick={onClose} />
      <div ref={dialogRef} className="relative z-10 max-h-[82vh] w-full overflow-auto rounded-xl border border-outline-variant/30 bg-background-container p-5 shadow-2xl" style={{ maxWidth }} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="mb-4 flex items-start justify-between gap-3.5">
          <div className="flex items-center gap-3">
            <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} />
            <div>
              <h2 id={titleId} className="font-headline text-lg font-semibold">{title}</h2>
              {subtitle && <p className="text-xs text-on-surface-variant">{subtitle}</p>}
            </div>
          </div>
          <button type="button" className={iconButtonClass} onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function UserShowsDialog({ user, onClose }: { user: UserListItem; onClose: () => void }) {
  const [shows, setShows] = useState<UserShowActivity[] | null>(null);
  const [tab, setTab] = useState<"active" | "inactive">("active");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogA11y<HTMLDivElement>(true, onClose);

  useEffect(() => {
    void apiGet<{ shows: UserShowActivity[] }>(`/api/users/${user.id}/shows`)
      .then((result) => setShows(result.shows))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [user.id]);

  const active = shows?.filter((show) => show.active) ?? [];
  const inactive = shows?.filter((show) => !show.active) ?? [];
  const visible = tab === "active" ? active : inactive;

  return (
    <DialogShell
      titleId="user-shows-title"
      title={user.username}
      subtitle={user.lastWatchedAt ? `Last watched ${formatRelativeTime(user.lastWatchedAt)}` : "Never"}
      user={user}
      maxWidth="560px"
      dialogRef={dialogRef}
      onClose={onClose}
    >
      {error && <ErrorBanner message={error} />}

      <fieldset className="m-0 mb-3.5 flex min-w-0 gap-1 rounded-xl border border-outline-variant/30 bg-background-container-high p-1">
        <legend className="sr-only">Show activity</legend>
        {([["active", `Active (${active.length})`], ["inactive", `Inactive (${inactive.length})`]] as const).map(([id, label]) => (
          <button
            type="button"
            key={id}
            aria-pressed={tab === id}
            className={`min-h-9 flex-1 rounded-lg border-0 text-xs font-bold ${tab === id ? "bg-primary-dim text-on-surface" : "bg-transparent text-on-surface-variant hover:bg-background-container-highest hover:text-on-surface"}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </fieldset>

      {error ? null : shows === null ? (
        <p className="py-4 text-center text-on-surface-variant">Loading...</p>
      ) : visible.length === 0 ? (
        <p className="py-4 text-center text-on-surface-variant">
          {tab === "active" ? "No shows this viewer is currently keeping expanded." : "No shows this viewer has gone quiet on."}
        </p>
      ) : (
        <div className="overflow-hidden rounded-lg border border-outline-variant/30">
          {visible.map((show) => (
            <Link
              key={show.sonarrSeriesId}
              to={`/shows/${show.sonarrSeriesId}`}
              onClick={onClose}
              className="flex items-center justify-between gap-3 border-b border-outline-variant/30 px-3 py-2.5 text-on-surface no-underline last:border-b-0 hover:bg-background-container-high"
            >
              <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold">{show.title}</span>
              <span className="shrink-0 text-xs text-on-surface-variant">S{show.seasonNumber}E{show.episodeNumber} · {formatRelativeTime(show.watchedAt)}</span>
            </Link>
          ))}
        </div>
      )}
    </DialogShell>
  );
}
