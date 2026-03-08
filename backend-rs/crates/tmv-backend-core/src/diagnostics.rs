use crate::{FolderPreviewBatchError, PerfDiagEvent, PreviewDiagEvent};
use anyhow::{Context, Result};
use serde::Serialize;
use std::{path::PathBuf, sync::Arc};
use tokio::fs;

#[derive(Clone)]
pub struct DiagnosticsWriter {
    dir: Arc<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewBatchSummary<'a> {
    pub(crate) ts: u64,
    pub(crate) request_path_count: usize,
    pub(crate) success_count: usize,
    pub(crate) failed_count: usize,
    pub(crate) duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) slowest_path: Option<&'a str>,
    pub(crate) slowest_ms: u64,
    pub(crate) failures: &'a [FolderPreviewBatchError],
}

impl DiagnosticsWriter {
    pub async fn new(dir: PathBuf) -> Result<Self> {
        fs::create_dir_all(&dir)
            .await
            .with_context(|| format!("create diagnostics dir {}", dir.display()))?;
        Ok(Self { dir: Arc::new(dir) })
    }

    pub async fn record_preview_events(&self, events: Vec<PreviewDiagEvent>) -> Result<()> {
        self.append_jsonl("preview-events.jsonl", events).await
    }

    pub async fn record_perf_events(&self, events: Vec<PerfDiagEvent>) -> Result<()> {
        self.append_jsonl("perf-events.jsonl", events).await
    }

    pub async fn record_gateway_line(&self, line: String) -> Result<()> {
        let path = self.dir.join("gateway.log");
        use tokio::io::AsyncWriteExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .with_context(|| format!("open {}", path.display()))?;
        file.write_all(line.as_bytes()).await?;
        Ok(())
    }

    pub(crate) async fn record_preview_batch_summary<'a>(
        &self,
        summary: PreviewBatchSummary<'a>,
    ) -> Result<()> {
        self.append_jsonl("server-previews.log", vec![summary])
            .await
    }

    async fn append_jsonl<T: Serialize>(&self, filename: &str, items: Vec<T>) -> Result<()> {
        if items.is_empty() {
            return Ok(());
        }
        let path = self.dir.join(filename);
        use tokio::io::AsyncWriteExt;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .with_context(|| format!("open {}", path.display()))?;
        for item in items {
            let line = serde_json::to_string(&item)?;
            file.write_all(line.as_bytes()).await?;
            file.write_all(b"\n").await?;
        }
        Ok(())
    }
}
