use super::{
    detect_media_kind_from_path, BackendService, MediaKind, SystemUsageAccount, SystemUsageFile,
    SystemUsageReport,
};
use anyhow::{anyhow, Context, Result};
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
};
use tokio::sync::{Mutex as AsyncMutex, Notify};

#[derive(Debug, Clone)]
struct SystemUsageSnapshot {
    root_generation: u64,
    refresh_id: u64,
    report: SystemUsageReport,
}

#[derive(Debug, Clone)]
struct SystemUsageFailure {
    refresh_id: u64,
    message: String,
}

#[derive(Debug, Default)]
struct SystemUsageRuntimeState {
    snapshot: Option<SystemUsageSnapshot>,
    last_failure: Option<SystemUsageFailure>,
    requested_generation: Option<u64>,
    requested_refresh_id: Option<u64>,
    requested_force: bool,
    in_progress_generation: Option<u64>,
    in_progress_refresh_id: Option<u64>,
    completed_refresh_id: u64,
}

#[derive(Debug, Default)]
pub(crate) struct SystemUsageRuntime {
    state: AsyncMutex<SystemUsageRuntimeState>,
    worker_notify: Notify,
    waiter_notify: Notify,
    #[cfg(test)]
    scan_started_notify: Notify,
    #[cfg(test)]
    scan_gate: AsyncMutex<Option<Arc<Notify>>>,
}

impl SystemUsageRuntime {
    pub(crate) fn spawn_worker(self: Arc<Self>, service: BackendService) {
        tokio::spawn(async move {
            loop {
                self.worker_notify.notified().await;
                while let Some((root_generation, refresh_id)) = self.begin_refresh().await {
                    #[cfg(test)]
                    self.before_refresh_scan(refresh_id).await;
                    let root_path = service.config.media_root.clone();
                    let result = tokio::task::spawn_blocking(move || {
                        build_full_system_usage_report(&root_path)
                    })
                    .await
                    .map_err(|error| anyhow!("join system usage scan task: {error}"))
                    .and_then(|result| result);
                    self.finish_refresh(root_generation, refresh_id, result)
                        .await;
                }
            }
        });
    }

    pub(crate) async fn request_refresh(&self, root_generation: u64, force: bool) -> u64 {
        let mut state = self.state.lock().await;
        if let Some(snapshot) = state.snapshot.as_ref() {
            if snapshot.root_generation == root_generation && !force {
                return snapshot.refresh_id;
            }
        }

        if let (Some(requested_generation), Some(requested_refresh_id)) =
            (state.requested_generation, state.requested_refresh_id)
        {
            if requested_generation >= root_generation {
                if force {
                    state.requested_force = true;
                }
                return requested_refresh_id;
            }
        }

        if let (Some(in_progress_generation), Some(in_progress_refresh_id)) =
            (state.in_progress_generation, state.in_progress_refresh_id)
        {
            if in_progress_generation >= root_generation {
                return in_progress_refresh_id;
            }
        }

        let refresh_id = if let Some(requested_refresh_id) = state.requested_refresh_id {
            state.requested_generation = Some(
                state
                    .requested_generation
                    .map_or(root_generation, |current| current.max(root_generation)),
            );
            state.requested_force |= force;
            requested_refresh_id
        } else {
            let next_refresh_id = Self::next_refresh_id(&state);
            state.requested_generation = Some(root_generation);
            state.requested_refresh_id = Some(next_refresh_id);
            state.requested_force = force;
            next_refresh_id
        };
        drop(state);
        self.worker_notify.notify_one();
        refresh_id
    }

    pub(crate) async fn wait_for_report(
        &self,
        minimum_refresh_id: u64,
        limit: usize,
    ) -> Result<SystemUsageReport> {
        loop {
            let notified = self.waiter_notify.notified();
            {
                let state = self.state.lock().await;
                let snapshot = state
                    .snapshot
                    .as_ref()
                    .filter(|snapshot| snapshot.refresh_id >= minimum_refresh_id);
                let failure = state
                    .last_failure
                    .as_ref()
                    .filter(|failure| failure.refresh_id >= minimum_refresh_id);

                match (snapshot, failure) {
                    (Some(snapshot), Some(failure))
                        if snapshot.refresh_id >= failure.refresh_id =>
                    {
                        return Ok(truncate_system_usage_report(&snapshot.report, limit));
                    }
                    (Some(_), Some(failure)) => {
                        return Err(anyhow!(failure.message.clone()));
                    }
                    (Some(snapshot), None) => {
                        return Ok(truncate_system_usage_report(&snapshot.report, limit));
                    }
                    (None, Some(failure)) => {
                        return Err(anyhow!(failure.message.clone()));
                    }
                    (None, None) => {}
                }
            }
            notified.await;
        }
    }

    async fn begin_refresh(&self) -> Option<(u64, u64)> {
        let mut state = self.state.lock().await;
        loop {
            if state.in_progress_generation.is_some() {
                return None;
            }

            let root_generation = state.requested_generation?;
            let refresh_id = state
                .requested_refresh_id
                .expect("requested refresh id must exist when generation is queued");
            let force = state.requested_force;
            let already_current = state
                .snapshot
                .as_ref()
                .is_some_and(|snapshot| snapshot.root_generation == root_generation);
            if already_current && !force {
                state.requested_generation = None;
                state.requested_refresh_id = None;
                state.requested_force = false;
                continue;
            }

            state.requested_generation = None;
            state.requested_refresh_id = None;
            state.requested_force = false;
            state.in_progress_generation = Some(root_generation);
            state.in_progress_refresh_id = Some(refresh_id);
            return Some((root_generation, refresh_id));
        }
    }

    async fn finish_refresh(
        &self,
        root_generation: u64,
        refresh_id: u64,
        result: Result<SystemUsageReport>,
    ) {
        let should_continue = {
            let mut state = self.state.lock().await;
            state.in_progress_generation = None;
            state.in_progress_refresh_id = None;
            let superseded = state
                .requested_generation
                .is_some_and(|requested| requested > root_generation);
            if superseded {
                true
            } else {
                state.completed_refresh_id = state.completed_refresh_id.max(refresh_id);

                match result {
                    Ok(report) => {
                        state.snapshot = Some(SystemUsageSnapshot {
                            root_generation,
                            refresh_id,
                            report,
                        });
                        state.last_failure = None;
                    }
                    Err(error) => {
                        state.last_failure = Some(SystemUsageFailure {
                            refresh_id,
                            message: error.to_string(),
                        });
                    }
                }

                state.requested_generation.is_some()
            }
        };

        self.waiter_notify.notify_waiters();
        if should_continue {
            self.worker_notify.notify_one();
        }
    }

    #[cfg(test)]
    pub(crate) async fn current_refresh_id(&self) -> u64 {
        self.state.lock().await.completed_refresh_id
    }

    fn next_refresh_id(state: &SystemUsageRuntimeState) -> u64 {
        [
            state.completed_refresh_id,
            state.requested_refresh_id.unwrap_or(0),
            state.in_progress_refresh_id.unwrap_or(0),
        ]
        .into_iter()
        .max()
        .unwrap_or(0)
            + 1
    }

    #[cfg(test)]
    async fn before_refresh_scan(&self, refresh_id: u64) {
        self.scan_started_notify.notify_waiters();
        let gate = { self.scan_gate.lock().await.clone() };
        if let Some(gate) = gate {
            let _ = refresh_id;
            gate.notified().await;
        }
    }

    #[cfg(test)]
    pub(crate) async fn install_scan_gate(&self, gate: Arc<Notify>) {
        *self.scan_gate.lock().await = Some(gate);
    }

    #[cfg(test)]
    pub(crate) async fn clear_scan_gate(&self) {
        *self.scan_gate.lock().await = None;
    }

    #[cfg(test)]
    pub(crate) async fn wait_for_refresh_start(&self, refresh_id: u64) {
        loop {
            let notified = self.scan_started_notify.notified();
            {
                let state = self.state.lock().await;
                if state.in_progress_refresh_id == Some(refresh_id) {
                    return;
                }
            }
            notified.await;
        }
    }
}

impl BackendService {
    pub async fn get_system_usage_report(
        &self,
        limit: usize,
        bypass_cache: bool,
    ) -> Result<SystemUsageReport> {
        let max_items = limit.max(1);
        let root_generation = self.runtime.generation("");
        let minimum_refresh_id = self
            .system_usage_runtime
            .request_refresh(root_generation, bypass_cache)
            .await;
        self.system_usage_runtime
            .wait_for_report(minimum_refresh_id, max_items)
            .await
    }
}

fn truncate_system_usage_report(report: &SystemUsageReport, limit: usize) -> SystemUsageReport {
    let max_items = limit.max(1);
    let mut truncated = report.clone();
    truncated.items.truncate(max_items);
    truncated
}

pub(crate) fn build_full_system_usage_report(root: &Path) -> Result<SystemUsageReport> {
    let mut account_entries = Vec::new();
    for entry in
        std::fs::read_dir(root).with_context(|| format!("read media root {}", root.display()))?
    {
        let entry = entry.with_context(|| format!("read media root entry {}", root.display()))?;
        let file_name = entry.file_name();
        let account = file_name.to_string_lossy().into_owned();
        if account.starts_with('.') {
            continue;
        }

        let file_type = entry
            .file_type()
            .with_context(|| format!("read file type for {}", entry.path().display()))?;
        if !file_type.is_dir() {
            continue;
        }

        account_entries.push((account, entry.path()));
    }

    let items = scan_system_usage_accounts(account_entries)?;
    Ok(SystemUsageReport {
        root_path: root.display().to_string(),
        generated_at: super::now_ms_u64(),
        items,
    })
}

fn scan_system_usage_accounts(entries: Vec<(String, PathBuf)>) -> Result<Vec<SystemUsageAccount>> {
    if entries.is_empty() {
        return Ok(Vec::new());
    }

    let worker_count = thread::available_parallelism()
        .map(|value| value.get())
        .unwrap_or(2)
        .min(entries.len())
        .clamp(1, 8);
    let queue = Arc::new(Mutex::new(VecDeque::from(entries)));
    let results = Arc::new(Mutex::new(Vec::<SystemUsageAccount>::new()));
    let failure = Arc::new(Mutex::new(None::<String>));

    thread::scope(|scope| {
        for _ in 0..worker_count {
            let queue = Arc::clone(&queue);
            let results = Arc::clone(&results);
            let failure = Arc::clone(&failure);
            scope.spawn(move || loop {
                if failure
                    .lock()
                    .expect("system usage failure poisoned")
                    .is_some()
                {
                    return;
                }

                let next_entry = queue
                    .lock()
                    .expect("system usage queue poisoned")
                    .pop_front();
                let Some((account, path)) = next_entry else {
                    return;
                };

                match scan_system_usage_account(&account, &path) {
                    Ok(item) => results
                        .lock()
                        .expect("system usage results poisoned")
                        .push(item),
                    Err(error) => {
                        let mut slot = failure.lock().expect("system usage failure poisoned");
                        if slot.is_none() {
                            *slot = Some(error.to_string());
                        }
                        return;
                    }
                }
            });
        }
    });

    if let Some(error) = failure
        .lock()
        .expect("system usage failure poisoned")
        .clone()
    {
        return Err(anyhow!(error));
    }

    let mut items = results
        .lock()
        .expect("system usage results poisoned")
        .clone();
    items.sort_by(|left, right| {
        right
            .total_size
            .cmp(&left.total_size)
            .then_with(|| left.account.cmp(&right.account))
    });
    Ok(items)
}

fn scan_system_usage_account(account: &str, root: &Path) -> Result<SystemUsageAccount> {
    let mut total_size = 0_u64;
    let mut image_size = 0_u64;
    let mut gif_size = 0_u64;
    let mut video_size = 0_u64;
    let mut other_size = 0_u64;
    let mut top_files = Vec::new();
    let mut pending = vec![root.to_path_buf()];

    while let Some(current) = pending.pop() {
        for entry in std::fs::read_dir(&current)
            .with_context(|| format!("read account directory {}", current.display()))?
        {
            let entry =
                entry.with_context(|| format!("read directory entry {}", current.display()))?;
            let file_name = entry.file_name();
            let name = file_name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }

            let path = entry.path();
            let file_type = entry
                .file_type()
                .with_context(|| format!("read file type for {}", path.display()))?;
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }

            let metadata = entry
                .metadata()
                .with_context(|| format!("read metadata for {}", path.display()))?;
            let size = metadata.len();
            total_size = total_size.saturating_add(size);
            match detect_media_kind_from_path(&path) {
                Some(MediaKind::Image) => image_size = image_size.saturating_add(size),
                Some(MediaKind::Gif) => gif_size = gif_size.saturating_add(size),
                Some(MediaKind::Video) => video_size = video_size.saturating_add(size),
                None => other_size = other_size.saturating_add(size),
            }

            let relative_path = path
                .strip_prefix(root)
                .unwrap_or(path.as_path())
                .to_string_lossy()
                .replace('\\', "/");
            remember_system_usage_top_file(&mut top_files, relative_path, size);
        }
    }

    Ok(SystemUsageAccount {
        account: account.to_string(),
        total_size,
        image_size,
        gif_size,
        video_size,
        other_size,
        top_files,
    })
}

fn remember_system_usage_top_file(top_files: &mut Vec<SystemUsageFile>, path: String, size: u64) {
    top_files.push(SystemUsageFile { path, size });
    top_files.sort_by(|left, right| {
        right
            .size
            .cmp(&left.size)
            .then_with(|| left.path.cmp(&right.path))
    });
    if top_files.len() > 5 {
        top_files.truncate(5);
    }
}

#[cfg(test)]
pub(crate) async fn wait_for_system_usage_refresh(service: &BackendService, refresh_id: u64) {
    loop {
        if service.system_usage_runtime.current_refresh_id().await >= refresh_id {
            return;
        }
        tokio::task::yield_now().await;
    }
}
