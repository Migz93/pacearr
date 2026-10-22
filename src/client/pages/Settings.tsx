import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, ClipboardCopy, Eye, Pause, Pencil, Play, RefreshCw, X } from "lucide-react";
import { apiGet, apiPatch, apiPost } from "../lib/api";
import { badgeClass, cn, formatRelativeTime } from "../lib/utils";
import { compactPrimaryButtonClass, compactSecondaryButtonClass, DependentSettings, Field, iconButtonClass, primaryButtonClass, secondaryButtonClass, SectionCard, SelectInput, SettingNumber, SettingRow, SettingToggle, TestConnection, TextInput, UnsavedChangesBar } from "../components/FormControls";
import { ErrorBanner, Page, PageHeader, PageLoading } from "../components/Page";
import { useDialogA11y } from "../hooks/useDialogA11y";
import type {
  AboutInfo,
  JobInfo,
  LogEntry,
  LogsPageResponse,
  PlexConfigPayload,
  PlexConnectionOption,
  SettingsResponse,
  SonarrTagImportPreview,
  SonarrTagImportResult,
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

const JOB_PRESETS: Record<string, { unit: "minutes" | "hours" | "days"; values: number[] }> = {
  "session-check": { unit: "minutes", values: [1, 2, 5, 10, 15, 30, 60] },
  "tautulli-session-check": { unit: "minutes", values: [1, 5, 15, 30, 60, 120] },
  "history-import": { unit: "hours", values: [60, 120, 240, 360, 720, 1440] },
  "full-history-reconcile": { unit: "days", values: [10080, 20160, 43200, 86400, 129600] },
  "rolling-reconcile": { unit: "hours", values: [60, 180, 360, 720, 1440] },
  "sonarr-library-refresh": { unit: "hours", values: [60, 180, 360, 720, 1440] },
  "recommendation-refresh": { unit: "hours", values: [60, 180, 360, 720, 1440] },
  "new-show-triage": { unit: "minutes", values: [1, 2, 5, 10, 15, 30, 60] },
};

export default function Settings({ onSaved }: { onSaved: () => Promise<void> }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = (TABS.some((tab) => tab.id === searchParams.get("tab")) ? searchParams.get("tab") : "general") as Tab;
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Tab switching is locked while a tab is saving. Switching would remount the tab with
  // its save lock cleared, and the save's settings reload would then overwrite any
  // edits made in the meantime.
  const [tabSaving, setTabSaving] = useState(false);

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
    <Page>
      <PageHeader title="Settings" />

      <SelectInput className="mb-4 hidden max-[820px]:block" aria-label="Select settings tab" disabled={tabSaving} value={activeTab} onChange={(value) => setTab(value as Tab)}>
        {TABS.map((tab) => <option key={tab.id} value={tab.id}>{tab.label}</option>)}
      </SelectInput>

      <div className="mb-[22px] flex gap-1 rounded-xl border border-outline-variant/30 bg-background-container-high p-1 max-[820px]:hidden">
        {TABS.map((tab) => (
          <button type="button" key={tab.id} disabled={tabSaving && activeTab !== tab.id} className={`min-h-10 flex-1 rounded-lg border-0 font-bold disabled:cursor-not-allowed disabled:opacity-50 ${activeTab === tab.id ? "bg-primary-dim text-on-surface" : "bg-transparent text-on-surface-variant enabled:hover:bg-background-container-highest enabled:hover:text-on-surface"}`} onClick={() => setTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>

      {error && <ErrorBanner message={error} />}
      {/* Only the first load replaces the page. A reload after a save keeps the tab
          mounted, so its "Saved" confirmation survives and the form re-syncs in place. */}
      {loading && !settings ? (
        <PageLoading label="Loading settings..." />
      ) : (
        <>
          {activeTab === "general" && settings && <GeneralTab settings={settings} onSavingChange={setTabSaving} onSave={async () => { await loadSettings(); await onSaved(); }} />}
          {activeTab === "plex" && settings && <PlexTab settings={settings} onSavingChange={setTabSaving} onSave={async () => { await loadSettings(); await onSaved(); }} />}
          {activeTab === "sonarr" && settings && <SonarrTab settings={settings} onSavingChange={setTabSaving} onSave={loadSettings} />}
          {activeTab === "tautulli" && settings && <TautulliTab settings={settings} onSavingChange={setTabSaving} onSave={loadSettings} />}
          {activeTab === "logs" && <LogsTab />}
          {activeTab === "jobs" && <JobsTab />}
          {activeTab === "about" && <AboutTab />}
        </>
      )}
    </Page>
  );
}

interface SettingsTabProps {
  settings: SettingsResponse;
  onSave: () => Promise<void>;
  /** Reports a save in flight, so the parent can lock tab switching until it lands. */
  onSavingChange: (saving: boolean) => void;
}

/**
 * Saving state for a settings tab's UnsavedChangesBar. "Saved" clears itself after a
 * moment; the form has already re-synced from the reloaded settings by then, so the
 * bar has nothing left to show and drops away. An error clears once the form is back
 * at its saved values (edited back or discarded), since there is then nothing left to
 * save and the bar would otherwise be stuck showing it with both buttons disabled.
 */
function useSaveStatus(dirty: boolean, onSavingChange: (saving: boolean) => void) {
  const [saving, setSaving] = useState(false);

  useEffect(() => onSavingChange(saving), [saving, onSavingChange]);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!success) return;
    const timer = setTimeout(() => setSuccess(false), 2500);
    return () => clearTimeout(timer);
  }, [success]);

  useEffect(() => {
    if (!dirty) setError(null);
  }, [dirty]);

  async function run(action: () => Promise<void>) {
    setSaving(true);
    setSuccess(false);
    setError(null);
    try {
      await action();
      setSuccess(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return { saving, success, error, run };
}

/**
 * Wraps a settings tab's cards and its save bar. Every control is disabled while a save
 * is in flight: the form re-syncs from the reloaded settings when it lands, which would
 * silently drop edits made meanwhile, and a field edited back to its saved value
 * mid-save would leave a failure error showing on a form with nothing left to save.
 */
function SettingsTabForm({ saving, children }: { saving: boolean; children: ReactNode }) {
  return <fieldset disabled={saving} aria-busy={saving} className="grid min-w-0 gap-4">{children}</fieldset>;
}

function sameValues<T>(a: T, b: T) {
  return JSON.stringify(a) === JSON.stringify(b);
}

type GeneralForm = Omit<SettingsResponse["app"], "earlyPrefetchTriggerEpisodesRemaining" | "earlyPrefetchEpisodeCount" | "newShowTriageEpisodeThreshold" | "viewerActivityWindowDays" | "historyRetentionDays" | "progressiveCleanupDelayDays" | "recommendationMinimumSavingsGb"> & {
  earlyPrefetchTriggerEpisodesRemaining: string;
  earlyPrefetchEpisodeCount: string;
  newShowTriageEpisodeThreshold: string;
  viewerActivityWindowDays: string;
  historyRetentionDays: string;
  progressiveCleanupDelayDays: string;
  recommendationMinimumSavingsGb: string;
};

function generalFormFromSettings(app: SettingsResponse["app"]): GeneralForm {
  return {
    ...app,
    earlyPrefetchTriggerEpisodesRemaining: String(app.earlyPrefetchTriggerEpisodesRemaining),
    earlyPrefetchEpisodeCount: String(app.earlyPrefetchEpisodeCount),
    newShowTriageEpisodeThreshold: String(app.newShowTriageEpisodeThreshold),
    viewerActivityWindowDays: String(app.viewerActivityWindowDays),
    historyRetentionDays: String(app.historyRetentionDays),
    progressiveCleanupDelayDays: String(app.progressiveCleanupDelayDays),
    recommendationMinimumSavingsGb: String(app.recommendationMinimumSavingsGb),
  };
}

function GeneralTab({ settings, onSave, onSavingChange }: SettingsTabProps) {
  const initial = useMemo(() => generalFormFromSettings(settings.app), [settings.app]);
  const [form, setForm] = useState<GeneralForm>(initial);
  const dirty = !sameValues(form, initial);
  const status = useSaveStatus(dirty, onSavingChange);

  useEffect(() => setForm(initial), [initial]);

  function save() {
    return status.run(async () => {
      const trigger = Number(form.earlyPrefetchTriggerEpisodesRemaining);
      const count = Number(form.earlyPrefetchEpisodeCount);
      const triageThreshold = Number(form.newShowTriageEpisodeThreshold);
      // Number("") is 0, which is valid for two of these settings. Preserve an empty
      // field as invalid instead of silently saving it as a real zero.
      const viewerActivityWindowDays = form.viewerActivityWindowDays.trim() === "" ? Number.NaN : Number(form.viewerActivityWindowDays);
      const historyRetentionDays = form.historyRetentionDays.trim() === "" ? Number.NaN : Number(form.historyRetentionDays);
      const progressiveCleanupDelayDays = form.progressiveCleanupDelayDays.trim() === "" ? Number.NaN : Number(form.progressiveCleanupDelayDays);
      const recommendationMinimumSavingsGb = form.recommendationMinimumSavingsGb.trim() === "" ? Number.NaN : Number(form.recommendationMinimumSavingsGb);
      if (form.earlyPrefetchEnabled && (!Number.isInteger(trigger) || trigger < 1 || !Number.isInteger(count) || count < 1)) {
        throw new Error("Early prefetch values must be positive whole numbers.");
      }
      if (form.newShowTriageEnabled && (!Number.isInteger(triageThreshold) || triageThreshold < 1)) {
        throw new Error("New-show triage episode limit must be a positive whole number.");
      }
      // The server clamps every one of these to a safe value regardless (see
      // /api/settings/app in app.ts), so a bad value here can't corrupt anything — but
      // without this check it fails silently: the field just snaps to the clamped number
      // after the save completes, with no indication anything was wrong.
      if (!Number.isInteger(viewerActivityWindowDays) || viewerActivityWindowDays < 1) {
        throw new Error("Viewer activity window must be a positive whole number of days.");
      }
      if (!Number.isInteger(historyRetentionDays) || historyRetentionDays < 1) {
        throw new Error("History retention must be a positive whole number of days.");
      }
      if (form.progressiveCleanupEnabled && (!Number.isInteger(progressiveCleanupDelayDays) || progressiveCleanupDelayDays < 0)) {
        throw new Error("Cleanup delay must be a whole number of days, zero or more.");
      }
      if (!Number.isFinite(recommendationMinimumSavingsGb) || recommendationMinimumSavingsGb < 0) {
        throw new Error("Minimum savings must be zero or more.");
      }
      // Only the fields this tab owns. Spreading the whole form would PATCH back the
      // job intervals as they were when the tab loaded, silently undoing a schedule
      // changed on the Jobs tab in the meantime. Dependent values are only sent while
      // their parent is on, since they are disabled (and unvalidated) otherwise.
      await apiPatch("/api/settings/app", {
        dryRun: form.dryRun,
        viewerActivityWindowDays,
        historyRetentionDays,
        progressiveCleanupEnabled: form.progressiveCleanupEnabled,
        ...(form.progressiveCleanupEnabled ? { progressiveCleanupDelayDays } : {}),
        recommendationMinimumSavingsGb,
        trustProxy: form.trustProxy,
        earlyPrefetchEnabled: form.earlyPrefetchEnabled,
        ...(form.earlyPrefetchEnabled ? { earlyPrefetchTriggerEpisodesRemaining: trigger, earlyPrefetchEpisodeCount: count } : {}),
        expandNextSeasonOnFinaleEnabled: form.expandNextSeasonOnFinaleEnabled,
        newShowTriageEnabled: form.newShowTriageEnabled,
        ...(form.newShowTriageEnabled ? { newShowTriageEpisodeThreshold: triageThreshold, searchNewlyMonitoredSeasonsEnabled: form.searchNewlyMonitoredSeasonsEnabled } : {}),
      });
      await onSave();
    });
  }

  // Cards are grouped by what's being decided, one setting per row. Hints say what the
  // setting does to your shows in a line; anything longer belongs in the card's
  // description or in docs/.
  return (
    <SettingsTabForm saving={status.saving}>
      <SectionCard title="Safety">
        <SettingToggle
          label="Dry run"
          hint="Show what Pacearr would do without changing or deleting anything. On by default."
          checked={form.dryRun}
          onChange={(value) => setForm({ ...form, dryRun: value })}
        />
      </SectionCard>

      <SectionCard title="Watching and expansion" description="When a show counts as being watched, and how far ahead Pacearr downloads.">
        <SettingNumber
          label="Viewer activity window"
          hint="How recently someone must have watched to still count as watching a show."
          unit="days"
          min={1}
          value={form.viewerActivityWindowDays}
          onChange={(value) => setForm({ ...form, viewerActivityWindowDays: value })}
        />
        <SettingToggle
          label="Early season prefetch"
          hint="Start downloading the next season before someone finishes the current one."
          checked={form.earlyPrefetchEnabled}
          onChange={(value) => setForm({ ...form, earlyPrefetchEnabled: value })}
        />
        <DependentSettings enabled={form.earlyPrefetchEnabled} label="Early season prefetch options">
          <SettingNumber
            id="early-prefetch-trigger"
            label="Episodes remaining trigger"
            hint="How close to the end of a season prefetch starts."
            unit="episodes left"
            min={1}
            value={form.earlyPrefetchTriggerEpisodesRemaining}
            onChange={(value) => setForm({ ...form, earlyPrefetchTriggerEpisodesRemaining: value })}
          />
          <SettingNumber
            id="early-prefetch-count"
            label="Episodes to prefetch"
            hint="How many episodes of the next season to grab."
            unit="episodes"
            min={1}
            value={form.earlyPrefetchEpisodeCount}
            onChange={(value) => setForm({ ...form, earlyPrefetchEpisodeCount: value })}
          />
        </DependentSettings>
        <SettingToggle
          label="Expand next season on finale"
          hint="When someone starts a season's last episode, download the whole next season."
          checked={form.expandNextSeasonOnFinaleEnabled}
          onChange={(value) => setForm({ ...form, expandNextSeasonOnFinaleEnabled: value })}
        />
      </SectionCard>

      <SectionCard title="New shows" description="What happens to shows as they arrive in Sonarr. Works best with Search on Add off, so nothing downloads only to be purged.">
        <SettingToggle
          label="Auto-triage new Sonarr shows"
          hint="Pace new shows longer than the episode limit, and search shorter ones in full."
          checked={form.newShowTriageEnabled}
          onChange={(value) => setForm({ ...form, newShowTriageEnabled: value })}
        />
        {/* Both run in the triage poll, so they only apply while it is on. */}
        <DependentSettings enabled={form.newShowTriageEnabled} label="Auto-triage options">
          <SettingNumber
            id="new-show-triage-episode-threshold"
            label="Episode limit"
            hint="Shows with more episodes than this are paced by Pacearr."
            unit="episodes"
            min={1}
            value={form.newShowTriageEpisodeThreshold}
            onChange={(value) => setForm({ ...form, newShowTriageEpisodeThreshold: value })}
          />
          <SettingToggle
            label="Search newly monitored seasons"
            hint="Search a season once it's monitored on a show Pacearr isn't pacing, such as one requested in Seerr."
            checked={form.searchNewlyMonitoredSeasonsEnabled}
            onChange={(value) => setForm({ ...form, searchNewlyMonitoredSeasonsEnabled: value })}
          />
        </DependentSettings>
      </SectionCard>

      <SectionCard title="Cleanup" description="What happens to seasons nobody is watching any more.">
        <SettingToggle
          label="Progressive cleanup"
          hint="Trim unwatched seasons back to their first episode."
          checked={form.progressiveCleanupEnabled}
          onChange={(value) => setForm({ ...form, progressiveCleanupEnabled: value })}
        />
        <DependentSettings enabled={form.progressiveCleanupEnabled} label="Progressive cleanup options">
          <SettingNumber
            label="Cleanup delay"
            hint="How long a season sits unwatched before it's trimmed. 0 trims straight away."
            unit="days"
            min={0}
            value={form.progressiveCleanupDelayDays}
            onChange={(value) => setForm({ ...form, progressiveCleanupDelayDays: value })}
          />
        </DependentSettings>
      </SectionCard>

      <SectionCard title="Recommendations" description="Shows Pacearr suggests pacing, by the space they would free.">
        <SettingNumber
          label="Minimum savings"
          hint="Hide recommendations that wouldn't free up at least this much space."
          unit="GB"
          min={0}
          value={form.recommendationMinimumSavingsGb}
          onChange={(value) => setForm({ ...form, recommendationMinimumSavingsGb: value })}
        />
      </SectionCard>

      <SectionCard title="Advanced">
        <SettingNumber
          label="History retention"
          hint="How long to keep entries on the History page."
          unit="days"
          min={1}
          value={form.historyRetentionDays}
          onChange={(value) => setForm({ ...form, historyRetentionDays: value })}
        />
        <SettingToggle
          label="Trust proxy"
          hint="Turn on if Pacearr sits behind a reverse proxy. Takes effect after a restart."
          checked={form.trustProxy}
          onChange={(value) => setForm({ ...form, trustProxy: value })}
        />
      </SectionCard>

      <UnsavedChangesBar
        dirty={dirty}
        saving={status.saving}
        success={status.success}
        error={status.error}
        onSave={() => void save()}
        onDiscard={() => setForm(initial)}
      />
    </SettingsTabForm>
  );
}

interface PlexForm {
  serverUri: string;
  machineIdentifier: string;
  hostname: string;
  port: string;
  useSsl: boolean;
  artworkEnabled: boolean;
}

function plexFormFromSettings(settings: SettingsResponse): PlexForm {
  return {
    serverUri: settings.plex?.serverUrl ?? "",
    machineIdentifier: settings.plex?.machineIdentifier ?? "",
    hostname: settings.plex?.hostname ?? "",
    port: String(settings.plex?.port ?? 32400),
    useSsl: settings.plex?.useSsl ?? false,
    artworkEnabled: settings.app.artworkEnabled,
  };
}

function PlexTab({ settings, onSave, onSavingChange }: SettingsTabProps) {
  const [availableServers, setAvailableServers] = useState<PlexConnectionOption[]>([]);
  const [loadingServers, setLoadingServers] = useState(false);
  const [serversError, setServersError] = useState<string | null>(null);
  const initial = useMemo(() => plexFormFromSettings(settings), [settings]);
  const [form, setForm] = useState<PlexForm>(initial);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const { artworkEnabled: initialArtwork, ...initialConnection } = initial;
  const { artworkEnabled, ...connection } = form;
  // Saving the connection re-tests it and re-discovers Plex users, so a save that only
  // flips the artwork toggle must not post it.
  const connectionDirty = !sameValues(connection, initialConnection);
  const dirty = connectionDirty || artworkEnabled !== initialArtwork;
  const status = useSaveStatus(dirty, onSavingChange);

  useEffect(() => setForm(initial), [initial]);

  const groupedServers = useMemo(() => availableServers.map((option) => ({
    value: option.uri,
    label: `${option.name} · ${option.uri}`,
    option,
  })), [availableServers]);

  // Typing an address by hand drops the picked server, so the save goes in manual mode.
  function editManually(patch: Partial<PlexForm>) {
    setForm((current) => ({ ...current, serverUri: "", machineIdentifier: "", ...patch }));
  }

  function buildPayload(): PlexConfigPayload {
    const parsedPort = Math.min(65535, Math.max(1, Math.floor(Number(form.port) || 32400)));
    return form.serverUri && form.machineIdentifier
      ? { mode: "preset", serverUrl: form.serverUri, machineIdentifier: form.machineIdentifier }
      : { mode: "manual", hostname: form.hostname.trim(), port: parsedPort, useSsl: form.useSsl };
  }

  async function loadServers() {
    setLoadingServers(true);
    setServersError(null);
    try {
      setAvailableServers(await apiGet<PlexConnectionOption[]>("/api/setup/plex/servers"));
    } catch (caught) {
      setServersError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoadingServers(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiPost<{ ok: boolean; message?: string; error?: string }>("/api/settings/plex/test", buildPayload());
      setTestResult({
        ok: result.ok,
        message: result.message ?? result.error ?? (result.ok ? "Test Succeeded" : "Test failed"),
      });
    } catch (caught) {
      setTestResult({ ok: false, message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setTesting(false);
    }
  }

  function save() {
    return status.run(async () => {
      // The artwork PATCH goes first. If the connection save then fails, the form stays
      // dirty and a retry repeats only the PATCH, which has no side effects. The other
      // order would re-test the connection and re-discover users on every retry.
      if (artworkEnabled !== initialArtwork) await apiPatch("/api/settings/app", { artworkEnabled });
      if (connectionDirty) await apiPost("/api/settings/plex", buildPayload());
      await onSave();
    });
  }

  return (
    <SettingsTabForm saving={status.saving}>
      <SectionCard title="Connection" description="Connect Pacearr to your Plex server. Load your available servers, or enter the address yourself.">
        {serversError && <ErrorBanner className="mb-0" message={serversError} />}
        <SettingRow label="Server" hint="Pick one of the servers on your Plex account." wide htmlFor="plex-server-select">
          <div className="grid grid-cols-[minmax(0,1fr)_40px] items-center gap-2">
            <SelectInput id="plex-server-select" aria-describedby="plex-server-select-hint" value={form.serverUri} onChange={(value) => {
              const match = groupedServers.find((entry) => entry.value === value)?.option;
              if (!match) {
                editManually({});
                return;
              }
              setForm((current) => ({
                ...current,
                serverUri: match.uri,
                machineIdentifier: match.machineIdentifier,
                hostname: match.address,
                port: String(match.port),
                useSsl: match.protocol === "https",
              }));
            }}>
              <option value="">Press refresh to load servers</option>
              {groupedServers.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </SelectInput>
            <button type="button" className={iconButtonClass} disabled={loadingServers} onClick={() => void loadServers()} title="Load available servers" aria-label="Load available servers">
              <RefreshCw size={15} className={loadingServers ? "animate-spin" : ""} />
            </button>
          </div>
        </SettingRow>
        <SettingRow label="Hostname or IP address" hint="Or enter the address yourself." wide htmlFor="plex-hostname">
          <div className="flex overflow-hidden rounded-lg border border-outline-variant/30 bg-background focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary">
            <span className="border-r border-outline-variant/30 bg-background-container-high px-3 py-2.5 text-[13px] text-on-surface-variant">{form.useSsl ? "https://" : "http://"}</span>
            <input id="plex-hostname" aria-describedby="plex-hostname-hint" className="w-full min-w-0 border-0 bg-transparent px-3 py-2.5 text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none" value={form.hostname} onChange={(event) => editManually({ hostname: event.target.value })} placeholder="192.168.1.10" />
          </div>
        </SettingRow>
        <SettingNumber label="Port" min={1} value={form.port} onChange={(value) => editManually({ port: value })} />
        <SettingToggle label="Use SSL" checked={form.useSsl} onChange={(value) => editManually({ useSsl: value })} />
        <TestConnection testing={testing} disabled={!form.serverUri && !form.hostname.trim()} result={testResult} onTest={() => void testConnection()} />
      </SectionCard>

      <SectionCard title="Library">
        <SettingToggle
          label="Rolling artwork"
          hint="Mark managed shows in Plex so you can tell at a glance which ones Pacearr is trimming."
          checked={form.artworkEnabled}
          onChange={(value) => setForm({ ...form, artworkEnabled: value })}
        />
      </SectionCard>

      <UnsavedChangesBar
        dirty={dirty}
        saving={status.saving}
        success={status.success}
        error={status.error}
        onSave={() => void save()}
        onDiscard={() => setForm(initial)}
      />
    </SettingsTabForm>
  );
}

/**
 * The masked API key field shared by the Sonarr and Tautulli tabs. A configured key shows
 * as asterisks until focused; leaving it empty keeps the saved key.
 */
function ApiKeyInput({ configured, touched, value, onChange, ...rest }: {
  configured: boolean;
  touched: boolean;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  "aria-describedby"?: string;
}) {
  return (
    <TextInput
      {...rest}
      type="password"
      value={touched ? value : configured ? "**************" : ""}
      onFocus={() => { if (!touched) onChange(""); }}
      onChange={onChange}
    />
  );
}

interface SonarrForm {
  baseUrl: string;
  apiKey: string;
  apiKeyTouched: boolean;
  tagsEnabled: boolean;
}

function sonarrFormFromSettings(settings: SettingsResponse): SonarrForm {
  return { baseUrl: settings.sonarr?.baseUrl ?? "", apiKey: "", apiKeyTouched: false, tagsEnabled: settings.app.sonarrTagsEnabled };
}

function SonarrTab({ settings, onSave, onSavingChange }: SettingsTabProps) {
  const initial = useMemo(() => sonarrFormFromSettings(settings), [settings]);
  const [form, setForm] = useState<SonarrForm>(initial);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const baseUrl = form.baseUrl.trim();
  const apiKey = form.apiKey.trim();
  const credentialsIncomplete = !baseUrl || (!apiKey && !settings.sonarr?.apiKeyConfigured);
  const credentials = { baseUrl, apiKey };
  // Saving the connection queues a library refresh, so a save that only flips the tag
  // toggle must not post it. An empty key keeps the saved one, so it isn't a change.
  const connectionDirty = baseUrl !== initial.baseUrl || apiKey !== "";
  const tagsDirty = form.tagsEnabled !== initial.tagsEnabled;
  const dirty = connectionDirty || tagsDirty;
  const status = useSaveStatus(dirty, onSavingChange);

  useEffect(() => setForm(initial), [initial]);

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiPost<{ ok: boolean; message?: string }>("/api/settings/sonarr/test", credentials);
      setTestResult({ ok: result.ok, message: result.message ?? "Test Succeeded" });
    } catch (caught) {
      setTestResult({ ok: false, message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setTesting(false);
    }
  }

  function save() {
    return status.run(async () => {
      // Unlike Plex, the connection goes first. Turning tag writing on starts a library
      // refresh straight away, and one started before a new connection was saved would
      // read the old instance's series but reconcile tags through the new one. In this
      // order, that refresh queues behind the one the connection save starts. The cost
      // is that a retry after a failed tags save repeats the connection save, which only
      // re-tests it and queues at most one more refresh.
      if (connectionDirty) await apiPost("/api/settings/sonarr", credentials);
      if (tagsDirty) await apiPatch("/api/settings/app", { sonarrTagsEnabled: form.tagsEnabled });
      await onSave();
    });
  }

  return (
    <SettingsTabForm saving={status.saving}>
      <SectionCard title="Connection" description="Connect Sonarr so Pacearr can monitor and trim your enrolled shows.">
        <SettingRow label="Base URL" hint="For example http://sonarr:8989" wide>
          <TextInput value={form.baseUrl} onChange={(value) => setForm({ ...form, baseUrl: value })} placeholder="http://sonarr:8989" />
        </SettingRow>
        <SettingRow label="API key" hint="Leave unchanged to keep the configured key." wide>
          <ApiKeyInput
            configured={Boolean(settings.sonarr?.apiKeyConfigured)}
            touched={form.apiKeyTouched}
            value={form.apiKey}
            onChange={(value) => setForm({ ...form, apiKey: value, apiKeyTouched: true })}
          />
        </SettingRow>
        <TestConnection testing={testing} disabled={credentialsIncomplete} result={testResult} onTest={() => void testConnection()} />
      </SectionCard>
      <SonarrTagsCard
        configured={Boolean(settings.sonarr?.baseUrl && settings.sonarr.apiKeyConfigured)}
        tagsEnabled={form.tagsEnabled}
        onTagsEnabledChange={(value) => setForm({ ...form, tagsEnabled: value })}
      />
      <UnsavedChangesBar
        dirty={dirty}
        saving={status.saving}
        success={status.success}
        error={status.error}
        onSave={() => void save()}
        onDiscard={() => setForm(initial)}
        saveDisabled={connectionDirty && credentialsIncomplete}
      />
    </SettingsTabForm>
  );
}

function pluralShows(count: number) {
  return `${count} show${count === 1 ? "" : "s"}`;
}

function SonarrTagsCard({ configured, tagsEnabled, onTagsEnabledChange }: { configured: boolean; tagsEnabled: boolean; onTagsEnabledChange: (value: boolean) => void }) {
  const [preview, setPreview] = useState<SonarrTagImportPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  // An import in flight must not be dismissable, as with the schedule dialog.
  const requestClose = () => { if (!importing) setPreview(null); };
  const dialogRef = useDialogA11y<HTMLDivElement>(preview !== null, requestClose);

  async function loadPreview() {
    setLoading(true);
    setResult(null);
    try {
      setPreview(await apiGet<SonarrTagImportPreview>("/api/sonarr/tag-import"));
    } catch (caught) {
      setResult({ ok: false, message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setLoading(false);
    }
  }

  async function runImport() {
    if (!preview) return;
    setImporting(true);
    try {
      const response = await apiPost<SonarrTagImportResult>("/api/sonarr/tag-import", {
        enrollSeriesIds: preview.toEnroll.map((show) => show.sonarrSeriesId),
        ignoreSeriesIds: preview.toIgnore.map((show) => show.sonarrSeriesId),
      });
      setResult({ ok: response.ok, message: response.message });
      setPreview(null);
    } catch (caught) {
      setResult({ ok: false, message: caught instanceof Error ? caught.message : String(caught) });
      setPreview(null);
    } finally {
      setImporting(false);
    }
  }

  const nothingToImport = preview !== null && preview.toEnroll.length === 0 && preview.toIgnore.length === 0;

  return (
    <SectionCard
      title="Tags"
      description="Mirror enrolled and ignored shows onto Sonarr as tags, so they can be recovered if Pacearr's database is lost."
    >
      <SettingToggle
        label="Write tags to Sonarr"
        hint="Tags enrolled shows pacearr-enrolled and ignored shows pacearr-ignored."
        checked={tagsEnabled}
        onChange={onTagsEnabledChange}
      />
      <SettingRow
        action
        label="Import from Sonarr tags"
        hint={result
          ? <span aria-live="polite" className={`font-bold ${result.ok ? "text-success" : "text-error"}`}>{result.message}</span>
          : "Restore enrolled and ignored shows from their tags, after losing Pacearr's records."}
      >
        <button type="button" className={secondaryButtonClass} disabled={!configured || loading} aria-busy={loading} onClick={() => void loadPreview()}>
          {loading ? "Checking Sonarr..." : "Review import"}
        </button>
      </SettingRow>
      {preview && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-overlay/60 p-[18px]">
          <div ref={dialogRef} className="max-h-[82vh] w-full max-w-[480px] overflow-auto rounded-xl border border-outline-variant/30 bg-background-container p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="tag-import-title" tabIndex={-1}>
            <div className="mb-4 flex items-center justify-between gap-3.5"><h2 id="tag-import-title" className="font-headline text-lg font-semibold">Import from Sonarr tags</h2><button type="button" className={iconButtonClass} disabled={importing} onClick={requestClose} aria-label="Close"><X size={18} /></button></div>
            <div className="grid gap-2 text-sm">
              {nothingToImport
                ? <p>No tagged shows are missing from Pacearr. There is nothing to import.</p>
                : <p className="font-bold">Enrol {pluralShows(preview.toEnroll.length)}, ignore {pluralShows(preview.toIgnore.length)}.</p>}
              {preview.alreadyKnown.length > 0 && <p className="text-on-surface-variant">{pluralShows(preview.alreadyKnown.length)} already in Pacearr will be left as they are.</p>}
              {preview.conflicts.length > 0 && (
                <p className="text-on-surface-variant">
                  {pluralShows(preview.conflicts.length)} carrying both Pacearr tags will be skipped: {preview.conflicts.map((show) => show.title).join(", ")}.
                </p>
              )}
            </div>
            <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
              <button type="button" className={secondaryButtonClass} disabled={importing} onClick={requestClose}>{nothingToImport ? "Close" : "Cancel"}</button>
              {!nothingToImport && <button type="button" className={primaryButtonClass} disabled={importing} aria-busy={importing} onClick={() => void runImport()}>{importing ? "Importing..." : "Import"}</button>}
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

interface TautulliForm {
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  apiKeyTouched: boolean;
}

function tautulliFormFromSettings(settings: SettingsResponse): TautulliForm {
  return { enabled: settings.tautulli.enabled, baseUrl: settings.tautulli.baseUrl, apiKey: "", apiKeyTouched: false };
}

function TautulliTab({ settings, onSave, onSavingChange }: SettingsTabProps) {
  const initial = useMemo(() => tautulliFormFromSettings(settings), [settings]);
  const [form, setForm] = useState<TautulliForm>(initial);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const baseUrl = form.baseUrl.trim();
  const apiKey = form.apiKey.trim();
  const credentialsIncomplete = !baseUrl || (!apiKey && !settings.tautulli.apiKeyConfigured);
  const credentials = { enabled: form.enabled, baseUrl, apiKey };
  const dirty = form.enabled !== initial.enabled || baseUrl !== initial.baseUrl || apiKey !== "";
  const status = useSaveStatus(dirty, onSavingChange);

  useEffect(() => setForm(initial), [initial]);

  async function testConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await apiPost<{ ok: boolean; message?: string }>("/api/settings/tautulli/test", credentials);
      setTestResult({ ok: result.ok, message: result.message ?? "Test Succeeded" });
    } catch (caught) {
      setTestResult({ ok: false, message: caught instanceof Error ? caught.message : String(caught) });
    } finally {
      setTesting(false);
    }
  }

  function save() {
    return status.run(async () => {
      await apiPost("/api/settings/tautulli", credentials);
      await onSave();
    });
  }

  return (
    <SettingsTabForm saving={status.saving}>
      <SectionCard title="Connection" description="Optional. Import richer watch history than Plex alone provides.">
        <SettingToggle label="Enable Tautulli import" checked={form.enabled} onChange={(value) => setForm({ ...form, enabled: value })} />
        <SettingRow label="Base URL" hint="For example http://tautulli:8181" wide>
          <TextInput value={form.baseUrl} onChange={(value) => setForm({ ...form, baseUrl: value })} placeholder="http://tautulli:8181" />
        </SettingRow>
        <SettingRow label="API key" hint="Leave unchanged to keep the configured key." wide>
          <ApiKeyInput
            configured={settings.tautulli.apiKeyConfigured}
            touched={form.apiKeyTouched}
            value={form.apiKey}
            onChange={(value) => setForm({ ...form, apiKey: value, apiKeyTouched: true })}
          />
        </SettingRow>
        <TestConnection testing={testing} disabled={credentialsIncomplete} result={testResult} onTest={() => void testConnection()} />
      </SectionCard>
      <UnsavedChangesBar
        dirty={dirty}
        saving={status.saving}
        success={status.success}
        error={status.error}
        onSave={() => void save()}
        onDiscard={() => setForm(initial)}
        saveDisabled={form.enabled && credentialsIncomplete}
      />
    </SettingsTabForm>
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
        <div className="fixed inset-0 z-50 grid place-items-center bg-overlay/60 p-[18px]">
          <button type="button" tabIndex={-1} className="absolute inset-0 cursor-default border-0 bg-transparent p-0" aria-label="Close log details" onClick={() => setActiveLog(null)} />
          <div ref={logDialogRef} className="relative z-10 max-h-[82vh] w-full max-w-[680px] overflow-auto rounded-xl border border-outline-variant/30 bg-background-container p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="log-details-title" tabIndex={-1}>
            <div className="mb-4 flex items-center justify-between gap-3.5"><h2 id="log-details-title" className="font-headline text-lg font-semibold">Log details</h2><button type="button" className={iconButtonClass} onClick={() => setActiveLog(null)} aria-label="Close"><X size={18} /></button></div>
            <div className="grid gap-2.5">
              <InfoRow label="Timestamp"><code className="rounded-md bg-background-container-high px-1.5 py-0.5 text-[13px] whitespace-pre-wrap break-words text-on-surface">{activeLog.timestamp}</code></InfoRow>
              <InfoRow label="Level"><span className={LEVEL_BADGE[activeLog.level]}>{activeLog.level}</span></InfoRow>
              <InfoRow label="Message"><span>{activeLog.message}</span></InfoRow>
              {activeLog.meta !== undefined && <InfoRow label="Meta"><pre className="rounded-md bg-background-container-high px-1.5 py-0.5 text-[13px] whitespace-pre-wrap break-words text-on-surface">{JSON.stringify(activeLog.meta, null, 2)}</pre></InfoRow>}
            </div>
            <div className="mt-4 flex justify-end"><button type="button" className={secondaryButtonClass} onClick={() => copyLog(activeLog)}><ClipboardCopy size={14} /> {copied ? "Copied!" : "Copy"}</button></div>
          </div>
        </div>
      )}
      <SectionCard title="Logs" description="Recent application logs. Full logs are written to /config/logs.">
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
          <button type="button" className={cn(secondaryButtonClass, autoRefresh && "bg-primary-dim")} onClick={() => setAutoRefresh((value) => !value)}>
            {autoRefresh ? <Pause size={14} /> : <Play size={14} />} {autoRefresh ? "Pause" : "Resume"}
          </button>
          <button type="button" className={iconButtonClass} onClick={() => void load()} aria-label="Refresh logs"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /></button>
        </div>
        <div className="overflow-hidden rounded-xl border border-outline-variant/30 bg-background-container-low">
          {loading && !data ? <div className="p-6 text-center text-on-surface-variant">Loading logs...</div> : results.length === 0 ? <div className="p-6 text-center text-on-surface-variant">No log entries match the current filter.</div> : results.map((entry, index) => (
            <div className="grid grid-cols-[7.5rem_58px_minmax(0,1fr)_auto] items-start gap-3 border-b border-outline-variant/30 px-3 py-2.5 text-xs last:border-b-0 max-[820px]:grid-cols-[1fr_auto]" key={`${entry.timestamp}-${index}`}>
              <span className="text-on-surface-variant">{new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span className={LEVEL_BADGE[entry.level]}>{entry.level}</span>
              <span className="break-words leading-relaxed">{entry.message}</span>
              <span className="flex gap-1 opacity-70">
                {entry.meta !== undefined && <button type="button" className="inline-flex size-8 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" onClick={() => setActiveLog(entry)} title="View details" aria-label="View details"><Eye size={13} /></button>}
                <button type="button" className="inline-flex size-8 items-center justify-center rounded-lg border border-outline-variant/30 bg-background-container-high text-on-surface" onClick={() => copyLog(entry)} title="Copy" aria-label="Copy"><ClipboardCopy size={13} /></button>
              </span>
            </div>
          ))}
        </div>
        {pageInfo && pageInfo.total > 0 && (
          <div className="flex items-center justify-between gap-3 text-xs text-on-surface-variant max-[820px]:flex-col max-[820px]:items-stretch">
            <span>{(pageInfo.page - 1) * pageInfo.pageSize + 1}-{Math.min(pageInfo.page * pageInfo.pageSize, pageInfo.total)} of {pageInfo.total}</span>
            <div className="flex items-center gap-2">
              <button type="button" className={iconButtonClass} disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="Previous page"><ChevronLeft size={14} /></button>
              <span>Page {page} / {pageInfo.pages}</span>
              <button type="button" className={iconButtonClass} disabled={page >= pageInfo.pages} onClick={() => setPage((value) => value + 1)} aria-label="Next page"><ChevronRight size={14} /></button>
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
      const result = await apiPost<{ triggered: boolean; triggeredJobId: string }>(`/api/settings/jobs/${id}/run`);
      setRunningId(result.triggeredJobId);
      await load(true);
    } finally {
      setRunningId(null);
    }
  }

  function openEdit(job: JobInfo) {
    const preset = JOB_PRESETS[job.id];
    if (!preset) return;
    const match = job.intervalDescription?.match(/every\s+(\d+)\s+(minute|hour|day)/i);
    const parsed = match ? Number(match[1]) : null;
    const unit = match?.[2]?.toLowerCase();
    const current = parsed === null || !Number.isFinite(parsed) || parsed < 1
      ? preset.values[0]
      : unit === "hour" ? parsed * 60 : unit === "day" ? parsed * 24 * 60 : parsed;
    setEditValue(String(current));
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

  // A save in flight must not be dismissable — Close/Cancel/Escape all route through
  // here so none of them can back out of a dialog whose PATCH will land anyway.
  const requestCloseJobDialog = () => { if (!saving) setEditingJob(null); };
  const jobDialogRef = useDialogA11y<HTMLDivElement>(editingJob !== null, requestCloseJobDialog);

  return (
    <>
      {editingJob && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-overlay/60 p-[18px]">
          <div ref={jobDialogRef} className="w-full max-w-[430px] overflow-auto rounded-xl border border-outline-variant/30 bg-background-container p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="edit-schedule-title" tabIndex={-1}>
            <div className="mb-4 flex items-center justify-between gap-3.5"><h2 id="edit-schedule-title" className="font-headline text-lg font-semibold">Edit schedule</h2><button type="button" className={iconButtonClass} disabled={saving} onClick={requestCloseJobDialog} aria-label="Close"><X size={18} /></button></div>
            <Field label="New frequency" hint={`Current: ${editingJob.intervalDescription ?? "Manual"}`}>
              <SelectInput value={editValue} onChange={setEditValue}>
                {(JOB_PRESETS[editingJob.id]?.values ?? []).map((value) => <option key={value} value={String(value)}>{formatPresetLabel(value, JOB_PRESETS[editingJob.id]?.unit ?? "minutes")}</option>)}
              </SelectInput>
            </Field>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button type="button" className={secondaryButtonClass} disabled={saving} onClick={requestCloseJobDialog}>Cancel</button>
              <button type="button" className={primaryButtonClass} disabled={saving} onClick={() => void saveSchedule()}>{saving ? "Saving..." : "Save"}</button>
            </div>
          </div>
        </div>
      )}
      <SectionCard title="Jobs" description="Pacearr's background jobs. Run one now, or change how often the schedulable ones run.">
        {loading ? <div className="p-6 text-center text-on-surface-variant">Loading jobs...</div> : (
          <div className="overflow-hidden rounded-xl border border-outline-variant/30 bg-background-container-low">
            <div className="grid grid-cols-[minmax(220px,1.4fr)_minmax(130px,.7fr)_minmax(160px,.8fr)_minmax(210px,auto)] items-center gap-4 border-b border-outline-variant/30 px-4 py-[13px] text-[11px] font-black uppercase text-on-surface-variant max-[820px]:hidden"><span>Job</span><span>Next run</span><span>Last run</span><span /></div>
            {jobs.map((job) => {
              const active = runningId === job.id || Boolean(job.running || job.isRunning);
              return (
                <div className="grid grid-cols-[minmax(220px,1.4fr)_minmax(130px,.7fr)_minmax(160px,.8fr)_minmax(210px,auto)] items-center gap-4 border-b border-outline-variant/30 px-4 py-[13px] last:border-b-0 max-[820px]:grid-cols-1" key={job.id}>
                  <div><strong className="mr-2">{job.name ?? job.id}</strong>{active && <span className="inline-block size-[9px] shrink-0 rounded-full bg-primary" />}<small className="mt-0.5 block text-on-surface-variant">{job.intervalDescription ?? "Manual"}</small>{job.statusDescription && <small className="mt-0.5 block text-on-surface-variant">{job.statusDescription}</small>}</div>
                  <span>{job.nextRunAt ? formatFutureTime(job.nextRunAt) : job.nextRunLabel ?? "-"}</span>
                  <span>{active ? "Running now" : job.lastRunAt ? `${formatRelativeTime(job.lastRunAt)}${job.lastRunStatus ? ` · ${job.lastRunStatus}` : ""}` : "-"}</span>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {JOB_PRESETS[job.id] && <button type="button" className={compactSecondaryButtonClass} onClick={() => openEdit(job)}><Pencil size={13} /> Edit</button>}
                    {job.enabled && <button type="button" className={compactPrimaryButtonClass} disabled={active} onClick={() => void runJob(job.id)}><Play size={13} /> {active ? "Running..." : "Run now"}</button>}
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
  const changelogDialogRef = useDialogA11y<HTMLDivElement>(changelogRelease !== null, () => setChangelogRelease(null));

  return (
    <div className="grid gap-4">
      <SectionCard title="About Pacearr">
        <div className="grid gap-2.5">
          <InfoRow label="Version"><a className="inline-flex min-h-6 items-center text-[13px] font-bold text-on-surface-variant hover:text-on-surface hover:underline" href={GITHUB_RELEASES_URL} target="_blank" rel="noopener noreferrer">v{info?.version ?? "..."}</a></InfoRow>
          <InfoRow label="Build channel"><span>{info?.buildChannel ?? "..."}</span></InfoRow>
          {info?.buildChannel !== "stable" && <InfoRow label="Commit"><code className={codeClass}>{info?.commitSha ?? "..."}</code></InfoRow>}
          <InfoRow label="Node"><code className={codeClass}>{info?.nodeVersion ?? "..."}</code></InfoRow>
          <InfoRow label="Platform"><code className={codeClass}>{info?.platform ?? "..."}</code></InfoRow>
          <InfoRow label="Data directory"><code className={codeClass}>{info?.dataDir ?? "..."}</code></InfoRow>
          <InfoRow label="Timezone"><code className={codeClass}>{info?.tz ?? "..."}</code></InfoRow>
        </div>
      </SectionCard>
      <SectionCard title="Getting support">
        <div className="grid gap-2.5">
          <InfoRow label="GitHub"><a className="break-all text-[13px] font-bold text-on-surface-variant hover:text-on-surface hover:underline" href={GITHUB_REPOSITORY_URL} target="_blank" rel="noopener noreferrer">github.com/Migz93/pacearr</a></InfoRow>
          <InfoRow label="Health check"><code className={codeClass}>/api/health</code></InfoRow>
        </div>
      </SectionCard>
      <SectionCard title="Releases" description="Fetched from the public Pacearr repository on GitHub.">
        {releasesError && <p className="text-on-surface-variant">Release data is currently unavailable.</p>}
        {!releases && !releasesError && <p className="text-on-surface-variant">Loading releases...</p>}
        {releases?.length === 0 && <p className="text-on-surface-variant">No releases found.</p>}
        {releases && releases.length > 0 && <div className="grid gap-2">
          {releases.map((release, index) => (
            <div className="flex items-center justify-between gap-3.5 rounded-lg border border-outline-variant/30 bg-background-container-low p-3.5" key={release.id}>
              <div className="grid min-w-0 gap-1">
                <div className="flex min-w-0 items-center gap-2">
                  <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-sm">{releaseTitle(release)}</strong>
                  {index === 0 && <span className={`${badgeClass("success")} shrink-0`}>Latest</span>}
                  {info?.buildChannel === "stable" && isCurrentRelease(release, info.version) && <span className={`${badgeClass("successStrong")} shrink-0`}>Current</span>}
                </div>
                {release.published_at && <small className="text-xs text-on-surface-variant">{new Date(release.published_at).toLocaleDateString()}</small>}
              </div>
              <button type="button" className={compactSecondaryButtonClass} onClick={() => setChangelogRelease(release)}>View changelog</button>
            </div>
          ))}
        </div>}
      </SectionCard>
      {changelogRelease && <div className="fixed inset-0 z-50 grid place-items-center bg-overlay/60 p-[18px]" role="presentation" onMouseDown={() => setChangelogRelease(null)}>
        <div ref={changelogDialogRef} className="grid w-full max-w-[680px] gap-4 overflow-auto rounded-xl border border-outline-variant/30 bg-background-container p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="changelog-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between gap-3.5">
            <div><h2 id="changelog-title" className="font-headline text-lg font-semibold">{releaseTitle(changelogRelease)} changelog</h2></div>
            <button type="button" className={iconButtonClass} onClick={() => setChangelogRelease(null)} aria-label="Close changelog"><X size={18} /></button>
          </div>
          {changelogRelease.body ? <pre className="m-0 max-h-[52vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-outline-variant/30 bg-background p-3 font-mono text-[13px] leading-relaxed text-on-surface">{changelogRelease.body}</pre> : <p className="text-on-surface-variant">No changelog is available for this release.</p>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <a className={compactSecondaryButtonClass} href={changelogRelease.html_url.startsWith(GITHUB_REPOSITORY_URL) ? changelogRelease.html_url : GITHUB_RELEASES_URL} target="_blank" rel="noopener noreferrer">View on GitHub</a>
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

function formatPresetLabel(value: number, unit: "minutes" | "hours" | "days") {
  if (unit === "hours") {
    const hours = value / 60;
    return `Every ${hours} hour${hours !== 1 ? "s" : ""}`;
  }
  if (unit === "days") {
    const days = value / (24 * 60);
    return `Every ${days} day${days !== 1 ? "s" : ""}`;
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
