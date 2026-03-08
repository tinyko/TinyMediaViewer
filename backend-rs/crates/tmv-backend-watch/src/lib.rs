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
    state: Arc<Mutex<RegistryState>>,
}

#[derive(Default)]
struct RegistryState {
    owners_by_dir: HashMap<PathBuf, HashSet<String>>,
    dirs_by_owner: HashMap<String, HashSet<PathBuf>>,
    descendant_dirs_by_ancestor: HashMap<PathBuf, HashSet<PathBuf>>,
}

#[derive(Default)]
struct WatchDiff {
    watch: Vec<PathBuf>,
    unwatch: Vec<PathBuf>,
}

trait DirectoryWatcher {
    fn watch_directory(&mut self, directory: &Path) -> notify::Result<()>;
    fn unwatch_directory(&mut self, directory: &Path) -> notify::Result<()>;
}

impl DirectoryWatcher for RecommendedWatcher {
    fn watch_directory(&mut self, directory: &Path) -> notify::Result<()> {
        self.watch(directory, RecursiveMode::NonRecursive)
    }

    fn unwatch_directory(&mut self, directory: &Path) -> notify::Result<()> {
        self.unwatch(directory)
    }
}

impl WatchRegistry {
    pub fn new(on_invalidate: InvalidateFn) -> Result<Self> {
        let state = Arc::new(Mutex::new(RegistryState::default()));
        let state_for_callback = Arc::clone(&state);
        let watcher = RecommendedWatcher::new(
            move |result: notify::Result<Event>| match result {
                Ok(event) => {
                    let owners = {
                        let state = state_for_callback.lock().expect("watch state poisoned");
                        collect_owners(&state, &event.paths)
                    };
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
            state,
        })
    }

    pub fn replace_owner_directories(
        &self,
        owner_key: impl Into<String>,
        directories: impl IntoIterator<Item = PathBuf>,
    ) {
        let owner_key = owner_key.into();
        let desired = directories.into_iter().collect::<HashSet<_>>();
        let diff = {
            let mut state = self.state.lock().expect("watch state poisoned");
            state.replace_owner_directories(owner_key, desired)
        };
        self.apply_diff(diff);
    }

    pub fn clear_owner(&self, owner_key: impl AsRef<str>) {
        let diff = {
            let mut state = self.state.lock().expect("watch state poisoned");
            state.clear_owner(owner_key.as_ref())
        };
        self.apply_diff(diff);
    }

    pub fn clear(&self) {
        let diff = {
            let mut state = self.state.lock().expect("watch state poisoned");
            state.clear_all()
        };
        self.apply_diff(diff);
    }

    pub fn watched_directory_count(&self) -> usize {
        self.state
            .lock()
            .expect("watch state poisoned")
            .owners_by_dir
            .len()
    }

    pub fn owner_directory_count(&self, owner_key: &str) -> usize {
        self.state
            .lock()
            .expect("watch state poisoned")
            .dirs_by_owner
            .get(owner_key)
            .map_or(0, HashSet::len)
    }

    fn apply_diff(&self, diff: WatchDiff) {
        if diff.watch.is_empty() && diff.unwatch.is_empty() {
            return;
        }

        if let Ok(mut watcher) = self.watcher.lock() {
            apply_watch_diff(&mut *watcher, diff);
        }
    }
}

impl RegistryState {
    fn replace_owner_directories(
        &mut self,
        owner_key: String,
        desired: HashSet<PathBuf>,
    ) -> WatchDiff {
        let previous = self
            .dirs_by_owner
            .get(&owner_key)
            .cloned()
            .unwrap_or_default();
        let removed = previous.difference(&desired).cloned().collect::<Vec<_>>();
        let added = desired.difference(&previous).cloned().collect::<Vec<_>>();

        let mut diff = WatchDiff::default();

        for directory in removed {
            if self.remove_directory_owner(&directory, &owner_key) {
                diff.unwatch.push(directory);
            }
        }

        if desired.is_empty() {
            self.dirs_by_owner.remove(&owner_key);
        } else {
            self.dirs_by_owner.insert(owner_key.clone(), desired);
        }

        for directory in added {
            if self.add_directory_owner(directory.clone(), &owner_key) {
                diff.watch.push(directory);
            }
        }

        diff
    }

    fn clear_owner(&mut self, owner_key: &str) -> WatchDiff {
        let previous = self
            .dirs_by_owner
            .remove(owner_key)
            .unwrap_or_default()
            .into_iter()
            .collect::<Vec<_>>();
        let mut diff = WatchDiff::default();

        for directory in previous {
            if self.remove_directory_owner(&directory, owner_key) {
                diff.unwatch.push(directory);
            }
        }

        diff
    }

    fn clear_all(&mut self) -> WatchDiff {
        let diff = WatchDiff {
            watch: Vec::new(),
            unwatch: self.owners_by_dir.keys().cloned().collect(),
        };
        self.owners_by_dir.clear();
        self.dirs_by_owner.clear();
        self.descendant_dirs_by_ancestor.clear();
        diff
    }

    fn add_directory_owner(&mut self, directory: PathBuf, owner_key: &str) -> bool {
        let owners = self.owners_by_dir.entry(directory.clone()).or_default();
        let should_watch = owners.is_empty();
        owners.insert(owner_key.to_string());

        if should_watch {
            self.insert_descendant_links(&directory);
        }

        should_watch
    }

    fn remove_directory_owner(&mut self, directory: &Path, owner_key: &str) -> bool {
        let Some(owners) = self.owners_by_dir.get_mut(directory) else {
            return false;
        };
        owners.remove(owner_key);
        let should_unwatch = owners.is_empty();

        if should_unwatch {
            self.owners_by_dir.remove(directory);
            self.remove_descendant_links(directory);
        }

        should_unwatch
    }

    fn insert_descendant_links(&mut self, directory: &Path) {
        for ancestor in ancestor_directories(directory) {
            self.descendant_dirs_by_ancestor
                .entry(ancestor)
                .or_default()
                .insert(directory.to_path_buf());
        }
    }

    fn remove_descendant_links(&mut self, directory: &Path) {
        for ancestor in ancestor_directories(directory) {
            let should_remove_entry = self
                .descendant_dirs_by_ancestor
                .get_mut(&ancestor)
                .is_some_and(|descendants| {
                    descendants.remove(directory);
                    descendants.is_empty()
                });
            if should_remove_entry {
                self.descendant_dirs_by_ancestor.remove(&ancestor);
            }
        }
    }
}

fn apply_watch_diff<W: DirectoryWatcher>(watcher: &mut W, diff: WatchDiff) {
    for directory in diff.unwatch {
        if let Err(error) = watcher.unwatch_directory(&directory) {
            warn!("failed to unwatch {}: {error}", directory.display());
        }
    }

    for directory in diff.watch {
        if let Err(error) = watcher.watch_directory(&directory) {
            warn!("failed to watch {}: {error}", directory.display());
        }
    }
}

fn ancestor_directories(directory: &Path) -> Vec<PathBuf> {
    let mut ancestors = Vec::new();
    let mut current = directory.parent();
    while let Some(path) = current {
        ancestors.push(path.to_path_buf());
        current = path.parent();
    }
    ancestors
}

fn collect_owners(state: &RegistryState, paths: &[PathBuf]) -> Vec<String> {
    let mut owners = HashSet::new();
    for path in paths {
        collect_owners_for_path(state, path, &mut owners);
    }
    owners.into_iter().collect()
}

fn collect_owners_for_path(state: &RegistryState, path: &Path, owners: &mut HashSet<String>) {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if let Some(directory_owners) = state.owners_by_dir.get(candidate) {
            owners.extend(directory_owners.iter().cloned());
        }
        current = candidate.parent();
    }

    if let Some(descendants) = state.descendant_dirs_by_ancestor.get(path) {
        for directory in descendants {
            if let Some(directory_owners) = state.owners_by_dir.get(directory) {
                owners.extend(directory_owners.iter().cloned());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct TestWatcher {
        watched: HashSet<PathBuf>,
        watch_calls: Mutex<Vec<PathBuf>>,
        unwatch_calls: Mutex<Vec<PathBuf>>,
    }

    impl DirectoryWatcher for TestWatcher {
        fn watch_directory(&mut self, directory: &Path) -> notify::Result<()> {
            self.watched.insert(directory.to_path_buf());
            self.watch_calls
                .lock()
                .expect("watch calls poisoned")
                .push(directory.to_path_buf());
            Ok(())
        }

        fn unwatch_directory(&mut self, directory: &Path) -> notify::Result<()> {
            self.watched.remove(directory);
            self.unwatch_calls
                .lock()
                .expect("unwatch calls poisoned")
                .push(directory.to_path_buf());
            Ok(())
        }
    }

    fn path(value: &str) -> PathBuf {
        PathBuf::from(value)
    }

    #[test]
    fn syncs_owner_directories_with_diff() {
        let mut state = RegistryState::default();
        let mut watcher = TestWatcher::default();

        apply_watch_diff(
            &mut watcher,
            state.replace_owner_directories(
                "alpha".to_string(),
                HashSet::from([path("/root/alpha"), path("/root/alpha/images")]),
            ),
        );
        assert_eq!(watcher.watched.len(), 2);

        apply_watch_diff(
            &mut watcher,
            state.replace_owner_directories(
                "alpha".to_string(),
                HashSet::from([path("/root/alpha"), path("/root/alpha/videos")]),
            ),
        );

        assert!(watcher.watched.contains(&path("/root/alpha")));
        assert!(watcher.watched.contains(&path("/root/alpha/videos")));
        assert!(!watcher.watched.contains(&path("/root/alpha/images")));
        assert_eq!(
            watcher
                .watch_calls
                .lock()
                .expect("watch calls poisoned")
                .iter()
                .filter(|value| value.as_path() == Path::new("/root/alpha"))
                .count(),
            1
        );
    }

    #[test]
    fn clears_last_owner_and_unwatches_directory() {
        let mut state = RegistryState::default();
        let mut watcher = TestWatcher::default();

        apply_watch_diff(
            &mut watcher,
            state.replace_owner_directories(
                "alpha".to_string(),
                HashSet::from([path("/root/shared")]),
            ),
        );
        apply_watch_diff(
            &mut watcher,
            state.replace_owner_directories(
                "beta".to_string(),
                HashSet::from([path("/root/shared")]),
            ),
        );
        apply_watch_diff(&mut watcher, state.clear_owner("alpha"));

        assert!(watcher.watched.contains(&path("/root/shared")));

        apply_watch_diff(&mut watcher, state.clear_owner("beta"));

        assert!(!watcher.watched.contains(&path("/root/shared")));
        assert_eq!(
            watcher
                .unwatch_calls
                .lock()
                .expect("unwatch calls poisoned")
                .iter()
                .filter(|value| value.as_path() == Path::new("/root/shared"))
                .count(),
            1
        );
    }

    #[test]
    fn collects_owner_when_event_hits_descendant_path_ancestor() {
        let mut state = RegistryState::default();
        let _ = state.replace_owner_directories(
            "alpha".to_string(),
            HashSet::from([path("/root/alpha/images")]),
        );

        let owners = collect_owners(&state, &[path("/root/alpha/images/photo.jpg")]);
        assert_eq!(owners, vec!["alpha"]);
    }

    #[test]
    fn collects_owner_when_event_hits_parent_of_watched_directory() {
        let mut state = RegistryState::default();
        let _ = state.replace_owner_directories(
            "alpha".to_string(),
            HashSet::from([path("/root/alpha/images")]),
        );

        let owners = collect_owners(&state, &[path("/root/alpha")]);
        assert_eq!(owners, vec!["alpha"]);
    }

    #[test]
    fn repeated_sync_does_not_rewatch_same_directory() {
        let mut state = RegistryState::default();
        let mut watcher = TestWatcher::default();

        let desired = HashSet::from([path("/root/alpha"), path("/root/alpha/images")]);
        apply_watch_diff(
            &mut watcher,
            state.replace_owner_directories("alpha".to_string(), desired.clone()),
        );
        apply_watch_diff(
            &mut watcher,
            state.replace_owner_directories("alpha".to_string(), desired),
        );

        assert_eq!(
            watcher
                .watch_calls
                .lock()
                .expect("watch calls poisoned")
                .len(),
            2
        );
        assert_eq!(watcher.watched.len(), 2);
    }
}
