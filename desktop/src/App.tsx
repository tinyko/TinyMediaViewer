import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";

type RuntimeStatus = "starting" | "running" | "stopped" | "error";

type Settings = {
  homeDir: string;
  preferredViewerPort: number;
  launchAtLogin: boolean;
  startHidden: boolean;
};

type Runtime = {
  status: RuntimeStatus;
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

const statusTextMap: Record<RuntimeStatus, string> = {
  starting: "启动中",
  running: "运行中",
  stopped: "已停止",
  error: "异常",
};

function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<Settings>({
    homeDir: "/Users/tiny/X",
    preferredViewerPort: 4300,
    launchAtLogin: true,
    startHidden: true,
  });

  const refreshState = useCallback(async () => {
    const next = await invoke<AppState>("get_app_state");
    setState(next);
    setForm(next.settings);
  }, []);

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
      setState(event.payload);
      setForm(event.payload.settings);
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

  const saveSettings = useCallback(async () => {
    try {
      setSaving(true);
      setError(null);
      setMessage(null);
      const next = await invoke<AppState>("save_settings", { input: form });
      setState(next);
      setForm(next.settings);
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
      setForm(next.settings);
      setMessage("服务已重启");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setError(`重启失败: ${detail}`);
    }
  }, []);

  const pickHomeDirectory = useCallback(async () => {
    try {
      setError(null);
      const picked = await invoke<string | null>("pick_home_directory");
      if (!picked) return;
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
              onChange={(event) =>
                setForm((prev) => ({ ...prev, homeDir: event.target.value }))
              }
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
            onChange={(event) =>
              setForm((prev) => ({
                ...prev,
                preferredViewerPort: Number(event.target.value || 0),
              }))
            }
          />
        </div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.launchAtLogin}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, launchAtLogin: event.target.checked }))
            }
          />
          开机自动启动
        </label>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={form.startHidden}
            onChange={(event) =>
              setForm((prev) => ({ ...prev, startHidden: event.target.checked }))
            }
          />
          启动后隐藏到菜单栏
        </label>

        <div className="actions">
          <button type="button" onClick={saveSettings} disabled={saving}>
            {saving ? "保存中..." : "保存并应用"}
          </button>
          <button type="button" className="secondary" onClick={restartService}>
            重启服务
          </button>
          <button type="button" className="secondary" onClick={openViewer}>
            打开 Viewer
          </button>
        </div>
      </section>

      <section className="panel runtime">
        <h2>运行状态</h2>
        <p>当前 Viewer 端口: {state?.runtime.viewerPort ?? "-"}</p>
        <p>当前 API 端口: {state?.runtime.apiPort ?? "-"}</p>
        <p>
          局域网 URL: {state?.runtime.viewerUrl ? <code>{state.runtime.viewerUrl}</code> : "-"}
        </p>
        <p>
          本机 URL:{" "}
          {state?.runtime.viewerLocalUrl ? <code>{state.runtime.viewerLocalUrl}</code> : "-"}
        </p>
        {state?.runtime.lastError && <p className="error">服务错误: {state.runtime.lastError}</p>}
      </section>

      {message && <p className="message">{message}</p>}
      {error && <p className="error">{error}</p>}
    </main>
  );
}

export default App;
