import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { Avatar } from "../components/Avatar";
import type { UserRecord } from "../../shared/types";

const secondaryButton = "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-on-surface";
const compactPrimaryButton = "inline-flex min-h-8 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-2.5 text-xs text-on-surface";
const compactSecondaryButton = "inline-flex min-h-8 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-2.5 text-xs text-on-surface";

export default function Users() {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [disabledOpen, setDisabledOpen] = useState(false);

  const activeUsers = useMemo(() => users.filter((user) => user.enabled), [users]);
  const disabledUsers = useMemo(() => users.filter((user) => !user.enabled), [users]);

  async function load() {
    try {
      setUsers((await apiGet<{ users: UserRecord[] }>("/api/users")).users);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function discover() {
    try {
      setDiscovering(true);
      setUsers((await apiPost<{ users: UserRecord[] }>("/api/users/discover")).users);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDiscovering(false);
    }
  }

  async function toggle(user: UserRecord) {
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
      <div className="mx-auto max-w-[1280px] p-7">
        <div className="grid min-h-[220px] place-items-center text-on-surface-variant">Loading users...</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1280px] p-7">
      <div className="mb-[22px] flex items-center justify-between gap-[18px] max-[820px]:flex-col max-[820px]:items-stretch">
        <h1 className="font-headline text-[28px] font-bold">Users</h1>
        <button type="button" className={secondaryButton} disabled={discovering} onClick={() => void discover()}>
          <RefreshCw size={16} className={discovering ? "animate-spin" : ""} />
          {discovering ? "Refreshing..." : "Refresh Users"}
        </button>
      </div>
      {error && <div className="mb-4 rounded-lg border border-error/35 bg-error/12 px-3.5 py-3 text-error">{error}</div>}

      {selectedIds.length > 0 && (
        <div className="mb-[18px] flex flex-wrap items-center gap-2">
          <button type="button" className={compactPrimaryButton} onClick={() => void bulkSetEnabled(true)}>Enable Selected</button>
          <button type="button" className={compactSecondaryButton} onClick={() => void bulkSetEnabled(false)}>Disable Selected</button>
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
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-on-surface-variant">No active users</p>
        )}
      </UserSection>

      <div className="mb-6">
        <button type="button" className="inline-flex items-center gap-1.5 border-0 bg-transparent p-0 text-xs font-extrabold uppercase text-on-surface-variant hover:text-on-surface" onClick={() => setDisabledOpen((open) => !open)}>
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
                />
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-on-surface-variant">No disabled users</p>
          )
        )}
      </div>
    </div>
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
  onToggleEnabled
}: {
  user: UserRecord;
  selected: boolean;
  onToggleSelected: () => void;
  onToggleEnabled: () => void;
}) {
  return (
    <article className={`relative grid min-h-[92px] grid-cols-[36px_minmax(0,1fr)_18px] grid-rows-[38px_auto] items-center gap-x-2.5 gap-y-2 rounded-lg border p-2.5 transition-colors hover:bg-background-container-high ${selected ? "border-primary/55 bg-background-container-high" : "border-outline-variant/30 bg-background-container"} ${!user.enabled ? "opacity-[.62]" : ""}`}>
      <label className="relative col-start-3 row-start-1 block size-[18px] cursor-pointer self-start justify-self-end" title={selected ? "Deselect user" : "Select user"}>
        <input className="peer absolute inset-0 m-0 size-[18px] cursor-pointer opacity-0" type="checkbox" aria-label={`Select ${user.username}`} checked={selected} onChange={onToggleSelected} />
        <span className="grid size-[18px] place-items-center rounded-[5px] border border-on-surface/28 bg-background text-on-surface transition-colors peer-checked:border-primary peer-checked:bg-primary-dim">{selected && <Check size={12} />}</span>
      </label>

      <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} />

      <div className="min-w-0 pr-0.5">
        <div className="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-bold leading-snug text-on-surface" title={user.username}>{user.username}</div>
      </div>

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
