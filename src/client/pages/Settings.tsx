import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, ClipboardCopy, Eye, Pause, Pencil, Play, RefreshCw, X } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { badgeClass, formatRelativeTime } from "../lib/utils";
import { Field, SaveBar, SectionCard, SelectInput, TextInput, ToggleField } from "../components/FormControls";
import { useDialogA11y } from "../hooks/useDialogA11y";
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
  debug: badgeClass(),
  info: badgeClass("success"),
  warn: badgeClass("warning"),
  error: badgeClass("error"),
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
    <div className="mx-auto max-w-[1180px] p-7">
      <div className="mb-6 flex items-start justify-between gap-5">
        <div>
          <h1 className="font-headline text-[28px] font-bold">Settings</h1>
          <p className="text-on-surface-variant">Configure automation, integrations, background jobs, and runtime diagnostics.</p>
        </div>
      </div>

      <SelectInput className="hidden max-[820px]:block" aria-label="Select settings tab" value={activeTab} onChange={(value) => setTab(value as Tab)}>
        {TABS.map((tab) => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
      </SelectInput>

      <div className="mb-[22px] flex gap-1 rounded-xl border border-outline-variant/30 bg-background-container-high p-1 max-[820px]:hidden">
        {TABS.map((tab) => (
          <button type="button" key={tab.id} className={`min-h-10 flex-1 rounded-lg border-0 font-bold ${activeTab === tab.id ? "bg-primary-dim text-on-surface" : "bg-transparent text-on-surface-variant hover:bg-background-container-highest hover:text-on-surface"}`} onClick={() => setTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 rounded-lg border border-error/35 bg-error/12 px-3.5 py-3 text-error" role="alert">{error}</div>}
      {loading ? (
        <div className="grid min-h-[220px] place-items-center text-on-surface-variant">Loading settings...</div>
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

type GeneralForm = Omit<SettingsResponse["app"], "earlyPrefetchTriggerEpisodesRemaining" | "earlyPrefetchEpisodeCount"> & {
  earlyPrefetchTriggerEpisodesRemaining: string;
  earlyPrefetchEpisodeCount: string;
};

function generalFormFromSettings(app: SettingsResponse["app"]): GeneralForm {
  return {
    ...app,
    earlyPrefetchTriggerEpisodesRemaining: String(app.earlyPrefetchTriggerEpisodesRemaining),
    earlyPrefetchEpisodeCount: String(app.earlyPrefetchEpisodeCount),
  };
}

function GeneralTab({ settings, onSave }: { settings: SettingsResponse; onSave: () => Promise<void> }) {
  const [form, setForm] = useState<GeneralForm>(() => generalFormFromSettings(settings.app));
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setForm(generalFormFromSettings(settings.app)), [settings.app]);

  async function save() {
    setSaving(true);
    setSuccess(false);
    setError(null);
    try {
      const trigger = Number(form.earlyPrefetchTriggerEpisodesRemaining);
      const count = Number(form.earlyPrefetchEpisodeCount);
      if (!Number.isInteger(trigger) || trigger < 1 || !Number.isInteger(count) || count < 1) {
        setError("Early prefetch values must be positive whole numbers.");
        return;
      }
      await apiPatch("/api/settings/app", { ...form, earlyPrefetchTriggerEpisodesRemaining: trigger, earlyPrefetchEpisodeCount: count });
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
      <div className="grid grid-cols-2 gap-[18px] max-[820px]:grid-cols-1">
        <Field label="History import hours" hint="How often playback history is imported.">
          <TextInput type="number" min={1} value={String(form.historyImportIntervalHours)} onChange={(value) => setForm({ ...form, historyImportIntervalHours: Number(value) })} />
        </Field>
        <Field label="Viewer activity window days" hint="Only viewers active in this window count as current progress or keep a season expanded. Shows without any current viewers return to pilots.">
          <TextInput type="number" min={1} value={String(form.viewerActivityWindowDays)} onChange={(value) => setForm({ ...form, viewerActivityWindowDays: Number(value) })} />
        </Field>
        <Field label="Recommendation minimum savings (GB)" hint="Shows with projected savings below this amount are hidden from Recommendations.">
          <TextInput type="number" min={0} step={1} value={String(form.recommendationMinimumSavingsGb)} onChange={(value) => setForm({ ...form, recommendationMinimumSavingsGb: Number(value) })} />
        </Field>
      </div>
      <div className="flex items-center gap-3 text-xs font-extrabold uppercase text-on-surface-variant after:h-px after:flex-1 after:bg-outline-variant/30"><span>Early season prefetch</span></div>
      <ToggleField label="Early season prefetch" hint="Before a season ends, monitor and search the next season's first episodes so Plex can build a longer playback queue." checked={form.earlyPrefetchEnabled} onChange={(value) => setForm({ ...form, earlyPrefetchEnabled: value })} />
      <div className="grid grid-cols-2 gap-[18px] max-[820px]:grid-cols-1">
        <Field id="early-prefetch-trigger" label="Episodes remaining trigger" hint="Start prefetching when this many episodes remain after the watched episode.">
          <TextInput id="early-prefetch-trigger" type="number" min={1} value={form.earlyPrefetchTriggerEpisodesRemaining} onChange={(value) => setForm({ ...form, earlyPrefetchTriggerEpisodesRemaining: value })} />
        </Field>
        <Field id="early-prefetch-count" label="Episodes to prefetch" hint="Number of episodes after E01 to monitor and search in the next season.">
          <TextInput id="early-prefetch-count" type="number" min={1} value={form.earlyPrefetchEpisodeCount} onChange={(value) => setForm({ ...form, earlyPrefetchEpisodeCount: value })} />
        </Field>
      </div>
      <div className="flex items-center gap-3 text-xs font-extrabold uppercase text-on-surface-variant after:h-px after:flex-1 after:bg-outline-variant/30"><span>Cleanup</span></div>
      <ToggleField label="Progressive cleanup" hint="While processing watch activity and scheduled reconciliation, Pacearr can return older expanded seasons and stale prefetched seasons to pilot-only monitoring once no enabled viewer still needs them." checked={form.progressiveCleanupEnabled} onChange={(value) => setForm({ ...form, progressiveCleanupEnabled: value })} />
      <Field label="Inactive-season cleanup delay (days)" hint="Wait this long after an expanded season or stale prefetch has no active viewers before returning it to pilot-only. Set to 0 for immediate cleanup.">
        <TextInput type="number" min={0} step={1} value={String(form.progressiveCleanupDelayDays)} onChange={(value) => setForm({ ...form, progressiveCleanupDelayDays: Number(value) })} />
      </Field>
      <p className="text-xs leading-relaxed text-on-surface-variant">Every six hours, Pacearr reconciles every enrolled show with current enabled-viewer progress and inactivity delays. In live mode it unmonitors and permanently deletes non-pilot episodes that are no longer needed; Dry Run is the safety boundary for previewing those actions.</p>
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
      <div>
        <label className="mb-1.5 mt-0 block text-[13px] font-bold text-on-surface" htmlFor="plex-server-select">Server</label>
        <p className="mb-2 text-xs leading-relaxed text-on-surface-variant">Press the button to load available Plex servers.</p>
        <div className="grid grid-cols-[minmax(0,1fr)_42px] items-end gap-2">
          <SelectInput id="plex-server-select" value={selectedServerUri} onChange={(value) => {
            const match = groupedServers.find((entry) => entry.value === value)?.option;
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
          </SelectInput>
          <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" disabled={loadingServers} onClick={() => void loadServers()} title="Load available servers" aria-label="Load available servers">
            <RefreshCw size={15} className={loadingServers ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-[18px] max-[820px]:grid-cols-1">
        <div>
          <label className="mb-1.5 mt-0 block text-[13px] font-bold text-on-surface" htmlFor="plex-hostname">Hostname or IP Address</label>
          <div className="flex overflow-hidden rounded-lg border border-outline-variant/30 bg-background focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary">
            <span className="border-r border-outline-variant/30 bg-background-container-high px-3 py-2.5 text-[13px] text-on-surface-variant">{useSsl ? "https://" : "http://"}</span>
            <input id="plex-hostname" className="w-full border-0 bg-transparent px-3 py-2.5 text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none" value={hostname} onChange={(event) => { switchToManual(); setHostname(event.target.value); }} placeholder="192.168.1.10" />
          </div>
        </div>
        <Field label="Port">
          <TextInput type="number" value={port} onChange={(value) => { switchToManual(); setPort(value); }} placeholder="32400" />
        </Field>
      </div>
      <ToggleField label="Use SSL" checked={useSsl} onChange={(value) => { switchToManual(); setUseSsl(value); }} />
      <div className="flex items-center gap-3 text-xs font-extrabold uppercase text-on-surface-variant after:h-px after:flex-1 after:bg-outline-variant/30"><span>Session Monitoring</span></div>
      <Field label="Session poll minutes" hint="How often Pacearr checks Plex for active episode sessions. New season-one watches can expand a season immediately.">
        <TextInput type="number" min={1} value={String(sessionPollIntervalMinutes)} onChange={(value) => setSessionPollIntervalMinutes(Math.max(1, Number(value) || 1))} />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-outline-variant/30 pt-4 max-[820px]:flex-col max-[820px]:items-stretch">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-on-surface" disabled={testing || (!selectedServerUri && !hostname.trim())} onClick={() => void testConnection()}>
            {testing ? "Testing..." : "Test Connection"}
          </button>
          <span aria-live="polite">{testResult && <span className={`text-[13px] font-bold ${testResult.ok ? "text-success" : "text-error"}`}>{testResult.message}</span>}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span aria-live="polite">{success && <span className="text-[13px] font-bold text-success">Saved</span>}{error && <span className="text-[13px] font-bold text-error">{error}</span>}</span>
          <button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-3.5 text-on-surface" disabled={saving} onClick={() => void save()}>{saving ? "Saving..." : "Save Plex"} {!saving && <ChevronRight size={15} />}</button>
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
        <TextInput value={form.baseUrl} onChange={(value) => setForm({ ...form, baseUrl: value })} placeholder="http://sonarr:8989" />
      </Field>
      <Field label="API Key" hint="Leave unchanged to keep the configured key.">
        <input
          type="password"
          className="w-full rounded-lg border border-outline-variant/30 bg-background px-3 py-2.5 text-on-surface"
          value={apiKeyTouched ? form.apiKey : settings.sonarr?.apiKeyConfigured ? "**************" : ""}
          onFocus={() => { if (!apiKeyTouched) { setApiKeyTouched(true); setForm({ ...form, apiKey: "" }); } }}
          onChange={(event) => { setApiKeyTouched(true); setForm({ ...form, apiKey: event.target.value }); }}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-outline-variant/30 pt-4 max-[820px]:flex-col max-[820px]:items-stretch">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-on-surface" disabled={testing || !form.baseUrl || (!form.apiKey && !settings.sonarr?.apiKeyConfigured)} onClick={() => void testConnection()}>{testing ? "Testing..." : "Test Connection"}</button>
          <span aria-live="polite">{testResult && <span className={`text-[13px] font-bold ${testResult.ok ? "text-success" : "text-error"}`}>{testResult.message}</span>}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span aria-live="polite">{success && <span className="text-[13px] font-bold text-success">Saved</span>}{error && <span className="text-[13px] font-bold text-error">{error}</span>}</span>
          <button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-3.5 text-on-surface" disabled={saving || !form.baseUrl || (!form.apiKey && !settings.sonarr?.apiKeyConfigured)} onClick={() => void save()}>{saving ? "Saving..." : "Save Sonarr"}</button>
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
        <TextInput value={form.baseUrl} onChange={(value) => setForm({ ...form, baseUrl: value })} placeholder="http://tautulli:8181" />
      </Field>
      <Field label="API Key" hint="Leave unchanged to keep the configured key.">
        <input
          type="password"
          className="w-full rounded-lg border border-outline-variant/30 bg-background px-3 py-2.5 text-on-surface"
          value={apiKeyTouched ? form.apiKey : settings.tautulli.apiKeyConfigured ? "**************" : ""}
          onFocus={() => { if (!apiKeyTouched) { setApiKeyTouched(true); setForm({ ...form, apiKey: "" }); } }}
          onChange={(event) => { setApiKeyTouched(true); setForm({ ...form, apiKey: event.target.value }); }}
        />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-outline-variant/30 pt-4 max-[820px]:flex-col max-[820px]:items-stretch">
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-on-surface" disabled={testing || !form.baseUrl || (!form.apiKey && !settings.tautulli.apiKeyConfigured)} onClick={() => void testConnection()}>{testing ? "Testing..." : "Test Connection"}</button>
          <span aria-live="polite">{testResult && <span className={`text-[13px] font-bold ${testResult.ok ? "text-success" : "text-error"}`}>{testResult.message}</span>}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span aria-live="polite">{success && <span className="text-[13px] font-bold text-success">Saved</span>}{error && <span className="text-[13px] font-bold text-error">{error}</span>}</span>
          <button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-3.5 text-on-surface" disabled={saving || (form.enabled && (!form.baseUrl || (!form.apiKey && !settings.tautulli.apiKeyConfigured)))} onClick={() => void save()}>{saving ? "Saving..." : "Save Tautulli"}</button>
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

  const logDialogRef = useDialogA11y<HTMLDivElement>(activeLog !== null, () => setActiveLog(null));

  return (
    <>
      {activeLog && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-[18px]">
          <button type="button" tabIndex={-1} className="absolute inset-0 cursor-default border-0 bg-transparent p-0" aria-label="Close log details" onClick={() => setActiveLog(null)} />
          <div ref={logDialogRef} className="relative z-10 max-h-[82vh] w-full max-w-[680px] overflow-auto rounded-xl border border-outline-variant/30 bg-background-container p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="log-details-title" tabIndex={-1}>
            <div className="mb-4 flex items-center justify-between gap-3.5"><h2 id="log-details-title" className="font-headline text-lg font-semibold">Log Details</h2><button type="button" className="inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" onClick={() => setActiveLog(null)} aria-label="Close"><X size={18} /></button></div>
            <div className="grid gap-2.5">
              <InfoRow label="Timestamp"><code className="rounded-md bg-background-container-high px-1.5 py-0.5 text-[13px] whitespace-pre-wrap break-words text-on-surface">{activeLog.timestamp}</code></InfoRow>
              <InfoRow label="Level"><span className={LEVEL_BADGE[activeLog.level]}>{activeLog.level}</span></InfoRow>
              <InfoRow label="Message"><span>{activeLog.message}</span></InfoRow>
              {activeLog.meta !== undefined && <InfoRow label="Meta"><pre className="rounded-md bg-background-container-high px-1.5 py-0.5 text-[13px] whitespace-pre-wrap break-words text-on-surface">{JSON.stringify(activeLog.meta, null, 2)}</pre></InfoRow>}
            </div>
            <div className="mt-4 flex justify-end"><button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-on-surface" onClick={() => copyLog(activeLog)}><ClipboardCopy size={14} /> {copied ? "Copied!" : "Copy"}</button></div>
          </div>
        </div>
      )}
      <SectionCard title="Logs" description="Recent application logs. Disk logs are written under /config/logs.">
        <div className="flex flex-wrap items-center gap-2">
          <TextInput className="w-auto flex-[1_1_220px]" value={search} onChange={setSearch} placeholder="Search logs..." />
          <SelectInput className="w-auto basis-[140px]" value={filter} onChange={(value) => setFilter(value as LogFilter)}>
            <option value="debug">Debug (all)</option>
            <option value="info">Info+</option>
            <option value="warn">Warn+</option>
            <option value="error">Error only</option>
          </SelectInput>
          <SelectInput className="w-auto basis-[140px]" value={pageSize} onChange={(value) => setPageSize(Number(value))}>
            <option value={25}>25 / page</option>
            <option value={50}>50 / page</option>
            <option value={100}>100 / page</option>
          </SelectInput>
          <button type="button" className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 px-3.5 text-on-surface ${autoRefresh ? "bg-primary-dim" : "bg-background-container-high"}`} onClick={() => setAutoRefresh((value) => !value)}>
            {autoRefresh ? <Pause size={14} /> : <Play size={14} />} {autoRefresh ? "Pause" : "Resume"}
          </button>
          <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" onClick={() => void load()} aria-label="Refresh logs"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></button>
        </div>
        <div className="overflow-hidden rounded-xl border border-outline-variant/30 bg-background-container-low">
          {loading && !data ? <div className="p-6 text-center text-on-surface-variant">Loading logs...</div> : results.length === 0 ? <div className="p-6 text-center text-on-surface-variant">No log entries match the current filter.</div> : results.map((entry, index) => (
            <div className="grid grid-cols-[7.5rem_58px_minmax(0,1fr)_auto] items-start gap-3 border-b border-outline-variant/30 px-3 py-2.5 text-xs last:border-b-0 max-[820px]:grid-cols-[1fr_auto]" key={`${entry.timestamp}-${index}`}>
              <span className="text-on-surface-variant">{new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span className={LEVEL_BADGE[entry.level]}>{entry.level}</span>
              <span className="break-words leading-relaxed">{entry.message}</span>
              <span className="flex gap-1 opacity-70">
                {entry.meta !== undefined && <button type="button" className="inline-flex size-7 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" onClick={() => setActiveLog(entry)} title="View details" aria-label="View details"><Eye size={13} /></button>}
                <button type="button" className="inline-flex size-7 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" onClick={() => copyLog(entry)} title="Copy" aria-label="Copy"><ClipboardCopy size={13} /></button>
              </span>
            </div>
          ))}
        </div>
        {pageInfo && pageInfo.total > 0 && (
          <div className="flex items-center justify-between gap-3 text-xs text-on-surface-variant max-[820px]:flex-col max-[820px]:items-stretch">
            <span>{(pageInfo.page - 1) * pageInfo.pageSize + 1}-{Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total)} of {pageInfo.total}</span>
            <div className="flex items-center gap-2">
              <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="Previous page"><ChevronLeft size={14} /></button>
              <span>Page {page} / {pageInfo.pages}</span>
              <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" disabled={page >= pageInfo.pages} onClick={() => setPage((value) => value + 1)} aria-label="Next page"><ChevronRight size={14} /></button>
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

  const jobDialogRef = useDialogA11y<HTMLDivElement>(editingJob !== null, () => setEditingJob(null));

  return (
    <>
      {editingJob && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-[18px]">
          <div ref={jobDialogRef} className="w-full max-w-[430px] overflow-auto rounded-xl border border-outline-variant/30 bg-background-container p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="edit-schedule-title" tabIndex={-1}>
            <div className="mb-4 flex items-center justify-between gap-3.5"><h2 id="edit-schedule-title" className="font-headline text-lg font-semibold">Edit Schedule</h2><button type="button" className="inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" onClick={() => setEditingJob(null)} aria-label="Close"><X size={18} /></button></div>
            <Field label="New Frequency" hint={`Current: ${editingJob.intervalDescription ?? "Manual"}`}>
              <SelectInput value={editValue} onChange={setEditValue}>
                {(JOB_PRESETS[editingJob.id]?.values ?? []).map((value) => <option key={value} value={String(value)}>{formatPresetLabel(value, JOB_PRESETS[editingJob.id]?.unit ?? "minutes")}</option>)}
              </SelectInput>
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-3.5 text-on-surface" onClick={() => setEditingJob(null)}>Cancel</button>
              <button type="button" className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-3.5 text-on-surface" disabled={saving} onClick={() => void saveSchedule()}>{saving ? "Saving..." : "Save"}</button>
            </div>
          </div>
        </div>
      )}
      <SectionCard title="Jobs" description="Background jobs and their next scheduled execution.">
        {loading ? <div className="p-6 text-center text-on-surface-variant">Loading jobs...</div> : (
          <div className="overflow-hidden rounded-xl border border-outline-variant/30 bg-background-container-low">
            <div className="grid grid-cols-[minmax(220px,1.4fr)_minmax(130px,.7fr)_minmax(160px,.8fr)_minmax(210px,auto)] items-center gap-4 border-b border-outline-variant/30 px-4 py-[13px] text-[11px] font-black uppercase text-on-surface-variant max-[820px]:hidden"><span>Job Name</span><span>Next Execution</span><span>Last Run</span><span /></div>
            {jobs.map((job) => {
              const active = runningId === job.id || Boolean(job.running || job.isRunning);
              return (
                <div className="grid grid-cols-[minmax(220px,1.4fr)_minmax(130px,.7fr)_minmax(160px,.8fr)_minmax(210px,auto)] items-center gap-4 border-b border-outline-variant/30 px-4 py-[13px] last:border-b-0 max-[820px]:grid-cols-1" key={job.id}>
                  <div><strong className="mr-2">{job.name ?? job.id}</strong>{active && <span className="inline-block size-[9px] shrink-0 rounded-full bg-primary" />}<small className="mt-0.5 block text-on-surface-variant">{job.intervalDescription ?? "Manual"}</small></div>
                  <span>{job.nextRunAt ? formatFutureTime(job.nextRunAt) : job.nextRunLabel ?? "-"}</span>
                  <span>{active ? "Running now" : job.lastRunAt ? `${formatRelativeTime(job.lastRunAt)}${job.lastRunStatus ? ` · ${job.lastRunStatus}` : ""}` : "-"}</span>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {JOB_PRESETS[job.id] && <button type="button" className="inline-flex min-h-8 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-2.5 text-xs text-on-surface" onClick={() => openEdit(job)}><Pencil size={13} /> Edit</button>}
                    <button type="button" className="inline-flex min-h-8 items-center justify-center gap-2 rounded-lg border border-transparent bg-primary-dim px-2.5 text-xs text-on-surface" disabled={active} onClick={() => void runJob(job.id)}><Play size={13} /> {active ? "Running..." : "Run Now"}</button>
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

const GITHUB_REPOSITORY_URL = "https://github.com/Migz93/pacearr";
const GITHUB_RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;

interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  html_url: string;
  published_at: string | null;
  body: string | null;
}

function isGitHubRelease(value: unknown): value is GitHubRelease {
  if (!value || typeof value !== "object") return false;
  const release = value as Partial<GitHubRelease>;
  return typeof release.id === "number"
    && typeof release.tag_name === "string"
    && typeof release.html_url === "string"
    && (release.name === null || typeof release.name === "string")
    && (release.published_at === null || typeof release.published_at === "string")
    && (release.body === null || typeof release.body === "string");
}

function releaseTitle(release: GitHubRelease) {
  return release.name || release.tag_name;
}

function isCurrentRelease(release: GitHubRelease, version: string | undefined) {
  return Boolean(version) && (release.tag_name === `v${version}` || release.tag_name === version || release.name === version);
}

function AboutTab() {
  const [info, setInfo] = useState<AboutInfo | null>(null);
  const [releases, setReleases] = useState<GitHubRelease[] | null>(null);
  const [releasesError, setReleasesError] = useState(false);
  const [changelogRelease, setChangelogRelease] = useState<GitHubRelease | null>(null);

  useEffect(() => {
    void apiGet<AboutInfo>("/api/settings/about").then(setInfo).catch(() => undefined);

    const controller = new AbortController();
    void fetch("https://api.github.com/repos/Migz93/pacearr/releases?per_page=20", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub releases request failed: ${response.status}`);
        const data: unknown = await response.json();
        if (!Array.isArray(data) || !data.every(isGitHubRelease)) throw new Error("GitHub returned invalid release data.");
        setReleases(data);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setReleasesError(true);
      });

    return () => controller.abort();
  }, []);

  const codeClass = "rounded-md bg-background-container-high px-1.5 py-0.5 text-[13px] whitespace-pre-wrap break-words text-on-surface";
  const compactSecondaryButton = "inline-flex min-h-8 items-center justify-center gap-2 rounded-lg border border-outline-variant/30 bg-background-container-high px-2.5 text-xs text-on-surface";
  const changelogDialogRef = useDialogA11y<HTMLDivElement>(changelogRelease !== null, () => setChangelogRelease(null));

  return (
    <div className="grid gap-4">
      <SectionCard title="About Pacearr">
        <div className="grid gap-2.5">
          <InfoRow label="Version"><a className="text-[13px] font-bold text-primary hover:underline" href={GITHUB_RELEASES_URL} target="_blank" rel="noopener noreferrer">v{info?.version ?? "..."}</a></InfoRow>
          <InfoRow label="Build Channel"><span>{info?.buildChannel ?? "..."}</span></InfoRow>
          {info?.buildChannel !== "stable" && <InfoRow label="Commit"><code className={codeClass}>{info?.commitSha ?? "..."}</code></InfoRow>}
          <InfoRow label="Node"><code className={codeClass}>{info?.nodeVersion ?? "..."}</code></InfoRow>
          <InfoRow label="Platform"><code className={codeClass}>{info?.platform ?? "..."}</code></InfoRow>
          <InfoRow label="Data Directory"><code className={codeClass}>{info?.dataDir ?? "..."}</code></InfoRow>
          <InfoRow label="Timezone"><code className={codeClass}>{info?.tz ?? "..."}</code></InfoRow>
        </div>
      </SectionCard>
      <SectionCard title="Getting Support">
        <div className="grid gap-2.5">
          <InfoRow label="GitHub"><a className="text-[13px] font-bold text-primary hover:underline" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noopener noreferrer">github.com/Migz93/pacearr</a></InfoRow>
          <InfoRow label="Configuration"><span className="text-on-surface-variant">Data and logs are stored under /config in the container.</span></InfoRow>
          <InfoRow label="Health Check"><code className={codeClass}>/api/health</code></InfoRow>
        </div>
      </SectionCard>
      <SectionCard title="Releases" description="Release notes are fetched from the public Pacearr GitHub repository.">
        {releasesError && <p className="text-on-surface-variant">Release data is currently unavailable.</p>}
        {!releases && !releasesError && <p className="text-on-surface-variant">Loading releases...</p>}
        {releases?.length === 0 && <p className="text-on-surface-variant">No releases found.</p>}
        {releases && releases.length > 0 && <div className="grid gap-2">
          {releases.map((release, index) => (
            <div className="flex items-center justify-between gap-3.5 rounded-lg border border-outline-variant/30 bg-background-container-low p-3.5" key={release.id}>
              <div className="grid min-w-0 gap-1">
                <div className="flex min-w-0 items-center gap-2">
                  <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-sm">{releaseTitle(release)}</strong>
                  {index === 0 && <span className="shrink-0 rounded-full bg-success/18 px-1.75 py-0.5 text-[10px] font-bold uppercase text-success">Latest</span>}
                  {info?.buildChannel === "stable" && isCurrentRelease(release, info.version) && <span className="shrink-0 rounded-full bg-success/28 px-1.75 py-0.5 text-[10px] font-bold uppercase text-on-surface">Current</span>}
                </div>
                {release.published_at && <small className="text-xs text-on-surface-variant">{new Date(release.published_at).toLocaleDateString()}</small>}
              </div>
              <button type="button" className={compactSecondaryButton} onClick={() => setChangelogRelease(release)}>View changelog</button>
            </div>
          ))}
        </div>}
      </SectionCard>
      {changelogRelease && <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-[18px]" role="presentation" onMouseDown={() => setChangelogRelease(null)}>
        <div ref={changelogDialogRef} className="grid w-full max-w-[680px] gap-4 overflow-auto rounded-xl border border-outline-variant/30 bg-background-container p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="changelog-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between gap-3.5">
            <div><h2 id="changelog-title" className="font-headline text-lg font-semibold">{releaseTitle(changelogRelease)} changelog</h2></div>
            <button type="button" className="inline-flex size-10 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" onClick={() => setChangelogRelease(null)} aria-label="Close changelog"><X size={18} /></button>
          </div>
          {changelogRelease.body ? <pre className="m-0 max-h-[52vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-outline-variant/30 bg-background p-3 font-mono text-[13px] leading-relaxed text-on-surface">{changelogRelease.body}</pre> : <p className="text-on-surface-variant">No changelog is available for this release.</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <a className={compactSecondaryButton} href={changelogRelease.html_url.startsWith(GITHUB_REPOSITORY_URL) ? changelogRelease.html_url : GITHUB_RELEASES_URL} target="_blank" rel="noopener noreferrer">View on GitHub</a>
          </div>
        </div>
      </div>}
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[160px_minmax(0,1fr)] items-start gap-3.5 border-b border-outline-variant/30 py-2.5 last:border-b-0">
      <span className="text-[13px] font-bold text-on-surface-variant">{label}</span>
      <div>{children}</div>
    </div>
  );
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
