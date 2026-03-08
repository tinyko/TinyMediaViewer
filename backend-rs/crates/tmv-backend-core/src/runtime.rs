use crate::{collect_path_and_ancestors, DirectoryManifest, FolderPreview, FolderSnapshot};
use std::{
    collections::HashMap,
    sync::{Arc, RwLock},
};

#[derive(Default)]
pub(crate) struct RuntimeState {
    path_generations: RwLock<HashMap<String, u64>>,
    light_snapshots: RwLock<HashMap<String, (u64, Arc<FolderSnapshot>)>>,
    previews: RwLock<HashMap<String, HashMap<usize, (u64, FolderPreview)>>>,
    manifests: RwLock<HashMap<String, (u64, DirectoryManifest)>>,
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub(crate) struct PreviewCacheKey {
    pub(crate) path: String,
    pub(crate) limit: usize,
}

impl RuntimeState {
    pub(crate) fn generation(&self, path: &str) -> u64 {
        self.path_generations
            .read()
            .expect("runtime path generations poisoned")
            .get(path)
            .copied()
            .unwrap_or(0)
    }

    pub(crate) fn invalidate_path_and_ancestors(&self, path: &str) {
        for invalidated_path in collect_path_and_ancestors(path) {
            let next_generation = {
                let mut generations = self
                    .path_generations
                    .write()
                    .expect("runtime path generations poisoned");
                let next = generations.get(&invalidated_path).copied().unwrap_or(0) + 1;
                generations.insert(invalidated_path.clone(), next);
                next
            };
            let _ = next_generation;
            self.remove_runtime_path_caches(&invalidated_path);
        }
    }

    pub(crate) fn clear_root_snapshot_cache(&self) {
        self.light_snapshots
            .write()
            .expect("runtime light snapshots poisoned")
            .clear();
    }

    pub(crate) fn read_light_snapshot_cache(
        &self,
        path: &str,
        generation: u64,
    ) -> Option<Arc<FolderSnapshot>> {
        self.light_snapshots
            .read()
            .expect("runtime light snapshots poisoned")
            .get(path)
            .filter(|(stored_generation, _)| *stored_generation == generation)
            .map(|(_, snapshot)| Arc::clone(snapshot))
    }

    pub(crate) fn write_light_snapshot_cache(
        &self,
        path: String,
        generation: u64,
        snapshot: Arc<FolderSnapshot>,
    ) {
        self.light_snapshots
            .write()
            .expect("runtime light snapshots poisoned")
            .insert(path, (generation, snapshot));
    }

    pub(crate) fn read_preview_cache(
        &self,
        key: &PreviewCacheKey,
        generation: u64,
    ) -> Option<FolderPreview> {
        self.previews
            .read()
            .expect("runtime previews poisoned")
            .get(&key.path)
            .and_then(|limits| limits.get(&key.limit))
            .filter(|(stored_generation, _)| *stored_generation == generation)
            .map(|(_, preview)| preview.clone())
    }

    pub(crate) fn write_preview_cache(
        &self,
        key: PreviewCacheKey,
        generation: u64,
        preview: FolderPreview,
    ) {
        self.previews
            .write()
            .expect("runtime previews poisoned")
            .entry(key.path)
            .or_default()
            .insert(key.limit, (generation, preview));
    }

    pub(crate) fn read_manifest_cache(
        &self,
        path: &str,
        generation: u64,
    ) -> Option<DirectoryManifest> {
        self.manifests
            .read()
            .expect("runtime manifests poisoned")
            .get(path)
            .filter(|(stored_generation, _)| *stored_generation == generation)
            .map(|(_, manifest)| manifest.clone())
    }

    pub(crate) fn write_manifest_cache(
        &self,
        path: String,
        generation: u64,
        manifest: DirectoryManifest,
    ) {
        self.manifests
            .write()
            .expect("runtime manifests poisoned")
            .insert(path, (generation, manifest));
    }

    fn remove_runtime_path_caches(&self, path: &str) {
        self.light_snapshots
            .write()
            .expect("runtime light snapshots poisoned")
            .remove(path);
        self.manifests
            .write()
            .expect("runtime manifests poisoned")
            .remove(path);
        self.previews
            .write()
            .expect("runtime previews poisoned")
            .remove(path);
    }

    #[cfg(test)]
    pub(crate) fn preview_cache_entry_count(&self) -> usize {
        self.previews
            .read()
            .expect("runtime previews poisoned")
            .values()
            .map(HashMap::len)
            .sum()
    }

    #[cfg(test)]
    pub(crate) fn has_preview_cache_entry(&self, path: &str, limit: usize) -> bool {
        self.previews
            .read()
            .expect("runtime previews poisoned")
            .get(path)
            .is_some_and(|limits| limits.contains_key(&limit))
    }
}
