use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::Command,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_EVENTS: usize = 200;
const EVENTS_FILENAME: &str = "preview-events.jsonl";
const PERF_EVENTS_FILENAME: &str = "perf-events.jsonl";
const GATEWAY_LOG_FILENAME: &str = "gateway.log";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PreviewDiagPhase {
    Enqueue,
    Request,
    Response,
    Apply,
    Error,
    Timeout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewDiagEvent {
    pub ts: u64,
    pub phase: PreviewDiagPhase,
    pub batch_size: usize,
    pub paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub err: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsState {
    pub events: Vec<PreviewDiagEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_successful_apply_ts: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_cause: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PerfDiagEvent {
    pub ts: u64,
    pub fps_estimate: f64,
    pub long_task_count10s: u32,
    pub visible_cards: u32,
    pub effects_mode: String,
    pub renderer: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug)]
struct DiagnosticsInner {
    events: VecDeque<PreviewDiagEvent>,
    last_error: Option<String>,
    last_successful_apply_ts: Option<u64>,
}

pub struct DiagnosticsStore {
    dir: PathBuf,
    events_path: PathBuf,
    perf_events_path: PathBuf,
    gateway_log_path: PathBuf,
    inner: Mutex<DiagnosticsInner>,
}

impl DiagnosticsStore {
    pub fn new(dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&dir).map_err(|error| {
            format!(
                "Failed to create diagnostics dir {}: {error}",
                dir.display()
            )
        })?;

        let events_path = dir.join(EVENTS_FILENAME);
        let perf_events_path = dir.join(PERF_EVENTS_FILENAME);
        let gateway_log_path = dir.join(GATEWAY_LOG_FILENAME);
        let (events, last_error, last_successful_apply_ts) = load_recent_events(&events_path);

        Ok(Self {
            dir,
            events_path,
            perf_events_path,
            gateway_log_path,
            inner: Mutex::new(DiagnosticsInner {
                events,
                last_error,
                last_successful_apply_ts,
            }),
        })
    }

    pub fn diagnostics_dir(&self) -> PathBuf {
        self.dir.clone()
    }

    pub fn state(&self) -> DiagnosticsState {
        let (events, last_error, last_successful_apply_ts) = load_recent_events(&self.events_path);
        {
            let mut inner = self.inner.lock().expect("diagnostics mutex poisoned");
            inner.events = events.clone();
            inner.last_error = last_error.clone();
            inner.last_successful_apply_ts = last_successful_apply_ts;
        }

        let events = events.into_iter().collect::<Vec<_>>();
        DiagnosticsState {
            root_cause: classify_root_cause(&events),
            events,
            last_error,
            last_successful_apply_ts,
        }
    }

    pub fn record_preview_events(&self, mut events: Vec<PreviewDiagEvent>) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }

        for event in &mut events {
            event.paths = event
                .paths
                .iter()
                .map(|path| path.trim())
                .filter(|path| !path.is_empty())
                .map(ToString::to_string)
                .collect();
            if event.ts == 0 {
                event.ts = now_ms();
            }
        }

        {
            let mut inner = self.inner.lock().expect("diagnostics mutex poisoned");
            for event in &events {
                inner.events.push_back(event.clone());
                if inner.events.len() > MAX_EVENTS {
                    let _ = inner.events.pop_front();
                }

                match event.phase {
                    PreviewDiagPhase::Apply => {
                        inner.last_successful_apply_ts = Some(event.ts);
                        inner.last_error = None;
                    }
                    PreviewDiagPhase::Error | PreviewDiagPhase::Timeout => {
                        if let Some(message) = event.err.clone() {
                            inner.last_error = Some(message);
                        }
                    }
                    _ => {}
                }
            }
        }

        append_jsonl(&self.events_path, &events)
    }

    pub fn record_perf_events(&self, mut events: Vec<PerfDiagEvent>) -> Result<(), String> {
        if events.is_empty() {
            return Ok(());
        }

        for event in &mut events {
            if event.ts == 0 {
                event.ts = now_ms();
            }

            event.effects_mode = event.effects_mode.trim().to_string();
            event.renderer = event.renderer.trim().to_string();
            if let Some(note) = event.note.as_mut() {
                *note = note.trim().to_string();
                if note.is_empty() {
                    event.note = None;
                }
            }
        }

        append_perf_jsonl(&self.perf_events_path, &events)
    }

    pub fn log_gateway_request(
        &self,
        trace_id: &str,
        method: &str,
        route: &str,
        path: &str,
        status: u16,
        upstream_status: Option<u16>,
        duration_ms: u128,
        error: Option<&str>,
    ) -> Result<(), String> {
        let ts = now_ms();
        let upstream = upstream_status
            .map(|value| value.to_string())
            .unwrap_or_else(|| "-".to_string());
        let line = format!(
            "{ts}\ttrace={trace_id}\tmethod={method}\troute={route}\tstatus={status}\tupstream={upstream}\tdurationMs={duration_ms}\tpath={path}\terror={}\n",
            error.unwrap_or("-")
        );
        append_text_line(&self.gateway_log_path, &line)
    }

    pub fn open_in_finder(&self) -> Result<(), String> {
        Command::new("open")
            .arg(&self.dir)
            .spawn()
            .map_err(|error| {
                format!(
                    "Failed to open diagnostics dir {}: {error}",
                    self.dir.display()
                )
            })?;
        Ok(())
    }
}

fn load_recent_events(path: &PathBuf) -> (VecDeque<PreviewDiagEvent>, Option<String>, Option<u64>) {
    let mut events = VecDeque::new();
    let mut last_error = None;
    let mut last_successful_apply_ts = None;

    let file = match File::open(path) {
        Ok(file) => file,
        Err(_) => return (events, last_error, last_successful_apply_ts),
    };

    let reader = BufReader::new(file);
    for line in reader.lines().map_while(Result::ok) {
        let parsed = serde_json::from_str::<PreviewDiagEvent>(&line);
        if let Ok(event) = parsed {
            match event.phase {
                PreviewDiagPhase::Apply => {
                    last_successful_apply_ts = Some(event.ts);
                    last_error = None;
                }
                PreviewDiagPhase::Error | PreviewDiagPhase::Timeout => {
                    if let Some(message) = event.err.clone() {
                        last_error = Some(message);
                    }
                }
                _ => {}
            }

            events.push_back(event);
            if events.len() > MAX_EVENTS {
                let _ = events.pop_front();
            }
        }
    }

    (events, last_error, last_successful_apply_ts)
}

fn append_jsonl(path: &PathBuf, events: &[PreviewDiagEvent]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            format!(
                "Failed to open diagnostics file {}: {error}",
                path.display()
            )
        })?;

    for event in events {
        let line = serde_json::to_string(event)
            .map_err(|error| format!("Failed serializing diagnostics event: {error}"))?;
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|error| {
                format!(
                    "Failed writing diagnostics file {}: {error}",
                    path.display()
                )
            })?;
    }

    Ok(())
}

fn append_perf_jsonl(path: &PathBuf, events: &[PerfDiagEvent]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| {
            format!(
                "Failed to open diagnostics file {}: {error}",
                path.display()
            )
        })?;

    for event in events {
        let line = serde_json::to_string(event)
            .map_err(|error| format!("Failed serializing perf diagnostics event: {error}"))?;
        file.write_all(line.as_bytes())
            .and_then(|_| file.write_all(b"\n"))
            .map_err(|error| {
                format!(
                    "Failed writing diagnostics file {}: {error}",
                    path.display()
                )
            })?;
    }

    Ok(())
}

fn append_text_line(path: &PathBuf, line: &str) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("Failed to open gateway log {}: {error}", path.display()))?;

    file.write_all(line.as_bytes())
        .map_err(|error| format!("Failed writing gateway log {}: {error}", path.display()))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn classify_root_cause(events: &[PreviewDiagEvent]) -> Option<String> {
    if events.is_empty() {
        return None;
    }

    let now = now_ms();
    let mut requests: HashMap<String, u64> = HashMap::new();
    let mut responses: HashMap<String, (u64, Option<u16>, usize)> = HashMap::new();
    let mut applies: HashMap<String, u64> = HashMap::new();
    let mut terminals: HashMap<String, u64> = HashMap::new();
    let mut enqueues: HashMap<String, u64> = HashMap::new();

    for event in events {
        let Some(request_id) = event.request_id.clone() else {
            continue;
        };

        match event.phase {
            PreviewDiagPhase::Enqueue => {
                enqueues.insert(request_id, event.ts);
            }
            PreviewDiagPhase::Request => {
                requests.insert(request_id, event.ts);
            }
            PreviewDiagPhase::Response => {
                responses.insert(
                    request_id.clone(),
                    (event.ts, event.status, event.batch_size),
                );
                terminals.insert(request_id, event.ts);
            }
            PreviewDiagPhase::Apply => {
                applies.insert(request_id.clone(), event.ts);
                terminals.insert(request_id, event.ts);
            }
            PreviewDiagPhase::Error | PreviewDiagPhase::Timeout => {
                terminals.insert(request_id, event.ts);
            }
        }
    }

    // Rule 1: enqueue exists but no request in 2s.
    if enqueues.iter().any(|(request_id, enqueue_ts)| {
        now.saturating_sub(*enqueue_ts) > 2_000 && !requests.contains_key(request_id)
    }) {
        return Some("frontend-trigger-chain-failure".to_string());
    }

    // Rule 2: request exists but no response/error/timeout in 2s.
    if requests.iter().any(|(request_id, request_ts)| {
        now.saturating_sub(*request_ts) > 2_000 && !terminals.contains_key(request_id)
    }) {
        return Some("gateway-or-network-blocking".to_string());
    }

    // Rule 4: response 4xx/5xx.
    if responses
        .values()
        .any(|(_, status, _)| status.map(|code| code >= 400).unwrap_or(false))
    {
        return Some("backend-preview-batch-error".to_string());
    }

    // Rule 3: response 200 and items>0 but apply missing.
    if responses
        .iter()
        .any(|(request_id, (response_ts, status, item_count))| {
            status == &Some(200)
                && *item_count > 0
                && now.saturating_sub(*response_ts) > 2_000
                && !applies.contains_key(request_id)
        })
    {
        return Some("state-apply-failure".to_string());
    }

    None
}
