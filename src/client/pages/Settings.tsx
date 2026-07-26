import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, ClipboardCopy, Eye, Pause, Pencil, Play, RefreshCw, X } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { formatRelativeTime } from "../lib/utils";
import type {
  AboutInfo,
  JobInfo,
  LogEntry,
  LogsPageResponse,
  PlexConfigPayload,
  PlexConnectionOption,
  SettingsResponse,
} from "../../shared/types";

type Tab = "general" | "plex" | "sonarr" | "tautulli" | "logs" | "jobs" | "about";
type LogFilter = "debug" | "info" | "warn" | "error";

const TABS: { id: Tab; label: string }[] = [
  { id: "general", label: "General" },
  { id: "plex", label: "Plex" },
  { id: "sonarr", label: "Sonarr" },
  { id: "tautulli", label: "Tautulli" },
  { id: "logs", label: "Logs" },
  { id: "jobs", label: "Jobs" },
  { id: "about", label: "About" },
];

const LEVEL_BADGE: Record<LogFilter, string> = {
  debug: "badge",
  info: "badge good",
  warn: "badge warn",
  error: "badge danger",
};

const JOB_PRESETS: Record<string, { unit: "minutes" | "hours"; values: number[] }> = {
  "session-check": { unit: "minutes", values: [1, 2, 5, 10, 15, 30, 60] },
  "history-import": { unit: "hours", values: [60, 120, 240, 360, 720, 1440] },
};

export default function Settings({ onSaved }: { onSaved: () => Promise<void> }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (TABS.some((tab) => tab.id === searchParams.get("tab")) ? searchParams.get("tab") : "general") as Tab;
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    try {
      setSettings(await apiGet<SettingsResponse>("/api/settings"));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  function setTab(tab: Tab) {
    setSearchParams({ tab }, { replace: true });
  }

  return (
    <div className="page settings-page">
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="muted">Configure automation, integrations, background jobs, and runtime diagnostics.</p>
        </div>
      </div>

      <select className="settings-tab-select" value={activeTab} onChange={(event) => setTab(event.target.value as Tab)}>
        {TABS.map((tab) => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
      </select>

      <div className="settings-tabs">
        {TABS.map((tab) => (
          <button key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>

      {error && <div className="error">{error}</div>}
      {loading ? (
        <div className="centered-panel">Loading settings...</div>
      ) : (
        <>
          {activeTab === "general" && settings && <GeneralTab settings={settings} onSave={async () => { await loadSettings(); await onSaved(); }} />}
          {activeTab === "plex" && settings && <PlexTab settings={settings} onSave={async () => { await loadSettings(); await onSaved(); }} />}
          {activeTab === "sonarr" && settings && <SonarrTab settings={settings} onSave={loadSettings} />}
          {activeTab === "tautulli" && settings && <TautulliTab settings={settings} onSave={loadSettings} />}
          {activeTab === "logs" && <LogsTab />}
          {activeTab === "jobs" && <JobsTab />}
          {activeTab === "about" && <AboutTab />}
        </>
      )}
    </div>
  );
}

function SectionCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="settings-card">
      <div className="settings-card-header">
        <h2>{title}</h2>
        {description && <p className="muted">{description}</p>}
      </div>
      <div className="settings-stack">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {hint && <p className="field-hint">{hint}</p>}
      {children}
    </div>
  );
}

function ToggleField({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle-field">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-track"><span /></span>
      <span>
        <strong>{label}</strong>
        {hint && <small>{hint}</small>}
      </span>
    </label>
  );
}

function SaveBar({ saving, success, error, label, onSave }: { saving: boolean; success: boolean; error: string | null; label: string; onSave: () => void }) {
  return (
    <div className="save-bar">
      <div>{success && <span className="inline-success">Saved</span>}{error && <span className="inline-error">{error}</span>}</div>
      <button className="primary-button" disabled={saving} onClick={onSave}>
        {saving ? "Saving..." : label}
        {!saving && <ChevronRight size={15} />}
      </button>
    </div>
  );
}

function GeneralTab({ settings, onSave }: { settings: SettingsResponse; onSave: () => Promise<void> }) {
  const [form, setForm] = useState({ ...settings.app });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm({ ...settings.app }), [settings.app]);

  async function save() {
    setSaving(true);
    setSuccess(false);
    setError(null);
    try {
      await apiPatch("/api/settings/app", form);
      setSuccess(true);
      await onSave();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard title="Automation" description="Control Pacearr's monitoring behavior, history import, and cleanup rules.">
      <ToggleField label="Dry run mode" hint="Enabled by default. Pacearr records and logs planned Sonarr changes but does not monitor, unmonitor, search, or delete anything." checked={form.dryRun} onChange={(value) => setForm({ ...form, dryRun: value })} />
      <ToggleField label="Rolling artwork" hint="When live, Pacearr marks the Plex show as rolling and labels pilot-only seasons and their episode-one thumbnails. Original artwork is restored when a season expands or the show is unenrolled." checked={form.artworkEnabled} onChange={(value) => setForm({ ...form, artworkEnabled: value })} />
      <div className="settings-form-grid">
        <Field label="History import hours" hint="How often playback history is imported.">
          <input type="number" min={1} value={form.historyImportIntervalHours} onChange={(event) => setForm({ ...form, historyImportIntervalHours: Number(event.target.value) })} />
        </Field>
        <Field label="Viewer activity window days" hint="Only viewers active in this window count as current progress or keep a season expanded. Shows without any current viewers return to pilots.">
          <input type="number" min={1} value={form.viewerActivityWindowDays} onChange={(event) => setForm({ ...form, viewerActivityWindowDays: Number(event.target.value) })} />
        </Field>
        <Field label="Recommendation minimum savings (GB)" hint="Shows with projected savings below this amount are hidden from Recommendations.">
          <input type="number" min={0} step={1} value={form.recommendationMinimumSavingsGb} onChange={(event) => setForm({ ...form, recommendationMinimumSavingsGb: Number(event.target.value) })} />
        </Field>
      </div>
      <div className="settings-divider"><span>Cleanup</span></div>
      <ToggleField label="Progressive cleanup" hint="While processing new watch activity, Pacearr can return older expanded seasons to pilot-only monitoring once every enabled viewer has moved beyond them." checked={form.progressiveCleanupEnabled} onChange={(value) => setForm({ ...form, progressiveCleanupEnabled: value })} />
      <p className="field-hint">Every six hours, Pacearr reconciles every enrolled show with current enabled-viewer progress. In live mode it unmonitors and permanently deletes non-pilot episodes that are no longer needed; Dry Run is the safety boundary for previewing those actions.</p>
      <ToggleField label="Trust proxy" hint="Enable when Pacearr is behind a reverse proxy. Requires a container restart." checked={form.trustProxy} onChange={(value) => setForm({ ...form, trustProxy: value })} />
      <SaveBar saving={saving} success={success} error={error} label="Save General" onSave={() => void save()} />
    </SectionCard>
  );
}

function PlexTab({ settings, onSave }: { settings: SettingsResponse; onSave: () => Promise<void> }) {
  const [availableServers, setAvailableServers] = useState<PlexConnectionOption[]>([]);
  const [loadingServers, setLoadingServers] = useState(false);
  const [selectedServerUri, setSelectedServerUri] = useState(settings.plex?.serverUrl ?? "");
  const [selectedMachineIdentifier, setSelectedMachineIdentifier] = useState(settings.plex?.machineIdentifier ?? "");
  const [hostname, setHostname] = useState(settings.plex?.hostname ?? "");
  const [port, setPort] = useState(String(settings.plex?.port ?? 32400));
  const [useSsl, setUseSsl] = useState(settings.plex?.useSsl ?? false);
  const [sessionPollIntervalMinutes, setSessionPollIntervalMinutes] = useState(settings.app.sessionPollIntervalMinutes);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const groupedServers = useMemo(() => availableServers.map((option) => ({
    value: option.uri,
    label: `${option.name} · ${option.uri}`,
    option,
  })), [availableServers]);

  function switchToManual() {
    setSelectedServerUri("");
    setSelectedMachineIdentifier("");
  }

  function buildPayload(): PlexConfigPayload {
    const parsedPort = Math.min(65535, Math.max(1, Math.floor(Number(port) || 32400)));
    return selectedServerUri && selectedMachineIdentifier
      ? { mode: "preset", serverUrl: selectedServerUri, machineIdentifier: selectedMachineIdentifier }
      : { mode: "manual", hostname: hostname.trim(), port: parsedPort, useSsl };
  }

  async function loadServers() {
    setLoadingServers(true);
    setError(null);
    try {
      setAvailableServers(await apiGet<PlexConnectionOption[]>("/api/setup/plex/servers"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingServers(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiPost<{ ok: boolean; message?: string; error?: string }>("/api/settings/plex/test", buildPayload());
      setTestResult({ ok: true, message: result.message ?? "Test Succeeded" });
    } catch (caught) {
      setTestResult({ ok: false, message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setSuccess(false);
    setError(null);
    try {
      await Promise.all([
        apiPost("/api/settings/plex", buildPayload()),
        apiPatch("/api/settings/app", { sessionPollIntervalMinutes }),
      ]);
      setSuccess(true);
      await onSave();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard title="Plex Settings" description="Connect Pacearr to your Plex server. Load available servers or enter the host manually.">
      <Field label="Server" hint="Press the button to load available Plex servers.">
        <div className="input-with-button">
          <select value={selectedServerUri} onChange={(event) => {
            const match = groupedServers.find((entry) => entry.value === event.target.value)?.option;
            if (!match) {
              switchToManual();
              return;
            }
            setSelectedServerUri(match.uri);
            setSelectedMachineIdentifier(match.machineIdentifier);
            setHostname(match.address);
            setPort(String(match.port));
            setUseSsl(match.protocol === "https");
          }}>
            <option value="">Press the button to load available servers</option>
            {groupedServers.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
          </select>
          <button className="icon-button" disabled={loadingServers} onClick={() => void loadServers()} title="Load available servers">
            <RefreshCw size={15} className={loadingServers ? "spin" : ""} />
          </button>
        </div>
      </Field>
      <div className="settings-form-grid two-one">
        <Field label="Hostname or IP Address">
          <div className="protocol-input">
            <span>{useSsl ? "https://" : "http://"}</span>
            <input value={hostname} onChange={(event) => { switchToManual(); setHostname(event.target.value); }} placeholder="192.168.1.10" />
          </div>
        </Field>
        <Field label="Port">
          <input type="number" value={port} onChange={(event) => { switchToManual(); setPort(event.target.value); }} placeholder="32400" />
        </Field>
      </div>
      <ToggleField label="Use SSL" checked={useSsl} onChange={(value) => { switchToManual(); setUseSsl(value); }} />
      <div className="settings-divider"><span>Session Monitoring</span></div>
      <Field label="Session poll minutes" hint="How often Pacearr checks Plex for active episode sessions. New season-one watches can expand a season immediately.">
        <input type="number" min={1} value={sessionPollIntervalMinutes} onChange={(event) => setSessionPollIntervalMinutes(Math.max(1, Number(event.target.value) || 1))} />
      </Field>
      <div className="save-bar">
        <div className="button-row">
          <button className="secondary-button" disabled={testing || (!selectedServerUri && !hostname.trim())} onClick={() => void testConnection()}>
            {testing ? "Testing..." : "Test Connection"}
          </button>
          {testResult && <span className={testResult.ok ? "inline-success" : "inline-error"}>{testResult.message}</span>}
        </div>
        <div className="button-row">
          {success && <span className="inline-success">Saved</span>}
          {error && <span className="inline-error">{error}</span>}
          <button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? "Saving..." : "Save Plex"} {!saving && <ChevronRight size={15} />}</button>
        </div>
      </div>
    </SectionCard>
  );
}

function SonarrTab({ settings, onSave }: { settings: SettingsResponse; onSave: () => Promise<void> }) {
  const [form, setForm] = useState({ baseUrl: settings.sonarr?.baseUrl ?? "", apiKey: "" });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [apiKeyTouched, setApiKeyTouched] = useState(false);

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiPost<{ ok: boolean; message?: string }>("/api/settings/sonarr/test", form);
      setTestResult({ ok: result.ok, message: result.message ?? "Test Succeeded" });
    } catch (caught) {
      setTestResult({ ok: false, message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setSuccess(false);
    setError(null);
    try {
      await apiPost("/api/settings/sonarr", form);
      setSuccess(true);
      setForm((current) => ({ ...current, apiKey: "" }));
      setApiKeyTouched(false);
      await onSave();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard title="Sonarr Integration" description="Connect Sonarr so Pacearr can monitor and clean rolling shows.">
      <Field label="Base URL" hint="Example: http://sonarr:8989">
        <input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="http://sonarr:8989" />
      </Field>
      <Field label="API Key" hint="Leave unchanged to keep the configured key.">
        <input
          type="password"
          value={apiKeyTouched ? form.apiKey : settings.sonarr?.apiKeyConfigured ? "**************" : ""}
          onFocus={() => { if (!apiKeyTouched) { setApiKeyTouched(true); setForm({ ...form, apiKey: "" }); } }}
          onChange={(event) => { setApiKeyTouched(true); setForm({ ...form, apiKey: event.target.value }); }}
        />
      </Field>
      <div className="save-bar">
        <div className="button-row">
          <button className="secondary-button" disabled={testing || !form.baseUrl || (!form.apiKey && !settings.sonarr?.apiKeyConfigured)} onClick={() => void testConnection()}>{testing ? "Testing..." : "Test Connection"}</button>
          {testResult && <span className={testResult.ok ? "inline-success" : "inline-error"}>{testResult.message}</span>}
        </div>
        <div className="button-row">
          {success && <span className="inline-success">Saved</span>}
          {error && <span className="inline-error">{error}</span>}
          <button className="primary-button" disabled={saving || !form.baseUrl || (!form.apiKey && !settings.sonarr?.apiKeyConfigured)} onClick={() => void save()}>{saving ? "Saving..." : "Save Sonarr"}</button>
        </div>
      </div>
    </SectionCard>
  );
}

function TautulliTab({ settings, onSave }: { settings: SettingsResponse; onSave: () => Promise<void> }) {
  const [form, setForm] = useState({ enabled: settings.tautulli.enabled, baseUrl: settings.tautulli.baseUrl, apiKey: "" });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [apiKeyTouched, setApiKeyTouched] = useState(false);

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiPost<{ ok: boolean; message?: string }>("/api/settings/tautulli/test", form);
      setTestResult({ ok: result.ok, message: result.message ?? "Test Succeeded" });
    } catch (caught) {
      setTestResult({ ok: false, message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setSuccess(false);
    setError(null);
    try {
      await apiPost("/api/settings/tautulli", form);
      setSuccess(true);
      setForm((current) => ({ ...current, apiKey: "" }));
      setApiKeyTouched(false);
      await onSave();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SectionCard title="Tautulli Integration" description="Optionally import richer watch history from Tautulli.">
      <ToggleField label="Enable Tautulli import" checked={form.enabled} onChange={(value) => setForm({ ...form, enabled: value })} />
      <Field label="Base URL" hint="Example: http://tautulli:8181">
        <input value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} placeholder="http://tautulli:8181" />
      </Field>
      <Field label="API Key" hint="Leave unchanged to keep the configured key.">
        <input
          type="password"
          value={apiKeyTouched ? form.apiKey : settings.tautulli.apiKeyConfigured ? "**************" : ""}
          onFocus={() => { if (!apiKeyTouched) { setApiKeyTouched(true); setForm({ ...form, apiKey: "" }); } }}
          onChange={(event) => { setApiKeyTouched(true); setForm({ ...form, apiKey: event.target.value }); }}
        />
      </Field>
      <div className="save-bar">
        <div className="button-row">
          <button className="secondary-button" disabled={testing || !form.baseUrl || (!form.apiKey && !settings.tautulli.apiKeyConfigured)} onClick={() => void testConnection()}>{testing ? "Testing..." : "Test Connection"}</button>
          {testResult && <span className={testResult.ok ? "inline-success" : "inline-error"}>{testResult.message}</span>}
        </div>
        <div className="button-row">
          {success && <span className="inline-success">Saved</span>}
          {error && <span className="inline-error">{error}</span>}
          <button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? "Saving..." : "Save Tautulli"}</button>
        </div>
      </div>
    </SectionCard>
  );
}

function LogsTab() {
  const [data, setData] = useState<LogsPageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<LogFilter>("debug");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [activeLog, setActiveLog] = useState<LogEntry | null>(null);
  const [copied, setCopied] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 350);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ filter, page: String(page), pageSize: String(pageSize), ...(debouncedSearch ? { search: debouncedSearch } : {}) });
    try {
      setData(await apiGet<LogsPageResponse>(`/api/settings/logs?${params.toString()}`));
    } finally {
      setLoading(false);
    }
  }, [filter, page, pageSize, debouncedSearch]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (autoRefresh) intervalRef.current = setInterval(() => void load(), 5000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [autoRefresh, load]);
  useEffect(() => setPage(1), [filter, pageSize]);

  function copyLog(entry: LogEntry) {
    const text = `${entry.timestamp} [${entry.level.toUpperCase()}]: ${entry.message}${entry.meta !== undefined ? " " + JSON.stringify(entry.meta) : ""}`;
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  const results = data?.results ?? [];
  const pageInfo = data?.pageInfo;

  return (
    <>
      {activeLog && (
        <div className="modal-backdrop" onClick={() => setActiveLog(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header"><h2>Log Details</h2><button className="icon-button" onClick={() => setActiveLog(null)}><X size={18} /></button></div>
            <div className="info-list">
              <InfoRow label="Timestamp"><code>{activeLog.timestamp}</code></InfoRow>
              <InfoRow label="Level"><span className={LEVEL_BADGE[activeLog.level]}>{activeLog.level}</span></InfoRow>
              <InfoRow label="Message"><span>{activeLog.message}</span></InfoRow>
              {activeLog.meta !== undefined && <InfoRow label="Meta"><pre>{JSON.stringify(activeLog.meta, null, 2)}</pre></InfoRow>}
            </div>
            <div className="button-row end"><button className="secondary-button" onClick={() => copyLog(activeLog)}><ClipboardCopy size={14} /> {copied ? "Copied!" : "Copy"}</button></div>
          </div>
        </div>
      )}
      <SectionCard title="Logs" description="Recent application logs. Disk logs are written under /config/logs.">
        <div className="settings-toolbar">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search logs..." />
          <select value={filter} onChange={(event) => setFilter(event.target.value as LogFilter)}>
            <option value="debug">Debug (all)</option>
            <option value="info">Info+</option>
            <option value="warn">Warn+</option>
            <option value="error">Error only</option>
          </select>
          <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
            <option value={25}>25 / page</option>
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
          </select>
          <button className={autoRefresh ? "secondary-button active" : "secondary-button"} onClick={() => setAutoRefresh((value) => !value)}>
            {autoRefresh ? <Pause size={14} /> : <Play size={14} />} {autoRefresh ? "Pause" : "Resume"}
          </button>
          <button className="icon-button" onClick={() => void load()}><RefreshCw size={14} className={loading ? "spin" : ""} /></button>
        </div>
        <div className="settings-table">
          {loading && !data ? <div className="empty">Loading logs...</div> : results.length === 0 ? <div className="empty">No log entries match the current filter.</div> : results.map((entry, index) => (
            <div className="log-row" key={`${entry.timestamp}-${index}`}>
              <span className="log-time">{new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span className={LEVEL_BADGE[entry.level]}>{entry.level}</span>
              <span className="log-message">{entry.message}</span>
              <span className="log-actions">
                {entry.meta !== undefined && <button className="icon-button mini" onClick={() => setActiveLog(entry)} title="View details"><Eye size={13} /></button>}
                <button className="icon-button mini" onClick={() => copyLog(entry)} title="Copy"><ClipboardCopy size={13} /></button>
              </span>
            </div>
          ))}
        </div>
        {pageInfo && pageInfo.total > 0 && (
          <div className="settings-pagination">
            <span>{(pageInfo.page - 1) * pageInfo.pageSize + 1}-{Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total)} of {pageInfo.total}</span>
            <div className="button-row">
              <button className="icon-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={14} /></button>
              <span>Page {page} / {pageInfo.pages}</span>
              <button className="icon-button" disabled={page >= pageInfo.pages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={14} /></button>
            </div>
          </div>
        )}
      </SectionCard>
    </>
  );
}

function JobsTab() {
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [editingJob, setEditingJob] = useState<JobInfo | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);

  async function load(background = false) {
    setLoading((current) => current || !background);
    try {
      setJobs(await apiGet<JobInfo[]>("/api/settings/jobs"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const timer = setInterval(() => void load(true), jobs.some((job) => job.running || job.isRunning) ? 2500 : 15000);
    return () => clearInterval(timer);
  }, [jobs]);

  async function runJob(id: string) {
    setRunningId(id);
    try {
      await apiPost(`/api/settings/jobs/${id}/run`);
      await load(true);
    } finally {
      setRunningId(null);
    }
  }

  function openEdit(job: JobInfo) {
    const preset = JOB_PRESETS[job.id];
    if (!preset) return;
    const match = job.intervalDescription?.match(/Every (\d+)/i);
    const current = Number(match?.[1] ?? preset.values[0]);
    setEditValue(String(preset.unit === "hours" ? current * 60 : current));
    setEditingJob(job);
  }

  async function saveSchedule() {
    if (!editingJob) return;
    setSaving(true);
    try {
      await apiPatch(`/api/settings/jobs/${editingJob.id}`, { intervalMinutes: Number(editValue) });
      setEditingJob(null);
      await load(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {editingJob && (
        <div className="modal-backdrop">
          <div className="modal small">
            <div className="modal-header"><h2>Edit Schedule</h2><button className="icon-button" onClick={() => setEditingJob(null)}><X size={18} /></button></div>
            <Field label="New Frequency" hint={`Current: ${editingJob.intervalDescription ?? "Manual"}`}>
              <select value={editValue} onChange={(event) => setEditValue(event.target.value)}>
                {(JOB_PRESETS[editingJob.id]?.values ?? []).map((value) => <option key={value} value={String(value)}>{formatPresetLabel(value, JOB_PRESETS[editingJob.id]?.unit ?? "minutes")}</option>)}
              </select>
            </Field>
            <div className="button-row end">
              <button className="secondary-button" onClick={() => setEditingJob(null)}>Cancel</button>
              <button className="primary-button" disabled={saving} onClick={() => void saveSchedule()}>{saving ? "Saving..." : "Save"}</button>
            </div>
          </div>
        </div>
      )}
      <SectionCard title="Jobs" description="Background jobs and their next scheduled execution.">
        {loading ? <div className="empty">Loading jobs...</div> : (
          <div className="jobs-table">
            <div className="jobs-head"><span>Job Name</span><span>Next Execution</span><span>Last Run</span><span /></div>
            {jobs.map((job) => {
              const active = runningId === job.id || Boolean(job.running || job.isRunning);
              return (
                <div className="jobs-row" key={job.id}>
                  <div><strong>{job.name ?? job.id}</strong>{active && <span className="status-dot" />}<small>{job.intervalDescription ?? "Manual"}</small></div>
                  <span>{job.nextRunAt ? formatFutureTime(job.nextRunAt) : job.nextRunLabel ?? "-"}</span>
                  <span>{active ? "Running now" : job.lastRunAt ? `${formatRelativeTime(job.lastRunAt)}${job.lastRunStatus ? ` · ${job.lastRunStatus}` : ""}` : "-"}</span>
                  <div className="button-row end">
                    {JOB_PRESETS[job.id] && <button className="secondary-button compact" onClick={() => openEdit(job)}><Pencil size={13} /> Edit</button>}
                    <button className="primary-button compact" disabled={active} onClick={() => void runJob(job.id)}><Play size={13} /> {active ? "Running..." : "Run Now"}</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SectionCard>
    </>
  );
}

function AboutTab() {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  useEffect(() => { void apiGet<AboutInfo>("/api/settings/about").then(setInfo).catch(() => undefined); }, []);
  return (
    <div className="settings-stack">
      <SectionCard title="About Pacearr">
        <div className="info-list">
          <InfoRow label="Version"><code>{info?.version ?? "..."}</code></InfoRow>
          <InfoRow label="Build Channel"><span>{info?.buildChannel ?? "..."}</span></InfoRow>
          <InfoRow label="Commit"><code>{info?.commitSha ?? "..."}</code></InfoRow>
          <InfoRow label="Node"><code>{info?.nodeVersion ?? "..."}</code></InfoRow>
          <InfoRow label="Platform"><code>{info?.platform ?? "..."}</code></InfoRow>
          <InfoRow label="Data Directory"><code>{info?.dataDir ?? "..."}</code></InfoRow>
          <InfoRow label="Timezone"><code>{info?.tz ?? "..."}</code></InfoRow>
        </div>
      </SectionCard>
      <SectionCard title="Getting Support">
        <div className="info-list">
          <InfoRow label="Configuration"><span className="muted">Data and logs are stored under /config in the container.</span></InfoRow>
          <InfoRow label="Health Check"><code>/api/health</code></InfoRow>
        </div>
      </SectionCard>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="info-row"><span>{label}</span><div>{children}</div></div>;
}

function formatPresetLabel(value: number, unit: "minutes" | "hours") {
  if (unit === "hours") {
    const hours = value / 60;
    return `Every ${hours} hour${hours !== 1 ? "s" : ""}`;
  }
  if (value < 60) return `Every ${value} minute${value !== 1 ? "s" : ""}`;
  const hours = value / 60;
  return `Every ${hours} hour${hours !== 1 ? "s" : ""}`;
}

function formatFutureTime(value: string) {
  const diff = new Date(value).getTime() - Date.now();
  if (diff <= 0) return "due now";
  const minutes = Math.ceil(diff / 60000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}
