import { useMemo, useState } from "react";
import type { SystemUsageAccount, SystemUsageReport } from "../../types";
import { formatDate } from "../../utils";
import "./system-usage.css";

interface SystemUsageModalProps {
  open: boolean;
  report: SystemUsageReport | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
}

const EMPTY_ITEMS: SystemUsageReport["items"] = [];

const formatBinaryBytes = (bytes: number) => {
  if (bytes === 0) return "0";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  if (unitIndex === 0) {
    return `${Math.round(value)} ${units[unitIndex]}`;
  }
  return `${value.toFixed(2)} ${units[unitIndex]}`;
};

const asPictureBytes = (item: SystemUsageAccount) => item.imageSize + item.gifSize;

export function SystemUsageModal({
  open,
  report,
  loading,
  error,
  onClose,
  onRefresh,
}: SystemUsageModalProps) {
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);

  const items = report?.items ?? EMPTY_ITEMS;
  const effectiveSelectedAccount = useMemo(() => {
    if (!items.length) return null;
    return items.some((item) => item.account === selectedAccount)
      ? selectedAccount
      : items[0].account;
  }, [items, selectedAccount]);
  const selected = useMemo(
    () => items.find((item) => item.account === effectiveSelectedAccount) ?? null,
    [effectiveSelectedAccount, items]
  );

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal system-usage-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="系统占用情况"
      >
        <button className="close-button" onClick={onClose} aria-label="关闭">
          ×
        </button>

        <div className="system-usage__header">
          <div className="system-usage__titleBlock">
            <h2>系统占用情况</h2>
            <p>
              {report
                ? `${report.rootPath} · ${formatDate(report.generatedAt)}`
                : "按默认媒体根目录统计前十账号占用"}
            </p>
          </div>
          <div className="system-usage__actions">
            <button className="ghost-button" type="button" onClick={onRefresh} disabled={loading}>
              {loading ? "统计中..." : "重新统计"}
            </button>
          </div>
        </div>

        <div className="system-usage__body">
          <div className="system-usage__tablePanel">
            <div className="system-usage__tableWrap">
              <table className="system-usage-table">
                <thead>
                  <tr>
                    <th>账号</th>
                    <th>总占用</th>
                    <th>图片占用</th>
                    <th>视频占用</th>
                    <th>其它</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => {
                    const active = selected?.account === item.account;
                    return (
                      <tr
                        key={item.account}
                        className={active ? "is-active" : ""}
                        onClick={() => setSelectedAccount(item.account)}
                      >
                        <td>
                          <span className="system-usage-chip">{item.account}</span>
                        </td>
                        <td>
                          <span className="system-usage-badge">
                            {formatBinaryBytes(item.totalSize)}
                          </span>
                        </td>
                        <td>
                          <span className="system-usage-badge">
                            {formatBinaryBytes(asPictureBytes(item))}
                          </span>
                        </td>
                        <td>
                          <span className="system-usage-badge">
                            {formatBinaryBytes(item.videoSize)}
                          </span>
                        </td>
                        <td>
                          <span className="system-usage-badge">
                            {formatBinaryBytes(item.otherSize)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {!loading && !error && !items.length && (
                <div className="system-usage__state">没有可展示的账号占用数据</div>
              )}
              {loading && <div className="system-usage__state">正在扫描默认媒体根目录...</div>}
              {!loading && error && <div className="system-usage__state error">{error}</div>}
            </div>
          </div>

          <div className="system-usage__detailPanel">
            {selected ? (
              <>
                <div className="system-usage__detailHeader">
                  <h3>{selected.account}</h3>
                  <span className="system-usage-badge strong">
                    {formatBinaryBytes(selected.totalSize)}
                  </span>
                </div>
                <div className="system-usage__stats">
                  <div className="system-usage__statCard">
                    <span>图片</span>
                    <strong>{formatBinaryBytes(asPictureBytes(selected))}</strong>
                  </div>
                  <div className="system-usage__statCard">
                    <span>视频</span>
                    <strong>{formatBinaryBytes(selected.videoSize)}</strong>
                  </div>
                  <div className="system-usage__statCard">
                    <span>其它</span>
                    <strong>{formatBinaryBytes(selected.otherSize)}</strong>
                  </div>
                  {selected.gifSize > 0 && (
                    <div className="system-usage__statCard">
                      <span>其中 GIF</span>
                      <strong>{formatBinaryBytes(selected.gifSize)}</strong>
                    </div>
                  )}
                </div>
                <div className="system-usage__fileSection">
                  <h4>最大文件 Top 5</h4>
                  <ol className="system-usage__fileList">
                    {selected.topFiles.map((file) => (
                      <li key={`${selected.account}:${file.path}`} className="system-usage__fileRow">
                        <span className="system-usage__filePath">{file.path}</span>
                        <span className="system-usage-badge">
                          {formatBinaryBytes(file.size)}
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              </>
            ) : (
              <div className="system-usage__state">选择一行账号后，这里会显示前 5 大文件</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
