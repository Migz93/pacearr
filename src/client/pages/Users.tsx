import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, RefreshCw, X } from "lucide-react";
import { Link } from "react-router-dom";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { badgeClass, formatRelativeTime } from "../lib/utils";
import { Avatar } from "../components/Avatar";
import { Field, TextInput } from "../components/FormControls";
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
  const [openUserId, setOpenUserId] = useState<number | null>(null);
  const [tautulliEnabled, setTautulliEnabled] = useState(false);

  const activeUsers = useMemo(() => users.filter((user) => user.enabled), [users]);
  const disabledUsers = useMemo(() => users.filter((user) => !user.enabled), [users]);
  const openUser = useMemo(() => users.find((user) => user.id === openUserId) ?? null, [users, openUserId]);

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

  async function toggle(user: UserListItem) {
    setUsers((current) => current.map((item) => item.id === user.id ? { ...item, enabled: !item.enabled } : item));
    try {
      await apiPatch(`/api/users/${user.id}`, { enabled: !user.enabled });
      setSelectedIds((current) => current.filter((id) => id !== user.id));
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      await load();
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

      <UserSection title={`Active (${activeUsers.length})`}>
        {activeUsers.length > 0 ? (
          <div className="grid grid-cols-6 gap-3 max-[820px]:grid-cols-2 min-[821px]:max-[1120px]:grid-cols-4 min-[1121px]:max-[1320px]:grid-cols-5">
            {activeUsers.map((user) => (
              <UserCard
                key={user.id}
                user={user}
                selected={selectedIds.includes(user.id)}
                onToggleSelected={() => toggleSelected(user.id)}
                onToggleEnabled={() => void toggle(user)}
                onOpen={() => setOpenUserId(user.id)}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-on-surface-variant">No active users</p>
        )}
      </UserSection>

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
                  onToggleEnabled={() => void toggle(user)}
                  onOpen={() => setOpenUserId(user.id)}
                />
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-on-surface-variant">No disabled users</p>
          )
        )}
      </div>

      {openUser && (
        <UserShowsDialog
          user={openUser}
          tautulliEnabled={tautulliEnabled}
          onClose={() => setOpenUserId(null)}
          onSaved={load}
        />
      )}
    </Page>
  );
}

function UserSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-3 text-xs font-extrabold uppercase text-on-surface-variant">{title}</h2>
      {children}
    </section>
  );
}

function UserCard({
  user,
  selected,
  onToggleSelected,
  onToggleEnabled,
  onOpen
}: {
  user: UserListItem;
  selected: boolean;
  onToggleSelected: () => void;
  onToggleEnabled: () => void;
  onOpen: () => void;
}) {
  return (
    <article className={`relative grid grid-cols-[36px_minmax(0,1fr)_18px] grid-rows-[38px_auto_auto] items-center gap-x-2.5 gap-y-2 rounded-lg border p-2.5 transition-colors hover:bg-background-container-high ${selected ? "border-primary/55 bg-background-container-high" : "border-outline-variant/30 bg-background-container"} ${!user.enabled ? "opacity-[.62]" : ""}`}>
      <label className="relative col-start-3 row-start-1 block size-[18px] cursor-pointer self-start justify-self-end" title={selected ? "Deselect user" : "Select user"}>
        <input className="peer absolute inset-0 m-0 size-[18px] cursor-pointer opacity-0" type="checkbox" aria-label={`Select ${user.username}`} checked={selected} onChange={onToggleSelected} />
        <span className="grid size-[18px] place-items-center rounded-[5px] border border-on-surface/28 bg-background text-on-surface transition-colors peer-checked:border-primary peer-checked:bg-primary-dim peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-primary">{selected && <Check size={12} />}</span>
      </label>

      <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} />

      <div className="min-w-0 pr-0.5">
        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-bold leading-snug text-on-surface" title={user.username}>{user.username}</div>
      </div>

      {/* The point of the page: what this viewer is keeping on disk, and when they were
          last around. Both are what makes the enable/disable switch below mean something. */}
      <button
        type="button"
        className="col-span-full grid gap-0.5 rounded-lg border-0 bg-transparent p-0 text-left hover:[&>span:first-child]:text-primary"
        onClick={onOpen}
        aria-label={`Show what ${user.username} is watching`}
      >
        <span className="text-xs font-bold text-on-surface">
          {user.activeShowCount > 0 ? `${user.activeShowCount} show${user.activeShowCount === 1 ? "" : "s"} active` : "No active shows"}
        </span>
        <span className="text-xs text-on-surface-variant">{user.lastWatchedAt ? `Last watched ${formatRelativeTime(user.lastWatchedAt)}` : "Never watched an enrolled show"}</span>
      </button>

      <button
        type="button"
        className={`col-span-full min-h-7 w-full rounded-lg border text-xs font-bold hover:border-on-surface/20 hover:text-on-surface ${user.enabled ? "border-success/28 bg-success/14 text-success" : "border-outline-variant/30 bg-background-container-high text-on-surface-variant"}`}
        onClick={onToggleEnabled}
      >
        {user.enabled ? "Enabled" : "Disabled"}
      </button>
    </article>
  );
}

function UserShowsDialog({ user, tautulliEnabled, onClose, onSaved }: {
  user: UserListItem;
  tautulliEnabled: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [shows, setShows] = useState<UserShowActivity[] | null>(null);
  const [tautulliUserId, setTautulliUserId] = useState(user.tautulliUserId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useDialogA11y<HTMLDivElement>(true, onClose);

  useEffect(() => {
    void apiGet<{ shows: UserShowActivity[] }>(`/api/users/${user.id}/shows`)
      .then((result) => setShows(result.shows))
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  }, [user.id]);

  async function saveTautulliLink() {
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`/api/users/${user.id}`, { enabled: user.enabled, tautulliUserId: tautulliUserId.trim() || null });
      await onSaved();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-[18px]">
      <button type="button" tabIndex={-1} className="absolute inset-0 cursor-default border-0 bg-transparent p-0" aria-label="Close viewer details" onClick={onClose} />
      <div ref={dialogRef} className="relative z-10 max-h-[82vh] w-full max-w-[560px] overflow-auto rounded-xl border border-outline-variant/30 bg-background-container p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="user-shows-title" tabIndex={-1}>
        <div className="mb-4 flex items-start justify-between gap-3.5">
          <div className="flex items-center gap-3">
            <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} />
            <div>
              <h2 id="user-shows-title" className="font-headline text-lg font-semibold">{user.username}</h2>
              <p className="text-xs text-on-surface-variant">{user.lastWatchedAt ? `Last watched ${formatRelativeTime(user.lastWatchedAt)}` : "Never watched an enrolled show"}</p>
            </div>
          </div>
          <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        {error && <ErrorBanner message={error} />}

        <h3 className="mb-2 text-xs font-extrabold uppercase text-on-surface-variant">Enrolled shows</h3>
        {shows === null ? (
          <p className="py-4 text-center text-on-surface-variant">Loading...</p>
        ) : shows.length === 0 ? (
          <p className="py-4 text-center text-on-surface-variant">This viewer hasn't watched any enrolled show yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-outline-variant/30">
            {shows.map((show) => (
              <Link
                key={show.sonarrSeriesId}
                to={`/shows/${show.sonarrSeriesId}`}
                onClick={onClose}
                className="flex items-center justify-between gap-3 border-b border-outline-variant/30 px-3 py-2.5 text-on-surface no-underline last:border-b-0 hover:bg-background-container-high"
              >
                <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold">{show.title}</span>
                <span className="flex shrink-0 items-center gap-2 text-xs text-on-surface-variant">
                  S{show.seasonNumber}E{show.episodeNumber} · {formatRelativeTime(show.watchedAt)}
                  {show.active
                    ? <span className={badgeClass("success")}>Active</span>
                    : <span className={badgeClass()}>Inactive</span>}
                </span>
              </Link>
            ))}
          </div>
        )}

        {tautulliEnabled && (
          <div className="mt-5 border-t border-outline-variant/30 pt-4">
            <Field label="Tautulli user ID" hint="Only needed if Pacearr can't match this viewer to their Tautulli history automatically.">
              <TextInput className="w-40" value={tautulliUserId} onChange={setTautulliUserId} placeholder="e.g. 12345" />
            </Field>
            <div className="mt-3 flex justify-end">
              <button type="button" className={compactPrimaryButton} disabled={saving} onClick={() => void saveTautulliLink()}>{saving ? "Saving..." : "Save link"}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
