import type { FolderPreview, MediaItem } from "../types";
import { formatDate } from "../utils";

interface Props {
  data: FolderPreview;
  onOpen: (path: string) => void;
  onPreview: (item: MediaItem) => void;
  onPeek: (path: string) => void;
}

const renderPreview = (item: MediaItem, onPreview: (item: MediaItem) => void) => {
  if (item.kind === "video") {
    return (
      <button
        className="media-thumb video"
        onClick={(event) => {
          event.stopPropagation();
          onPreview(item);
        }}
        title={item.name}
      >
        <video muted playsInline preload="metadata">
          <source src={item.url} />
        </video>
      </button>
    );
  }

  return (
    <button
      className="media-thumb"
      onClick={(event) => {
        event.stopPropagation();
        onPreview(item);
      }}
      title={item.name}
    >
      <img src={item.url} alt={item.name} loading="lazy" />
    </button>
  );
};

export function FolderCard({ data, onOpen, onPreview, onPeek }: Props) {
  return (
    <article className="folder-card" onClick={() => onOpen(data.path)}>
      <header className="folder-card__header">
        <div>
          <p className="eyebrow">目录</p>
          <h3>{data.name}</h3>
          <p className="muted">{data.path || "根目录"}</p>
        </div>
        <div className="folder-card__actions">
          <button
            className="ghost-button"
            onClick={(event) => {
              event.stopPropagation();
              onPeek(data.path);
            }}
          >
            快速预览
          </button>
          <button
            className="primary-button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen(data.path);
            }}
          >
            进入
          </button>
        </div>
      </header>

      <div className="folder-card__stats">
        <span>📷 {data.counts.images + data.counts.gifs} 图像</span>
        <span>🎞️ {data.counts.videos} 视频</span>
        <span>📂 {data.counts.subfolders} 子目录</span>
      </div>

      <div className="folder-card__previews">
        {data.previews.length ? (
          data.previews.map((item) => (
            <div key={item.path} className="thumb-wrapper">
              {renderPreview(item, onPreview)}
              <p className="thumb-name">{item.name}</p>
            </div>
          ))
        ) : (
          <div className="empty-preview">暂无媒体预览</div>
        )}
      </div>

      <footer className="folder-card__footer">
        <span className="muted">更新于 {formatDate(data.modified)}</span>
      </footer>
    </article>
  );
}
