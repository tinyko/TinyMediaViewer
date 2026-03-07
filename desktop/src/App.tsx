import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type RuntimeStatus = "starting" | "running" | "stopped" | "error";
type ViewerAccessMode = "local" | "lan";
const BASIC_AUTH_USERNAME = "tmv";

type Settings = {
  homeDir: string;
  preferredViewerPort: number;
  launchAtLogin: boolean;
  startHidden: boolean;
  viewerAccessMode: ViewerAccessMode;
  lanPassword: string;
};

type Runtime = {
  status: RuntimeStatus;
  backendImplementation: string;
  viewerPort: number;
  apiPort: number;
  viewerUrl: string;
  viewerLocalUrl: string;
  lastError?: string;
};

type AppState = {
  settings: Settings;
  runtime: Runtime;
};

type PreviewDiagEvent = {
  ts: number;
  phase: "enqueue" | "request" | "response" | "apply" | "error" | "timeout";
  batchSize: number;
  paths: string[];
  status?: number;
  err?: string;
  requestId?: string;
};

type DiagnosticsState = {
  events: PreviewDiagEvent[];
  lastError?: string;
  lastSuccessfulApplyTs?: number;
  rootCause?: string;
};

const statusTextMap: Record<RuntimeStatus, string> = {
  starting: "启动中",
  running: "运行中",
  stopped: "已停止",
  error: "异常",
};

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsState | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formDirty, setFormDirty] = useState(false);
  const [form, setForm] = useState<Settings>({
    homeDir: "/Users/tiny/X",
    preferredViewerPort: 4300,
    launchAtLogin: true,
    startHidden: true,
    viewerAccessMode: "local",
    lanPassword: "",
  });

  const applyRemoteState = useCallback((next: AppState, nextDiagnostics: DiagnosticsState | null) => {
    setState(next);
    setDiagnostics(nextDiagnostics);
    if (!formDirty) {
      setForm(next.settings);
    }
  }, [formDirty]);

  const refreshState = useCallback(async () => {
    const [next, nextDiagnostics] = await Promise.all([
      invoke<AppState>("get_app_state"),
      invoke<DiagnosticsState>("get_diagnostics_state").catch(() => null),
    ]);
    applyRemoteState(next, nextDiagnostics);
  }, [applyRemoteState]);

  useEffect(() => {
    const init = async () => {
      try {
        setLoading(true);
        await refreshState();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        setError(`读取状态失败: ${detail}`);
      } finally {
        setLoading(false);
      }
    };

    init();

    const unlistenPromise = listen<AppState>("app-state-updated", (event) => {
      invoke<DiagnosticsState>("get_diagnostics_state")
        .then((payload) => applyRemoteState(event.payload, payload))
        .catch(() => {
          applyRemoteState(event.payload, null);
        });
    });

    const poll = window.setInterval(() => {
      refreshState().catch(() => {
        // Ignore polling errors. User-triggered actions surface concrete errors.
      });
    }, 3000);

    return () => {
      window.clearInterval(poll);
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {
        // no-op
      });
    };
  }, [refreshState]);

  const statusText = useMemo(() => {
    if (!state) return "未知";
    return statusTextMap[state.runtime.status] ?? state.runtime.status;
  }, [state]);
  const lanModeEnabled = form.viewerAccessMode === "lan";
  const lanPasswordTooShort = lanModeEnabled && form.lanPassword.trim().length < 8;
  const canSave = !saving && !lanPasswordTooShort;
  const pendingModeChanged = state ? form.viewerAccessMode !== state.settings.viewerAccessMode : false;
  const pendingViewerPortChanged = state
    ? form.preferredViewerPort !== state.settings.preferredViewerPort
    : false;

  const saveSettings = useCallback(async () => {
    try {
      setSaving(true);
      setError(null);
      setMessage(null);
      const next = await invoke<AppState>("save_settings", { input: form });
      setState(next);
      setForm(next.settings);
      setFormDirty(false);
      setMessage("设置已保存并重启服务");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(`保存失败: ${detail}`);
    } finally {
      setSaving(false);
    }
  }, [form]);

  const restartService = useCallback(async () => {
    try {
      setError(null);
      setMessage(null);
      const next = await invoke<AppState>("restart_services");
      setState(next);
      if (!formDirty) {
        setForm(next.settings);
      }
      setMessage("服务已重启");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(`重启失败: ${detail}`);
    }
  }, [formDirty]);

  const pickHomeDirectory = useCallback(async () => {
    try {
      setError(null);
      const picked = await invoke<string | null>("pick_home_directory");
      if (!picked) return;
      setFormDirty(true);
      setForm((prev) => ({ ...prev, homeDir: picked }));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(`选择目录失败: ${detail}`);
    }
  }, []);

  const openViewer = useCallback(async () => {
    try {
      setError(null);
      await invoke("open_viewer");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(`打开 Viewer 失败: ${detail}`);
    }
  }, []);

  const openDiagnosticsDir = useCallback(async () => {
    try {
      setError(null);
      await invoke("open_diagnostics_dir");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(`打开诊断目录失败: ${detail}`);
    }
  }, []);

  if (loading) {
    return <main className="container">加载中...</main>;
  }

  return (
    <main className="container">
      <header className="header">
        <div>
          <h1>TinyMediaViewer</h1>
          <p className="subtitle">菜单栏设置面板</p>
        </div>
        <span className={`status-badge status-${state?.runtime.status ?? "stopped"}`}>
          {statusText}
        </span>
      </header>

      <section className="panel">
        <div className="row">
          <label htmlFor="homeDir">home 目录</label>
          <div className="input-with-action">
            <input
              id="homeDir"
              value={form.homeDir}
              onChange={(event) => {
                setFormDirty(true);
                setForm((prev) => ({ ...prev, homeDir: event.target.value }));
              }}
              placeholder="/Users/tiny/X"
            />
            <button type="button" onClick={pickHomeDirectory}>
              浏览
            </button>
          </div>
        </div>

        <div className="row">
          <label htmlFor="preferredViewerPort">Viewer 端口</label>
          <input
            id="preferredViewerPort"
            type="number"
            min={1}
            max={65535}
            value={form.preferredViewerPort}
            onChange={(event) => {
              setFormDirty(true);
              setForm((prev) => ({
                ...prev,
                preferredViewerPort: Number(event.target.value || 0),
              }));
            }}
          />
        </div>

        <div className="row">
          <label>访问模式</label>
          <div className="network-mode-group">
            <label className={`mode-option ${form.viewerAccessMode === "local" ? "selected" : ""}`}>
              <input
                type="radio"
                name="viewerAccessMode"
                checked={form.viewerAccessMode === "local"}
                onChange={() => {
                  setFormDirty(true);
                  setForm((prev) => ({ ...prev, viewerAccessMode: "local" }));
                }}
              />
              <span>仅本机</span>
            </label>
            <label className={`mode-option ${form.viewerAccessMode === "lan" ? "selected" : ""}`}>
              <input
                type="radio"
                name="viewerAccessMode"
                checked={form.viewerAccessMode === "lan"}
                onChange={() => {
                  setFormDirty(true);
                  setForm((prev) => ({ ...prev, viewerAccessMode: "lan" }));
                }}
              />
              <span>局域网分享</span>
            </label>
          </div>
          <p className="hint">
            仅本机会绑定 <code>127.0.0.1</code>；局域网分享会开放 LAN 地址并启用 Basic
            Auth。运行状态区域显示的是已应用配置，不是未保存草稿。
          </p>
        </div>

        {lanModeEnabled ? (
          <div className="row">
            <label htmlFor="lanPassword">LAN 访问密码</label>
            <input
              id="lanPassword"
              type="password"
              autoComplete="new-password"
              value={form.lanPassword}
              onChange={(event) => {
                setFormDirty(true);
                setForm((prev) => ({ ...prev, lanPassword: event.target.value }));
              }}
              placeholder="至少 8 个字符"
            />
            <p className="hint">
              用户名固定为 <code>{BASIC_AUTH_USERNAME}</code>。
            </p>
            {lanPasswordTooShort ? (
              <p className="error">局域网分享需要至少 8 位密码，保存后才会切换运行状态。</p>
            ) : null}
          </div>
        ) : null}

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.launchAtLogin}
            onChange={(event) => {
              setFormDirty(true);
              setForm((prev) => ({ ...prev, launchAtLogin: event.target.checked }));
            }}
          />
          开机自动启动
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.startHidden}
            onChange={(event) => {
              setFormDirty(true);
              setForm((prev) => ({ ...prev, startHidden: event.target.checked }));
            }}
          />
          启动后隐藏到菜单栏
        </label>

        <div className="actions">
          <button type="button" onClick={saveSettings} disabled={!canSave}>
            {saving ? "保存中..." : "保存并应用"}
          </button>
          <button type="button" className="secondary" onClick={restartService} disabled={formDirty}>
            重启服务
          </button>
          <button type="button" className="secondary" onClick={openViewer}>
            打开 Viewer
          </button>
        </div>
        {formDirty ? (
          <p className="hint">
            当前表单有未保存改动。点击“保存并应用”后，下面的运行状态才会更新。
          </p>
        ) : null}
      </section>

      <section className="panel runtime">
        <h2>运行状态</h2>
        {formDirty ? (
          <p className="hint">
            已应用配置仍然是当前运行状态。
            {pendingModeChanged
              ? ` 待应用访问模式: ${form.viewerAccessMode === "lan" ? "局域网分享" : "仅本机"}。`
              : ""}
            {pendingViewerPortChanged ? ` 待应用 Viewer 端口: ${form.preferredViewerPort}。` : ""}
          </p>
        ) : null}
        <p>
          当前后端: <code>{state?.runtime.backendImplementation || "-"}</code>
        </p>
        <p>
          访问模式:{" "}
          <code>{state?.settings.viewerAccessMode === "lan" ? "局域网分享" : "仅本机"}</code>
        </p>
        <p>当前 Viewer 端口: {state?.runtime.viewerPort ?? "-"}</p>
        <p>当前 API 端口: {state?.runtime.apiPort ?? "-"}</p>
        <p>
          局域网 URL:{" "}
          {state?.runtime.viewerUrl ? <code>{state.runtime.viewerUrl}</code> : "未启用"}
        </p>
        <p>
          本机 URL:{" "}
          {state?.runtime.viewerLocalUrl ? <code>{state.runtime.viewerLocalUrl}</code> : "-"}
        </p>
        {state?.settings.viewerAccessMode === "lan" ? (
          <p>
            LAN 用户名: <code>{BASIC_AUTH_USERNAME}</code>
          </p>
        ) : null}
        <p>
          诊断事件: <code>{diagnostics?.events.length ?? 0}</code>
        </p>
        <p>
          根因归类: <code>{diagnostics?.rootCause ?? "-"}</code>
        </p>
        <p>
          最后成功回填:{" "}
          {diagnostics?.lastSuccessfulApplyTs ? (
            <code>{new Date(diagnostics.lastSuccessfulApplyTs).toLocaleString()}</code>
          ) : (
            "-"
          )}
        </p>
        {diagnostics?.lastError && <p className="error">诊断错误: {diagnostics.lastError}</p>}
        {state?.runtime.lastError && <p className="error">服务错误: {state.runtime.lastError}</p>}
        <div className="actions" style={{ marginTop: 8 }}>
          <button type="button" className="secondary" onClick={openDiagnosticsDir}>
            打开诊断目录
          </button>
        </div>
      </section>

      {message && <p className="message">{message}</p>}
      {error && <p className="error">{error}</p>}
    </main>
  );
}

export default App;
