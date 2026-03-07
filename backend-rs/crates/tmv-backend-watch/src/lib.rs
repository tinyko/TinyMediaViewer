use anyhow::{Context, Result};
use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tracing::warn;

type InvalidateFn = Arc<dyn Fn(Vec<String>) + Send + Sync + 'static>;

pub struct WatchRegistry {
    watcher: Mutex<RecommendedWatcher>,
    owners_by_dir: Arc<Mutex<HashMap<PathBuf, HashSet<String>>>>,
}

impl WatchRegistry {
    pub fn new(on_invalidate: InvalidateFn) -> Result<Self> {
        let owners_by_dir = Arc::new(Mutex::new(HashMap::<PathBuf, HashSet<String>>::new()));
        let owners_for_callback = owners_by_dir.clone();
        let watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| match result {
                Ok(event) => {
                    let owners = collect_owners(&owners_for_callback, &event.paths);
                    if !owners.is_empty() {
                        on_invalidate(owners);
                    }
                }
                Err(error) => warn!("watch error: {error}"),
            },
            Config::default(),
        )
        .context("create file watcher")?;

        Ok(Self {
            watcher: Mutex::new(watcher),
            owners_by_dir,
        })
    }

    pub fn watch_directory(&self, directory: impl AsRef<Path>, owner_key: impl Into<String>) {
        let directory = directory.as_ref().to_path_buf();
        let owner_key = owner_key.into();
        let mut map = self.owners_by_dir.lock().expect("watch owners poisoned");
        let entry = map.entry(directory.clone()).or_default();
        let should_watch = entry.is_empty();
        entry.insert(owner_key);
        drop(map);

        if should_watch {
            if let Ok(mut watcher) = self.watcher.lock() {
                if let Err(error) = watcher.watch(&directory, RecursiveMode::NonRecursive) {
                    warn!("failed to watch {}: {error}", directory.display());
                }
            }
        }
    }

    pub fn clear(&self) {
        let directories = {
            let mut map = self.owners_by_dir.lock().expect("watch owners poisoned");
            map.drain().map(|(path, _)| path).collect::<Vec<_>>()
        };

        if let Ok(mut watcher) = self.watcher.lock() {
            for directory in directories {
                let _ = watcher.unwatch(&directory);
            }
        }
    }
}

fn collect_owners(
    owners_by_dir: &Arc<Mutex<HashMap<PathBuf, HashSet<String>>>>,
    paths: &[PathBuf],
) -> Vec<String> {
    let map = owners_by_dir.lock().expect("watch owners poisoned");
    let mut owners = HashSet::new();
    for path in paths {
        for (directory, directory_owners) in map.iter() {
            if path.starts_with(directory) || directory.starts_with(path) {
                owners.extend(directory_owners.iter().cloned());
            }
        }
    }
    owners.into_iter().collect()
}
