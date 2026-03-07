use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

const SCHEMA_VERSION: i64 = 2;

#[derive(Clone)]
pub struct IndexStore {
    db_path: Arc<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct PersistedMediaRecord {
    pub ordinal: i64,
    pub media_path: String,
    pub kind: String,
    pub modified: f64,
    pub size: i64,
    pub payload_json: String,
}

#[derive(Debug, Clone)]
pub struct PersistedManifestRecord {
    pub path: String,
    pub stamp: String,
    pub root_modified: f64,
    pub subfolders_json: String,
    pub watched_dirs_json: String,
    pub media_json: String,
    pub media_bin: Option<Vec<u8>>,
    pub default_page_media_json: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SaveManifestInput {
    pub path: String,
    pub stamp: String,
    pub root_modified: f64,
    pub subfolders_json: String,
    pub watched_dirs_json: String,
    pub media_json: String,
    pub media_bin: Vec<u8>,
    pub default_page_media_json: String,
    pub media: Vec<PersistedMediaRecord>,
}

impl IndexStore {
    pub async fn new(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        tokio::task::spawn_blocking(move || {
            fs::create_dir_all(&dir)
                .with_context(|| format!("create index dir {}", dir.display()))?;
            let db_path = dir.join("tmv-index.sqlite3");
            let store = Self {
                db_path: Arc::new(db_path),
            };
            store.init_schema()?;
            Ok(store)
        })
        .await
        .context("join init index store task")?
    }

    pub async fn save_manifest(&self, manifest: SaveManifestInput) -> Result<()> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = this.open()?;
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO folder_manifest (path, stamp, root_modified, subfolders_json, watched_dirs_json, media_json, media_bin, default_page_media_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, unixepoch('now') * 1000)
                 ON CONFLICT(path) DO UPDATE SET
                   stamp = excluded.stamp,
                   root_modified = excluded.root_modified,
                   subfolders_json = excluded.subfolders_json,
                   watched_dirs_json = excluded.watched_dirs_json,
                   media_json = excluded.media_json,
                   media_bin = excluded.media_bin,
                   default_page_media_json = excluded.default_page_media_json,
                   updated_at = excluded.updated_at",
                params![
                    manifest.path,
                    manifest.stamp,
                    manifest.root_modified,
                    manifest.subfolders_json,
                    manifest.watched_dirs_json,
                    manifest.media_json,
                    manifest.media_bin,
                    manifest.default_page_media_json
                ],
            )?;
            tx.execute(
                "DELETE FROM media_entry WHERE folder_path = ?1",
                params![manifest.path],
            )?;
            {
                let mut stmt = tx.prepare(
                    "INSERT INTO media_entry (folder_path, ordinal, media_path, kind, modified, size, payload_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )?;
                for item in manifest.media {
                    stmt.execute(params![
                        manifest.path,
                        item.ordinal,
                        item.media_path,
                        item.kind,
                        item.modified,
                        item.size,
                        item.payload_json
                    ])?;
                }
            }
            tx.commit()?;
            Ok(())
        })
        .await
        .context("join save manifest task")?
    }

    pub async fn load_manifest(
        &self,
        path: String,
        stamp: String,
    ) -> Result<Option<PersistedManifestRecord>> {
        self.load_manifest_inner(path, Some(stamp)).await
    }

    pub async fn load_latest_manifest(
        &self,
        path: String,
    ) -> Result<Option<PersistedManifestRecord>> {
        self.load_manifest_inner(path, None).await
    }

    async fn load_manifest_inner(
        &self,
        path: String,
        stamp: Option<String>,
    ) -> Result<Option<PersistedManifestRecord>> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = this.open()?;
            let row = if let Some(stamp_value) = stamp {
                conn.query_row(
                    "SELECT path, stamp, root_modified, subfolders_json, watched_dirs_json, media_json, media_bin, default_page_media_json
                     FROM folder_manifest WHERE path = ?1 AND stamp = ?2",
                    params![path, stamp_value],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, f64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, Option<Vec<u8>>>(6)?,
                            row.get::<_, Option<String>>(7)?,
                        ))
                    },
                )
                .optional()?
            } else {
                conn.query_row(
                    "SELECT path, stamp, root_modified, subfolders_json, watched_dirs_json, media_json, media_bin, default_page_media_json
                     FROM folder_manifest WHERE path = ?1",
                    params![path],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, f64>(2)?,
                            row.get::<_, String>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, Option<Vec<u8>>>(6)?,
                            row.get::<_, Option<String>>(7)?,
                        ))
                    },
                )
                .optional()?
            };

            let Some((path, stamp, root_modified, subfolders_json, watched_dirs_json, media_json, media_bin, default_page_media_json)) = row else {
                return Ok(None);
            };

            Ok(Some(PersistedManifestRecord {
                path,
                stamp,
                root_modified,
                subfolders_json,
                watched_dirs_json,
                media_json,
                media_bin,
                default_page_media_json,
            }))
        })
        .await
        .context("join load manifest task")?
    }

    pub async fn save_preview(
        &self,
        path: String,
        preview_limit: i64,
        stamp: String,
        payload_json: String,
    ) -> Result<()> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = this.open()?;
            conn.execute(
                "INSERT INTO folder_preview_cache (path, preview_limit, stamp, payload_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4, unixepoch('now') * 1000)
                 ON CONFLICT(path, preview_limit) DO UPDATE SET
                   stamp = excluded.stamp,
                   payload_json = excluded.payload_json,
                   updated_at = excluded.updated_at",
                params![path, preview_limit, stamp, payload_json],
            )?;
            Ok(())
        })
        .await
        .context("join save preview task")?
    }

    pub async fn load_preview(
        &self,
        path: String,
        preview_limit: i64,
        stamp: String,
    ) -> Result<Option<String>> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = this.open()?;
            conn.query_row(
                "SELECT payload_json FROM folder_preview_cache
                 WHERE path = ?1 AND preview_limit = ?2 AND stamp = ?3",
                params![path, preview_limit, stamp],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(Into::into)
        })
        .await
        .context("join load preview task")?
    }

    pub async fn save_thumbnail_job(
        &self,
        source_path: String,
        source_modified_ms: i64,
        status: String,
        error: Option<String>,
    ) -> Result<()> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = this.open()?;
            conn.execute(
                "INSERT INTO thumbnail_job (source_path, source_modified_ms, status, error, updated_at)
                 VALUES (?1, ?2, ?3, ?4, unixepoch('now') * 1000)
                 ON CONFLICT(source_path) DO UPDATE SET
                   source_modified_ms = excluded.source_modified_ms,
                   status = excluded.status,
                   error = excluded.error,
                   updated_at = excluded.updated_at",
                params![source_path, source_modified_ms, status, error],
            )?;
            Ok(())
        })
        .await
        .context("join save thumbnail job task")?
    }

    pub async fn save_thumbnail_asset(
        &self,
        source_path: String,
        source_modified_ms: i64,
        output_path: String,
    ) -> Result<()> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = this.open()?;
            conn.execute(
                "INSERT INTO thumbnail_asset (source_path, source_modified_ms, output_path, updated_at)
                 VALUES (?1, ?2, ?3, unixepoch('now') * 1000)
                 ON CONFLICT(source_path) DO UPDATE SET
                   source_modified_ms = excluded.source_modified_ms,
                   output_path = excluded.output_path,
                   updated_at = excluded.updated_at",
                params![source_path, source_modified_ms, output_path],
            )?;
            Ok(())
        })
        .await
        .context("join save thumbnail asset task")?
    }

    pub async fn load_thumbnail_asset(
        &self,
        source_path: String,
        source_modified_ms: i64,
    ) -> Result<Option<String>> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = this.open()?;
            conn.query_row(
                "SELECT output_path FROM thumbnail_asset
                 WHERE source_path = ?1 AND source_modified_ms = ?2",
                params![source_path, source_modified_ms],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(Into::into)
        })
        .await
        .context("join load thumbnail asset task")?
    }

    pub async fn put_runtime_meta(&self, key: String, value: String) -> Result<()> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = this.open()?;
            conn.execute(
                "INSERT INTO runtime_meta (key, value, updated_at)
                 VALUES (?1, ?2, unixepoch('now') * 1000)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, value],
            )?;
            Ok(())
        })
        .await
        .context("join put runtime meta task")?
    }

    pub async fn set_folder_favorite(&self, path: String, favorite: bool) -> Result<()> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = this.open()?;
            if favorite {
                conn.execute(
                    "INSERT INTO folder_favorite (path, updated_at)
                     VALUES (?1, unixepoch('now') * 1000)
                     ON CONFLICT(path) DO UPDATE SET updated_at = excluded.updated_at",
                    params![path],
                )?;
            } else {
                conn.execute("DELETE FROM folder_favorite WHERE path = ?1", params![path])?;
            }
            Ok(())
        })
        .await
        .context("join set folder favorite task")?
    }

    pub async fn is_folder_favorite(&self, path: String) -> Result<bool> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = this.open()?;
            conn.query_row(
                "SELECT 1 FROM folder_favorite WHERE path = ?1",
                params![path],
                |_row| Ok(true),
            )
            .optional()
            .map(|value| value.unwrap_or(false))
            .map_err(Into::into)
        })
        .await
        .context("join is folder favorite task")?
    }

    pub async fn load_all_folder_favorites(&self) -> Result<Vec<String>> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || {
            let conn = this.open()?;
            let mut stmt = conn
                .prepare("SELECT path FROM folder_favorite ORDER BY updated_at DESC, path ASC")?;
            let favorites = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(anyhow::Error::from)?;
            Ok(favorites)
        })
        .await
        .context("join load all folder favorites task")?
    }

    fn init_schema(&self) -> Result<()> {
        let conn = self.open()?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS folder_manifest (
              path TEXT PRIMARY KEY,
              stamp TEXT NOT NULL,
              root_modified INTEGER NOT NULL,
              subfolders_json TEXT NOT NULL,
              watched_dirs_json TEXT NOT NULL,
              media_json TEXT NOT NULL DEFAULT '[]',
              media_bin BLOB,
              default_page_media_json TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS media_entry (
              folder_path TEXT NOT NULL,
              ordinal INTEGER NOT NULL,
              media_path TEXT NOT NULL,
              kind TEXT NOT NULL,
              modified INTEGER NOT NULL,
              size INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY (folder_path, ordinal)
            );
            CREATE INDEX IF NOT EXISTS idx_media_entry_folder_path
              ON media_entry (folder_path);
            CREATE TABLE IF NOT EXISTS folder_preview_cache (
              path TEXT NOT NULL,
              preview_limit INTEGER NOT NULL,
              stamp TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              updated_at INTEGER NOT NULL,
              PRIMARY KEY (path, preview_limit)
            );
            CREATE TABLE IF NOT EXISTS thumbnail_job (
              source_path TEXT PRIMARY KEY,
              source_modified_ms INTEGER NOT NULL,
              status TEXT NOT NULL,
              error TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS thumbnail_asset (
              source_path TEXT PRIMARY KEY,
              source_modified_ms INTEGER NOT NULL,
              output_path TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS runtime_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS folder_favorite (
              path TEXT PRIMARY KEY,
              updated_at INTEGER NOT NULL
            );
            ",
        )?;
        ensure_manifest_media_json_column(&conn)?;
        ensure_manifest_media_bin_column(&conn)?;
        ensure_manifest_default_page_media_json_column(&conn)?;
        conn.execute(
            "INSERT INTO runtime_meta (key, value, updated_at)
             VALUES ('schema_version', ?1, unixepoch('now') * 1000)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
    }

    fn open(&self) -> Result<Connection> {
        let conn = Connection::open(self.db_path.as_ref())
            .with_context(|| format!("open sqlite {}", self.db_path.display()))?;
        configure_connection(&conn)?;
        Ok(conn)
    }
}

fn configure_connection(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;
        PRAGMA wal_autocheckpoint = 1000;
        ",
    )?;
    Ok(())
}

fn ensure_manifest_media_json_column(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(folder_manifest)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if columns.iter().any(|column| column == "media_json") {
        return Ok(());
    }

    conn.execute(
        "ALTER TABLE folder_manifest ADD COLUMN media_json TEXT NOT NULL DEFAULT '[]'",
        [],
    )?;
    Ok(())
}

fn ensure_manifest_media_bin_column(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(folder_manifest)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if columns.iter().any(|column| column == "media_bin") {
        return Ok(());
    }

    conn.execute("ALTER TABLE folder_manifest ADD COLUMN media_bin BLOB", [])?;
    Ok(())
}

fn ensure_manifest_default_page_media_json_column(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(folder_manifest)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if columns
        .iter()
        .any(|column| column == "default_page_media_json")
    {
        return Ok(());
    }

    conn.execute(
        "ALTER TABLE folder_manifest ADD COLUMN default_page_media_json TEXT",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{IndexStore, PersistedMediaRecord, SaveManifestInput};
    use tempfile::tempdir;

    #[tokio::test]
    async fn opens_connections_with_wal_enabled() {
        let temp = tempdir().expect("tempdir");
        let store = IndexStore::new(temp.path()).await.expect("store");
        let conn = store.open().expect("open");

        let journal_mode = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .expect("journal mode");
        let wal_autocheckpoint = conn
            .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get::<_, i64>(0))
            .expect("wal autocheckpoint");

        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(wal_autocheckpoint, 1000);
    }

    #[tokio::test]
    async fn persists_manifest_and_preview_roundtrip() {
        let temp = tempdir().expect("tempdir");
        let store = IndexStore::new(temp.path()).await.expect("store");
        store
            .save_manifest(SaveManifestInput {
                path: "alpha".to_string(),
                stamp: "stamp".to_string(),
                root_modified: 123.0,
                subfolders_json: "[]".to_string(),
                watched_dirs_json: "[]".to_string(),
                media_json: "[{\"path\":\"alpha/image.jpg\"}]".to_string(),
                media_bin: vec![1, 2, 3],
                default_page_media_json: "[{\"path\":\"alpha/image.jpg\"}]".to_string(),
                media: vec![PersistedMediaRecord {
                    ordinal: 0,
                    media_path: "alpha/image.jpg".to_string(),
                    kind: "image".to_string(),
                    modified: 123.0,
                    size: 456,
                    payload_json: "{\"path\":\"alpha/image.jpg\"}".to_string(),
                }],
            })
            .await
            .expect("save manifest");

        let manifest = store
            .load_manifest("alpha".to_string(), "stamp".to_string())
            .await
            .expect("load manifest")
            .expect("manifest");
        assert_eq!(manifest.media_json, "[{\"path\":\"alpha/image.jpg\"}]");
        assert_eq!(manifest.media_bin.as_deref(), Some(&[1, 2, 3][..]));
        assert_eq!(
            manifest.default_page_media_json.as_deref(),
            Some("[{\"path\":\"alpha/image.jpg\"}]")
        );

        let latest = store
            .load_latest_manifest("alpha".to_string())
            .await
            .expect("load latest manifest")
            .expect("latest manifest");
        assert_eq!(latest.stamp, "stamp");

        store
            .save_preview(
                "alpha".to_string(),
                6,
                "stamp".to_string(),
                "{\"path\":\"alpha\"}".to_string(),
            )
            .await
            .expect("save preview");
        let preview = store
            .load_preview("alpha".to_string(), 6, "stamp".to_string())
            .await
            .expect("load preview");
        assert!(preview.is_some());
    }

    #[tokio::test]
    async fn persists_folder_favorites() {
        let temp = tempdir().expect("tempdir");
        let store = IndexStore::new(temp.path()).await.expect("store");

        store
            .set_folder_favorite("alpha".to_string(), true)
            .await
            .expect("favorite alpha");
        store
            .set_folder_favorite("beta".to_string(), true)
            .await
            .expect("favorite beta");

        let favorites = store
            .load_all_folder_favorites()
            .await
            .expect("load favorites");
        assert_eq!(favorites.len(), 2);
        assert!(favorites.contains(&"alpha".to_string()));
        assert!(favorites.contains(&"beta".to_string()));
        assert!(store
            .is_folder_favorite("alpha".to_string())
            .await
            .expect("alpha favorite"));

        store
            .set_folder_favorite("alpha".to_string(), false)
            .await
            .expect("remove alpha favorite");

        assert!(!store
            .is_folder_favorite("alpha".to_string())
            .await
            .expect("alpha not favorite"));
        let favorites = store
            .load_all_folder_favorites()
            .await
            .expect("load favorites after removal");
        assert_eq!(favorites, vec!["beta".to_string()]);
    }
}
