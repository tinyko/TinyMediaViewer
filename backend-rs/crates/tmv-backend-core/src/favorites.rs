use super::{normalize_relative_path, BackendService, FolderFavoriteOutput, FolderPreview};
use anyhow::{anyhow, Result};
use std::collections::HashSet;

impl BackendService {
    pub async fn set_folder_favorite(
        &self,
        relative_path: &str,
        favorite: bool,
    ) -> Result<FolderFavoriteOutput> {
        let safe_relative_path = normalize_relative_path(relative_path)?;
        if safe_relative_path.is_empty() {
            return Err(anyhow!("Favorite path must not be empty"));
        }

        self.index
            .set_folder_favorite(safe_relative_path.clone(), favorite)
            .await?;
        self.runtime.clear_root_snapshot_cache();

        Ok(FolderFavoriteOutput {
            path: safe_relative_path,
            favorite,
        })
    }

    pub(crate) async fn annotate_folder_favorite(
        &self,
        mut preview: FolderPreview,
    ) -> Result<FolderPreview> {
        preview.favorite = self.index.is_folder_favorite(preview.path.clone()).await?;
        Ok(preview)
    }

    pub(crate) fn annotate_folder_preview_from_set(
        mut preview: FolderPreview,
        favorite_paths: &HashSet<String>,
    ) -> FolderPreview {
        preview.favorite = favorite_paths.contains(&preview.path);
        preview
    }

    pub(crate) async fn load_folder_favorite_paths(&self) -> Result<HashSet<String>> {
        #[cfg(test)]
        self.favorite_set_loads
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Ok(self
            .index
            .load_all_folder_favorites()
            .await?
            .into_iter()
            .collect())
    }

    pub(crate) async fn annotate_folder_favorites(
        &self,
        mut previews: Vec<FolderPreview>,
    ) -> Result<Vec<FolderPreview>> {
        if previews.is_empty() {
            return Ok(previews);
        }

        let favorites = self.load_folder_favorite_paths().await?;
        for preview in &mut previews {
            preview.favorite = favorites.contains(&preview.path);
        }
        Ok(previews)
    }
}
