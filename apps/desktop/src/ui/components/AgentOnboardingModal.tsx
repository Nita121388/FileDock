import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  agentInit,
  agentInstall,
  agentStatus,
  agentUninstall,
  type AgentInitSummary,
  type AgentInstallSummary,
  type AgentStatusSummary,
  type AgentUninstallSummary
} from "../api/tauri";
import { openDialog } from "../api/dialog";
import type { NoticeLevel } from "./NoticeCenter";
import type { Settings } from "../model/settings";
import { parseServerConfigImport } from "../model/presetUtils";
import {
  buildAgentAuthPreview,
  sanitizeProfileName,
  suggestDeviceName,
  suggestProfileName
} from "../model/agentOnboarding";
import Icon from "./Icon";

type Props = {
  open: boolean;
  onClose: () => void;
  onNotify: (level: NoticeLevel, message: string) => void;
  settings: Pick<Settings, "serverBaseUrl" | "token" | "deviceId" | "deviceToken">;
  webPreview: boolean;
};

type BusyAction = "save" | "preview" | "install" | "uninstall" | "status" | null;
type AgentInstallMode = "daemon" | "scheduled";

const DEFAULT_PROFILE = "backup";
const DEFAULT_INTERVAL_MINUTES = "15";
const DEFAULT_HEARTBEAT_MINUTES = "5";

export default function AgentOnboardingModal(props: Props) {
  const { open, onClose, onNotify, settings, webPreview } = props;
  const { t, i18n } = useTranslation();

  const connectionFromSettings = useMemo(
    () => ({
      serverBaseUrl: settings.serverBaseUrl.trim(),
      token: settings.token,
      deviceId: settings.deviceId,
      deviceToken: settings.deviceToken
    }),
    [settings.deviceId, settings.deviceToken, settings.serverBaseUrl, settings.token]
  );

  const [payloadText, setPayloadText] = useState("");
  const [bootstrap, setBootstrap] = useState(connectionFromSettings);
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [deviceName, setDeviceName] = useState(suggestDeviceName(DEFAULT_PROFILE));
  const [folder, setFolder] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState(DEFAULT_INTERVAL_MINUTES);
  const [heartbeatMinutes, setHeartbeatMinutes] = useState(DEFAULT_HEARTBEAT_MINUTES);
  const [installMode, setInstallMode] = useState<AgentInstallMode>("daemon");
  const [keepBootstrapToken, setKeepBootstrapToken] = useState(false);
  const [deleteConfigOnUninstall, setDeleteConfigOnUninstall] = useState(false);
  const [profileTouched, setProfileTouched] = useState(false);
  const [deviceNameTouched, setDeviceNameTouched] = useState(false);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [initSummary, setInitSummary] = useState<AgentInitSummary | null>(null);
  const [installPreview, setInstallPreview] = useState<AgentInstallSummary | null>(null);
  const [installSummary, setInstallSummary] = useState<AgentInstallSummary | null>(null);
  const [uninstallSummary, setUninstallSummary] = useState<AgentUninstallSummary | null>(null);
  const [statusSummary, setStatusSummary] = useState<AgentStatusSummary | null>(null);

  useEffect(() => {
    if (!open) return;
    setPayloadText("");
    setBootstrap(connectionFromSettings);
    setProfile(DEFAULT_PROFILE);
    setDeviceName(suggestDeviceName(DEFAULT_PROFILE));
    setFolder("");
    setIntervalMinutes(DEFAULT_INTERVAL_MINUTES);
    setHeartbeatMinutes(DEFAULT_HEARTBEAT_MINUTES);
    setInstallMode("daemon");
    setKeepBootstrapToken(false);
    setDeleteConfigOnUninstall(false);
    setProfileTouched(false);
    setDeviceNameTouched(false);
    setBusyAction(null);
    setInitSummary(null);
    setInstallPreview(null);
    setInstallSummary(null);
    setUninstallSummary(null);
    setStatusSummary(null);
  }, [connectionFromSettings, open]);

  const authPreview = useMemo(
    () => buildAgentAuthPreview(bootstrap, keepBootstrapToken),
    [bootstrap, keepBootstrapToken]
  );

  const canRunSetup = !webPreview && busyAction === null;
  const effectiveProfile = profile.trim();
  const effectiveDeviceName = deviceName.trim() || suggestDeviceName(effectiveProfile || DEFAULT_PROFILE);

  const applyPayload = () => {
    const raw = payloadText.trim();
    if (!raw) {
      onNotify("warning", t("app.agentSetup.notice.payloadRequired"));
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      const imported = parseServerConfigImport(parsed);
      if (!imported) {
        onNotify("warning", t("app.agentSetup.notice.payloadInvalid"));
        return;
      }
      setBootstrap({
        serverBaseUrl: imported.serverBaseUrl,
        token: imported.token ?? "",
        deviceId: imported.deviceId ?? "",
        deviceToken: imported.deviceToken ?? ""
      });
      onNotify("info", t("app.agentSetup.notice.payloadApplied", { server: imported.serverBaseUrl }));
    } catch (error: any) {
      onNotify("error", String(error?.message ?? error));
    }
  };

  const useCurrentConnection = () => {
    setBootstrap(connectionFromSettings);
    onNotify("info", t("app.agentSetup.notice.currentConnection"));
  };

  const pickFolder = async () => {
    try {
      const picked = await openDialog({
        title: t("app.agentSetup.folderDialogTitle"),
        directory: true,
        multiple: false
      });
      if (!picked || Array.isArray(picked)) return;
      setFolder(picked);
      if (!profileTouched) {
        const nextProfile = suggestProfileName(picked, DEFAULT_PROFILE);
        setProfile(nextProfile);
        if (!deviceNameTouched) {
          setDeviceName(suggestDeviceName(nextProfile));
        }
      }
      onNotify("info", t("app.agentSetup.notice.folderSelected", { path: picked }));
    } catch (error: any) {
      onNotify("error", String(error?.message ?? error));
    }
  };

  const refreshStatus = async (targetProfile = effectiveProfile) => {
    const summary = await agentStatus(targetProfile);
    setStatusSummary(summary);
    return summary;
  };

  const previewInstall = async (targetProfile = effectiveProfile) => {
    const summary = await agentInstall({ profile: targetProfile, dry_run: true, mode: installMode });
    setInstallPreview(summary);
    return summary;
  };

  const validateBeforeRun = () => {
    if (!effectiveProfile) {
      onNotify("warning", t("app.agentSetup.notice.profileRequired"));
      return false;
    }
    if (!folder.trim()) {
      onNotify("warning", t("app.agentSetup.notice.folderRequired"));
      return false;
    }
    if (!bootstrap.serverBaseUrl.trim()) {
      onNotify("warning", t("app.agentSetup.notice.serverRequired"));
      return false;
    }
    if (authPreview.kind === "invalid_partial_device") {
      onNotify("warning", t("app.agentSetup.notice.deviceAuthIncomplete"));
      return false;
    }
    return true;
  };

  const runCreateProfile = async () => {
    if (!validateBeforeRun()) return;
    setBusyAction("save");
    try {
      const init = await agentInit({
        profile: effectiveProfile,
        folder: folder.trim(),
        server_base_url: bootstrap.serverBaseUrl.trim(),
        device_name: effectiveDeviceName,
        interval_secs: minutesToSeconds(intervalMinutes, 15, 1),
        heartbeat_secs: minutesToSeconds(heartbeatMinutes, 5, 0),
        keep_bootstrap_token: keepBootstrapToken,
        token: bootstrap.token?.trim() || undefined,
        device_id: bootstrap.deviceId?.trim() || undefined,
        device_token: bootstrap.deviceToken?.trim() || undefined
      });
      setInitSummary(init);
      setUninstallSummary(null);
      onNotify("info", t("app.agentSetup.notice.profileSaved", { profile: init.profile }));

      const [previewResult, statusResult] = await Promise.allSettled([
        previewInstall(init.profile),
        refreshStatus(init.profile)
      ]);
      if (previewResult.status === "rejected") {
        onNotify("warning", String(previewResult.reason?.message ?? previewResult.reason));
      }
      if (statusResult.status === "rejected") {
        onNotify("warning", String(statusResult.reason?.message ?? statusResult.reason));
      }
    } catch (error: any) {
      onNotify("error", String(error?.message ?? error));
    } finally {
      setBusyAction(null);
    }
  };

  const runPreviewInstall = async () => {
    if (!validateBeforeRun()) return;
    setBusyAction("preview");
    try {
      const summary = await previewInstall();
      onNotify("info", t("app.agentSetup.notice.previewReady", { manager: summary.service_manager }));
    } catch (error: any) {
      onNotify("error", String(error?.message ?? error));
    } finally {
      setBusyAction(null);
    }
  };

  const runInstall = async () => {
    if (!validateBeforeRun()) return;
    setBusyAction("install");
    try {
      const summary = await agentInstall({ profile: effectiveProfile, dry_run: false, mode: installMode });
      setInstallSummary(summary);
      setUninstallSummary(null);
      onNotify("info", t("app.agentSetup.notice.installed", { service: summary.service_name }));
      await refreshStatus(effectiveProfile);
    } catch (error: any) {
      onNotify("error", String(error?.message ?? error));
    } finally {
      setBusyAction(null);
    }
  };

  const runUninstall = async () => {
    if (!effectiveProfile) {
      onNotify("warning", t("app.agentSetup.notice.profileRequired"));
      return;
    }
    setBusyAction("uninstall");
    try {
      const summary = await agentUninstall({
        profile: effectiveProfile,
        delete_config: deleteConfigOnUninstall
      });
      setUninstallSummary(summary);
      setInstallSummary(null);
      setInstallPreview(null);
      if (summary.removed_config) {
        setInitSummary(null);
      }
      onNotify("info", t("app.agentSetup.notice.uninstalled", { service: summary.service_name }));
      try {
        await refreshStatus(effectiveProfile);
      } catch (error: any) {
        onNotify("warning", String(error?.message ?? error));
      }
    } catch (error: any) {
      onNotify("error", String(error?.message ?? error));
    } finally {
      setBusyAction(null);
    }
  };

  const runRefreshStatus = async () => {
    if (!effectiveProfile) {
      onNotify("warning", t("app.agentSetup.notice.profileRequired"));
      return;
    }
    setBusyAction("status");
    try {
      await refreshStatus();
      onNotify("info", t("app.agentSetup.notice.statusRefreshed", { profile: effectiveProfile }));
    } catch (error: any) {
      onNotify("error", String(error?.message ?? error));
    } finally {
      setBusyAction(null);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-label={t("app.agentSetup.title")}>
      <div className="modal-panel agent-setup-panel">
        <div className="modal-header agent-setup-header">
          <div>
            <div className="agent-setup-title">{t("app.agentSetup.title")}</div>
            <div className="agent-setup-subtitle">{t("app.agentSetup.subtitle")}</div>
          </div>
          <button className="btn icon-only" onClick={onClose} title={t("common.actions.close")} aria-label={t("common.actions.close")}>
            <Icon name="close" />
          </button>
        </div>

        <div className="modal-body agent-setup-body">
          {webPreview ? (
            <div className="agent-setup-banner warning">{t("app.agentSetup.webPreview")}</div>
          ) : null}

          <section className="agent-setup-card">
            <div className="agent-setup-card-head">
              <div className="agent-setup-step">1</div>
              <div>
                <div className="agent-setup-card-title">{t("app.agentSetup.bootstrapTitle")}</div>
                <div className="agent-setup-card-desc">{t("app.agentSetup.bootstrapDesc")}</div>
              </div>
            </div>
            <div className="agent-setup-form two-up">
              <label className="agent-field wide">
                <span>{t("app.agentSetup.payloadLabel")}</span>
                <textarea
                  className="agent-input agent-textarea"
                  value={payloadText}
                  onChange={(e) => setPayloadText(e.target.value)}
                  placeholder={t("app.agentSetup.payloadPlaceholder")}
                />
              </label>
              <div className="agent-side-panel">
                <div className="agent-pill-list">
                  <span className="agent-pill">{t("app.agentSetup.serverLabelShort", { server: bootstrap.serverBaseUrl || t("app.agentSetup.missing") })}</span>
                  <span className="agent-pill">{t(authPreviewLabelKey(authPreview.kind))}</span>
                </div>
                <div className="agent-actions-row">
                  <button className="btn" type="button" onClick={applyPayload} disabled={!canRunSetup}>
                    {t("app.agentSetup.applyPayload")}
                  </button>
                  <button className="btn" type="button" onClick={useCurrentConnection}>
                    {t("app.agentSetup.useCurrent")}
                  </button>
                </div>
                <div className="agent-inline-note">{t(authPreviewDetailKey(authPreview.kind))}</div>
              </div>
            </div>
          </section>

          <section className="agent-setup-card">
            <div className="agent-setup-card-head">
              <div className="agent-setup-step">2</div>
              <div>
                <div className="agent-setup-card-title">{t("app.agentSetup.profileTitle")}</div>
                <div className="agent-setup-card-desc">{t("app.agentSetup.profileDesc")}</div>
              </div>
            </div>
            <div className="agent-setup-form two-up compact">
              <label className="agent-field">
                <span>{t("app.agentSetup.profileLabel")}</span>
                <input
                  className="agent-input"
                  value={profile}
                  onChange={(e) => {
                    const nextProfile = sanitizeProfileName(e.target.value, "");
                    setProfileTouched(true);
                    setProfile(nextProfile);
                    if (!deviceNameTouched) {
                      setDeviceName(suggestDeviceName(nextProfile || DEFAULT_PROFILE));
                    }
                  }}
                  placeholder={t("app.agentSetup.profilePlaceholder")}
                  spellCheck={false}
                />
              </label>
              <label className="agent-field">
                <span>{t("app.agentSetup.deviceNameLabel")}</span>
                <input
                  className="agent-input"
                  value={deviceName}
                  onChange={(e) => {
                    setDeviceNameTouched(true);
                    setDeviceName(e.target.value);
                  }}
                  placeholder={t("app.agentSetup.deviceNamePlaceholder")}
                  spellCheck={false}
                />
              </label>
              <label className="agent-field wide">
                <span>{t("app.agentSetup.folderLabel")}</span>
                <div className="agent-folder-row">
                  <input
                    className="agent-input"
                    value={folder}
                    onChange={(e) => setFolder(e.target.value)}
                    placeholder={t("app.agentSetup.folderPlaceholder")}
                    spellCheck={false}
                  />
                  <button className="btn" type="button" onClick={pickFolder} disabled={webPreview}>
                    {t("app.agentSetup.folderBrowse")}
                  </button>
                </div>
              </label>
            </div>
          </section>

          <section className="agent-setup-card">
            <div className="agent-setup-card-head">
              <div className="agent-setup-step">3</div>
              <div>
                <div className="agent-setup-card-title">{t("app.agentSetup.scheduleTitle")}</div>
                <div className="agent-setup-card-desc">{t("app.agentSetup.scheduleDesc")}</div>
              </div>
            </div>
            <div className="agent-setup-form two-up compact">
              <label className="agent-field">
                <span>{t("app.agentSetup.intervalLabel")}</span>
                <input
                  className="agent-input"
                  type="number"
                  min={1}
                  step={1}
                  value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(e.target.value)}
                />
              </label>
              <label className="agent-field">
                <span>{t("app.agentSetup.heartbeatLabel")}</span>
                <input
                  className="agent-input"
                  type="number"
                  min={0}
                  step={1}
                  value={heartbeatMinutes}
                  onChange={(e) => setHeartbeatMinutes(e.target.value)}
                />
              </label>
              <label className="agent-field wide">
                <span>{t("app.agentSetup.modeLabel")}</span>
                <select
                  className="agent-input"
                  value={installMode}
                  onChange={(e) => setInstallMode(e.target.value as AgentInstallMode)}
                  disabled={!canRunSetup}
                >
                  <option value="daemon">{t("app.agentSetup.modeDaemon")}</option>
                  <option value="scheduled">{t("app.agentSetup.modeScheduled")}</option>
                </select>
              </label>
              <div className="agent-inline-note wide">
                {installMode === "scheduled" ? t("app.agentSetup.modeScheduledDesc") : t("app.agentSetup.modeDaemonDesc")}
              </div>
              <label className="agent-checkbox wide">
                <input
                  type="checkbox"
                  checked={keepBootstrapToken}
                  onChange={(e) => setKeepBootstrapToken(e.target.checked)}
                />
                <span>
                  <strong>{t("app.agentSetup.keepBootstrapTitle")}</strong>
                  <span>{t("app.agentSetup.keepBootstrapDesc")}</span>
                </span>
              </label>
            </div>
          </section>

          <section className="agent-setup-card result-card">
            <div className="agent-setup-card-head">
              <div className="agent-setup-step">4</div>
              <div>
                <div className="agent-setup-card-title">{t("app.agentSetup.actionsTitle")}</div>
                <div className="agent-setup-card-desc">{t("app.agentSetup.actionsDesc")}</div>
              </div>
            </div>

            <div className="agent-actions-row wrap">
              <button className="btn primary" type="button" onClick={runCreateProfile} disabled={!canRunSetup}>
                {busyAction === "save" ? t("app.agentSetup.busySaving") : t("app.agentSetup.saveProfile")}
              </button>
              <button className="btn" type="button" onClick={runPreviewInstall} disabled={!canRunSetup}>
                {busyAction === "preview" ? t("app.agentSetup.busyPreview") : t("app.agentSetup.previewInstall")}
              </button>
              <button className="btn" type="button" onClick={runInstall} disabled={!canRunSetup}>
                {busyAction === "install" ? t("app.agentSetup.busyInstalling") : t("app.agentSetup.installNow")}
              </button>
              <button className="btn" type="button" onClick={runUninstall} disabled={!canRunSetup}>
                {busyAction === "uninstall" ? t("app.agentSetup.busyUninstall") : t("app.agentSetup.uninstallNow")}
              </button>
              <button className="btn" type="button" onClick={runRefreshStatus} disabled={!canRunSetup}>
                {busyAction === "status" ? t("app.agentSetup.busyStatus") : t("app.agentSetup.refreshStatus")}
              </button>
            </div>

            <label className="agent-checkbox wide">
              <input
                type="checkbox"
                checked={deleteConfigOnUninstall}
                onChange={(e) => setDeleteConfigOnUninstall(e.target.checked)}
              />
              <span>
                <strong>{t("app.agentSetup.deleteConfigTitle")}</strong>
                <span>{t("app.agentSetup.deleteConfigDesc")}</span>
              </span>
            </label>

            <div className="agent-summary-grid">
              <div className="agent-summary-block">
                <div className="agent-summary-title">{t("app.agentSetup.previewTitle")}</div>
                <dl className="agent-summary-list">
                  <SummaryRow label={t("app.agentSetup.previewProfile")} value={effectiveProfile || t("app.agentSetup.missing")} />
                  <SummaryRow label={t("app.agentSetup.previewDevice")} value={effectiveDeviceName || t("app.agentSetup.missing")} />
                  <SummaryRow label={t("app.agentSetup.previewFolder")} value={folder.trim() || t("app.agentSetup.missing")} />
                  <SummaryRow label={t("app.agentSetup.previewAuth")} value={t(authPreviewLabelKey(authPreview.kind))} />
                  <SummaryRow
                    label={t("app.agentSetup.previewMode")}
                    value={installMode === "scheduled" ? t("app.agentSetup.modeScheduled") : t("app.agentSetup.modeDaemon")}
                  />
                </dl>
              </div>

              <div className="agent-summary-block">
                <div className="agent-summary-title">{t("app.agentSetup.profileResultTitle")}</div>
                {initSummary ? (
                  <dl className="agent-summary-list">
                    <SummaryRow label={t("app.agentSetup.resultConfigPath")} value={initSummary.config_path} />
                    <SummaryRow label={t("app.agentSetup.resultStatePath")} value={initSummary.state_path} />
                    <SummaryRow label={t("app.agentSetup.resultAuthMode")} value={initSummary.auth_mode} />
                    <SummaryRow
                      label={t("app.agentSetup.resultRegistration")}
                      value={initSummary.device_registered ? t("common.yes") : t("common.no")}
                    />
                    <SummaryRow label={t("app.agentSetup.resultDeviceId")} value={initSummary.device_id || t("app.agentSetup.notAvailable")} />
                  </dl>
                ) : (
                  <div className="agent-empty-state">{t("app.agentSetup.profileResultEmpty")}</div>
                )}
              </div>

              <div className="agent-summary-block">
                <div className="agent-summary-title">{t("app.agentSetup.servicePreviewTitle")}</div>
                {installPreview ? (
                  <>
                    <dl className="agent-summary-list compact-list">
                      <SummaryRow label={t("app.agentSetup.serviceManager")} value={installPreview.service_manager} />
                      <SummaryRow label={t("app.agentSetup.serviceName")} value={installPreview.service_name} />
                      <SummaryRow label={t("app.agentSetup.servicePath")} value={installPreview.service_path || t("app.agentSetup.notAvailable")} />
                    </dl>
                    {installPreview.preview ? <pre className="agent-preview-code">{installPreview.preview}</pre> : null}
                    {installPreview.note ? <div className="agent-inline-note">{installPreview.note}</div> : null}
                  </>
                ) : (
                  <div className="agent-empty-state">{t("app.agentSetup.servicePreviewEmpty")}</div>
                )}
              </div>

              <div className="agent-summary-block">
                <div className="agent-summary-title">{t("app.agentSetup.cleanupResultTitle")}</div>
                {uninstallSummary ? (
                  <dl className="agent-summary-list compact-list">
                    <SummaryRow label={t("app.agentSetup.serviceManager")} value={uninstallSummary.service_manager} />
                    <SummaryRow label={t("app.agentSetup.serviceName")} value={uninstallSummary.service_name} />
                    <SummaryRow label={t("app.agentSetup.servicePath")} value={uninstallSummary.service_path || t("app.agentSetup.notAvailable")} />
                    <SummaryRow
                      label={t("app.agentSetup.cleanupServiceRemoved")}
                      value={uninstallSummary.removed_service ? t("common.yes") : t("common.no")}
                    />
                    <SummaryRow
                      label={t("app.agentSetup.cleanupConfigRemoved")}
                      value={uninstallSummary.removed_config ? t("common.yes") : t("common.no")}
                    />
                  </dl>
                ) : (
                  <div className="agent-empty-state">{t("app.agentSetup.cleanupEmpty")}</div>
                )}
                {uninstallSummary?.note ? <div className="agent-inline-note">{uninstallSummary.note}</div> : null}
              </div>

              <div className="agent-summary-block">
                <div className="agent-summary-title">{t("app.agentSetup.statusTitle")}</div>
                {statusSummary ? (
                  <dl className="agent-summary-list compact-list">
                    <SummaryRow label={t("app.agentSetup.statusConfig")} value={statusSummary.config_exists ? t("common.yes") : t("common.no")} />
                    <SummaryRow label={t("app.agentSetup.statusState")} value={statusSummary.state_exists ? t("common.yes") : t("common.no")} />
                    <SummaryRow label={t("app.agentSetup.statusInstalled")} value={statusSummary.service.installed ? t("common.yes") : t("common.no")} />
                    <SummaryRow label={t("app.agentSetup.statusRunning")} value={formatMaybeBool(statusSummary.service.running, t)} />
                    <SummaryRow label={t("app.agentSetup.statusEnabled")} value={formatMaybeBool(statusSummary.service.enabled, t)} />
                    <SummaryRow
                      label={t("app.agentSetup.statusLastSeen")}
                      value={formatUnix(statusSummary.server_status?.last_seen_unix, i18n.language, t)}
                    />
                    <SummaryRow
                      label={t("app.agentSetup.statusSnapshots")}
                      value={formatMaybeNumber(statusSummary.server_status?.snapshot_count, t)}
                    />
                    <SummaryRow
                      label={t("app.agentSetup.statusLatestSnapshot")}
                      value={statusSummary.server_status?.latest_snapshot_id || t("app.agentSetup.notAvailable")}
                    />
                  </dl>
                ) : (
                  <div className="agent-empty-state">{t("app.agentSetup.statusEmpty")}</div>
                )}
                {installSummary?.note ? <div className="agent-inline-note">{installSummary.note}</div> : null}
                {statusSummary?.service.note ? <div className="agent-inline-note">{statusSummary.service.note}</div> : null}
                {statusSummary?.server_status?.error ? <div className="agent-inline-note">{statusSummary.server_status.error}</div> : null}
              </div>
            </div>
          </section>
        </div>

        <div className="modal-footer agent-setup-footer">
          <div className="agent-footer-note">{t("app.agentSetup.footerNote")}</div>
          <button className="btn" type="button" onClick={onClose}>
            {t("common.actions.close")}
          </button>
        </div>
      </div>
      <button className="modal-backdrop" aria-label={t("common.actions.close")} onClick={onClose} />
    </div>
  );
}

function SummaryRow(props: { label: string; value: string }) {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </>
  );
}

function minutesToSeconds(raw: string, fallbackMinutes: number, minMinutes: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallbackMinutes * 60;
  return Math.max(minMinutes, Math.round(value)) * 60;
}

function formatMaybeBool(value: boolean | null | undefined, t: (key: string) => string): string {
  if (value === true) return t("common.yes");
  if (value === false) return t("common.no");
  return t("app.agentSetup.notAvailable");
}

function formatMaybeNumber(value: number | null | undefined, t: (key: string) => string): string {
  if (typeof value !== "number") return t("app.agentSetup.notAvailable");
  return String(value);
}

function formatUnix(
  unix: number | null | undefined,
  locale: string,
  t: (key: string) => string
): string {
  if (typeof unix !== "number") return t("app.agentSetup.notAvailable");
  const resolvedLocale = locale === "auto" ? undefined : locale;
  return new Date(unix * 1000).toLocaleString(resolvedLocale);
}

function authPreviewLabelKey(kind: ReturnType<typeof buildAgentAuthPreview>["kind"]): string {
  switch (kind) {
    case "invalid_partial_device":
      return "app.agentSetup.auth.invalid";
    case "device_only":
      return "app.agentSetup.auth.deviceOnly";
    case "device_and_bootstrap":
      return "app.agentSetup.auth.deviceAndBootstrap";
    case "register_then_device":
      return "app.agentSetup.auth.registerThenDevice";
    case "register_and_keep_bootstrap":
      return "app.agentSetup.auth.registerAndKeepBootstrap";
    case "register_without_bootstrap":
      return "app.agentSetup.auth.registerWithoutBootstrap";
  }
}

function authPreviewDetailKey(kind: ReturnType<typeof buildAgentAuthPreview>["kind"]): string {
  switch (kind) {
    case "invalid_partial_device":
      return "app.agentSetup.authDetail.invalid";
    case "device_only":
      return "app.agentSetup.authDetail.deviceOnly";
    case "device_and_bootstrap":
      return "app.agentSetup.authDetail.deviceAndBootstrap";
    case "register_then_device":
      return "app.agentSetup.authDetail.registerThenDevice";
    case "register_and_keep_bootstrap":
      return "app.agentSetup.authDetail.registerAndKeepBootstrap";
    case "register_without_bootstrap":
      return "app.agentSetup.authDetail.registerWithoutBootstrap";
  }
}
