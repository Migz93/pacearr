import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { Avatar } from "../components/Avatar";
import type { UserRecord } from "../../shared/types";

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
      <div className="page users-page">
        <div className="centered-panel">Loading users...</div>
      </div>
    );
  }

  return (
    <div className="page users-page">
      <div className="users-header">
        <h1>Users</h1>
        <button className="secondary-button" disabled={discovering} onClick={() => void discover()}>
          <RefreshCw size={16} className={discovering ? "spin" : ""} />
          {discovering ? "Refreshing..." : "Refresh Users"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}

      {selectedIds.length > 0 && (
        <div className="users-bulk-actions">
          <button className="primary-button compact" onClick={() => void bulkSetEnabled(true)}>Enable Selected</button>
          <button className="secondary-button compact" onClick={() => void bulkSetEnabled(false)}>Disable Selected</button>
        </div>
      )}

      <UserSection title={`Active (${activeUsers.length})`}>
        {activeUsers.length > 0 ? (
          <div className="user-grid">
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
          <p className="muted small">No active users</p>
        )}
      </UserSection>

      <div className="user-section">
        <button className="user-section-toggle" onClick={() => setDisabledOpen((open) => !open)}>
          {disabledOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          Disabled ({disabledUsers.length})
        </button>
        {disabledOpen && (
          disabledUsers.length > 0 ? (
            <div className="user-grid">
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
            <p className="muted small">No disabled users</p>
          )
        )}
      </div>
    </div>
  );
}

function UserSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="user-section">
      <h2>{title}</h2>
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
    <article className={`user-card${selected ? " selected" : ""}${!user.enabled ? " disabled" : ""}`}>
      <label className="user-select" title={selected ? "Deselect user" : "Select user"}>
        <input type="checkbox" checked={selected} onChange={onToggleSelected} />
        <span>{selected && <Check size={12} />}</span>
      </label>

      <Avatar avatarUrl={user.avatarUrl} displayName={user.displayName} />

      <div className="user-card-copy">
        <div className="user-card-name" title={user.username}>{user.username}</div>
      </div>

      <button className={`user-status-button${user.enabled ? " enabled" : ""}`} onClick={onToggleEnabled}>
        {user.enabled ? "Enabled" : "Disabled"}
      </button>
    </article>
  );
}
