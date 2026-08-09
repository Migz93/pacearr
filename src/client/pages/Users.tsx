import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, Pencil, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { formatRelativeTime } from "../lib/utils";
import { Avatar } from "../components/Avatar";
import { Field, TextInput, ToggleField } from "../components/FormControls";
import { ErrorBanner, Page, PageHeader, PageLoading } from "../components/Page";
import { useDialogA11y } from "../hooks/useDialogA11y";
import type { SettingsResponse, UserListItem, UserShowActivity } from "../../shared/types";

const secondaryButton = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-on-surface";
const compactPrimaryButton = "inline-flex min-h-8 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-2.5 text-xs text-on-surface";
const compactSecondaryButton = "inline-flex min-h-8 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-2.5 text-xs text-on-surface";

export default function Users() {
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [disabledOpen, setDisabledOpen] = useState(false);
  const [showsUserId, setShowsUserId] = useState<number | null>(null);
  const [editUserId, setEditUserId] = useState<number | null>(null);
  const [tautulliEnabled, setTautulliEnabled] = useState(false);

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
      setUsers((await apiGet<{ users: UserListItem[] }>("/api/users")).users);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  // The Tautulli link control only makes sense when the integration is on, and this page
  // is the only place a viewer can be matched to their Tautulli account.
  useEffect(() => {
    void apiGet<SettingsResponse>("/api/settings")
      .then((settings) => setTautulliEnabled(settings.tautulli.enabled))
      .catch(() => setTautulliEnabled(false));
  }, []);

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

  return (
    <Page>
      <PageHeader title="Users">
        <button type="button" className={secondaryButton} disabled={discovering} onClick={() => void discover()}>
          <RefreshCw size={16} className={discovering ? "animate-spin" : ""} />
          {discovering ? "Refreshing..." : "Refresh"}
        </button>
      </PageHeader>
      {error && <ErrorBanner message={error} />}

      {selectedIds.length > 0 && (
        <div className="mb-[18px] flex flex-wrap items-center gap-2">
          <button type="button" className={compactPrimaryButton} onClick={() => void bulkSetEnabled(true)}>Enable selected</button>
          <button type="button" className={compactSecondaryButton} onClick={() => void bulkSetEnabled(false)}>Disable selected</button>
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

      {showsUser && <UserShowsDialog user={showsUser} onClose={() => setShowsUserId(null)} />}
      {editUser && <UserEditDialog user={editUser} tautulliEnabled={tautulliEnabled} onClose={() => setEditUserId(null)} onSaved={load} />}
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
    <article className={`relative grid grid-cols-[36px_minmax(0,1fr)_auto] grid-rows-[38px_auto] items-center gap-x-2.5 gap-y-2 rounded-lg border p-2.5 transition-colors hover:bg-background-container-high ${selected ? "border-primary/55 bg-background-container-high" : "border-outline-variant/30 bg-background-container"} ${!user.enabled ? "opacity-[.62]" : ""}`}>
      <label className="relative col-start-1 row-start-1 block size-[18px] cursor-pointer" title={selected ? "Deselect user" : "Select user"}>
        <input className="peer absolute inset-0 m-0 size-[18px] cursor-pointer opacity-0" type="checkbox" aria-label={`Select ${user.username}`} checked={selected} onChange={onToggleSelected} />
        <span className="grid size-[18px] place-items-center rounded-[5px] border border-on-surface/28 bg-background text-on-surface transition-colors peer-checked:border-primary peer-checked:bg-primary-dim peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary">{selected && <Check size={12} />}</span>
      </label>

      <div className="col-start-2 row-start-1 min-w-0 self-center">
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
        <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} size={28} />
      </div>
    </article>
  );
}

function UserEditDialog({ user, tautulliEnabled, onClose, onSaved }: {
  user: UserListItem;
  tautulliEnabled: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(user.enabled);
  const [tautulliUserId, setTautulliUserId] = useState(user.tautulliUserId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogA11y<HTMLDivElement>(true, onClose);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`/api/users/${user.id}`, { enabled, tautulliUserId: tautulliUserId.trim() || null });
      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <DialogShell titleId="user-edit-title" onClose={onClose} dialogRef={dialogRef} maxWidth="460px" user={user} title={user.username}>
      {error && <ErrorBanner message={error} />}
      <div className="grid gap-5">
        <ToggleField
          label="Enabled"
          hint="Only enabled viewers keep a season expanded."
          checked={enabled}
          onChange={setEnabled}
        />
        {/* Tautulli history is matched by username first, so this is normally empty and
            that's fine. It only earns its keep when the two usernames differ. */}
        {tautulliEnabled && (
          <Field label="Tautulli user ID" hint="Only needed if this person's Tautulli username differs from their Plex one. Left empty, Pacearr matches them by username.">
            <TextInput className="w-40" value={tautulliUserId} onChange={setTautulliUserId} placeholder="e.g. 12345" />
          </Field>
        )}
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={compactSecondaryButton} onClick={onClose}>Cancel</button>
        <button type="button" className={compactPrimaryButton} disabled={saving} onClick={() => void save()}>{saving ? "Saving..." : "Save"}</button>
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
          <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" onClick={onClose} aria-label="Close"><X size={18} /></button>
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

      {shows === null ? (
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
