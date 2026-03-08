use anyhow::{anyhow, Context, Result};
use deadpool_sqlite::{Config, Hook, HookError, Pool, Runtime};
use rusqlite::{params, Connection, OptionalExtension};
use std::{fs, path::Path};

const SCHEMA_VERSION: i64 = 6;

#[derive(Clone)]
pub struct IndexStore {
    pool: Pool,
}

#[derive(Debug, Clone)]
pub struct PersistedMediaRecord {
    pub ordinal: i64,
    pub media_path: String,
    pub filter_group: String,
    pub name: String,
    pub kind: String,
    pub sort_ts_ms: i64,
    pub modified: f64,
    pub size: i64,
    pub payload_json: String,
}

#[derive(Debug, Clone)]
pub struct PersistedManifestRecord {
    pub path: String,
    pub stamp: String,
    pub root_modified: f64,
    pub media_total: i64,
    pub image_total: i64,
    pub gif_total: i64,
    pub video_total: i64,
    pub subfolders_json: String,
    pub watched_dirs_json: String,
}

#[derive(Debug, Clone)]
pub struct SaveManifestInput {
    pub path: String,
    pub stamp: String,
    pub root_modified: f64,
    pub media_total: i64,
    pub image_total: i64,
    pub gif_total: i64,
    pub video_total: i64,
    pub subfolders_json: String,
    pub watched_dirs_json: String,
    pub media: Vec<PersistedMediaRecord>,
}

#[derive(Debug, Clone)]
pub struct PersistedThumbnailJobRecord {
    pub status: String,
    pub error: Option<String>,
    pub updated_at: i64,
}

impl IndexStore {
    pub async fn new(dir: impl AsRef<Path>) -> Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        fs::create_dir_all(&dir).with_context(|| format!("create index dir {}", dir.display()))?;
        let db_path = dir.join("tmv-index.sqlite3");

        let cfg = Config::new(db_path);
        let pool = cfg
            .builder(Runtime::Tokio1)
            .expect("deadpool sqlite config is infallible")
            .max_size(8)
            .post_create(Hook::async_fn(|conn, _| {
                Box::pin(async move {
                    conn.interact(configure_connection)
                        .await
                        .map_err(|err| {
                            HookError::message(format!(
                                "sqlite connection setup task failed: {err}"
                            ))
                        })?
                        .map_err(HookError::Backend)
                })
            }))
            .build()
            .context("build sqlite connection pool")?;

        let store = Self { pool };
        store
            .interact(|conn| Self::init_schema(conn))
            .await
            .context("db schema init task error")?;

        Ok(store)
    }

    pub async fn interact<F, R>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&mut Connection) -> Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let conn = self.pool.get().await.context("get db connection")?;
        conn.interact(f)
            .await
            .map_err(|e| anyhow::anyhow!("db task panicked or canceled: {}", e))?
    }

    pub async fn save_manifest(&self, manifest: SaveManifestInput) -> Result<()> {
        self.interact(move |conn| {
            let SaveManifestInput {
                path,
                stamp,
                root_modified,
                media_total,
                image_total,
                gif_total,
                video_total,
                subfolders_json,
                watched_dirs_json,
                media,
            } = manifest;
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO folder_manifest (path, stamp, root_modified, media_total, image_total, gif_total, video_total, subfolders_json, watched_dirs_json, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, unixepoch('now') * 1000)
                 ON CONFLICT(path) DO UPDATE SET
                   stamp = excluded.stamp,
                   root_modified = excluded.root_modified,
                   media_total = excluded.media_total,
                   image_total = excluded.image_total,
                   gif_total = excluded.gif_total,
                   video_total = excluded.video_total,
                   subfolders_json = excluded.subfolders_json,
                   watched_dirs_json = excluded.watched_dirs_json,
                   updated_at = excluded.updated_at",
                params![
                    &path,
                    &stamp,
                    root_modified,
                    media_total,
                    image_total,
                    gif_total,
                    video_total,
                    &subfolders_json,
                    &watched_dirs_json
                ],
            )?;
            tx.execute(
                "CREATE TEMP TABLE IF NOT EXISTS media_entry_keep_paths (
                   folder_path TEXT NOT NULL,
                   media_path TEXT NOT NULL,
                   PRIMARY KEY (folder_path, media_path)
                 )",
                [],
            )?;
            tx.execute(
                "DELETE FROM media_entry_keep_paths WHERE folder_path = ?1",
                params![&path],
            )?;
            {
                let mut upsert_stmt = tx.prepare(
                    "INSERT INTO media_entry (folder_path, ordinal, media_path, filter_group, name, kind, sort_ts_ms, modified, size, payload_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                     ON CONFLICT(folder_path, media_path) DO UPDATE SET
                       ordinal = excluded.ordinal,
                       filter_group = excluded.filter_group,
                       name = excluded.name,
                       kind = excluded.kind,
                       sort_ts_ms = excluded.sort_ts_ms,
                       modified = excluded.modified,
                       size = excluded.size,
                       payload_json = excluded.payload_json",
                )?;
                let mut keep_stmt = tx.prepare(
                    "INSERT INTO media_entry_keep_paths (folder_path, media_path)
                     VALUES (?1, ?2)
                     ON CONFLICT(folder_path, media_path) DO NOTHING",
                )?;
                for item in &media {
                    upsert_stmt.execute(params![
                        &path,
                        item.ordinal,
                        &item.media_path,
                        &item.filter_group,
                        &item.name,
                        &item.kind,
                        item.sort_ts_ms,
                        item.modified,
                        item.size,
                        &item.payload_json
                    ])?;
                    keep_stmt.execute(params![&path, &item.media_path])?;
                }
            }
            if media.is_empty() {
                tx.execute(
                    "DELETE FROM media_entry WHERE folder_path = ?1",
                    params![&path],
                )?;
            } else {
                tx.execute(
                    "DELETE FROM media_entry
                     WHERE folder_path = ?1
                       AND NOT EXISTS (
                         SELECT 1
                         FROM media_entry_keep_paths keep
                         WHERE keep.folder_path = ?1
                           AND keep.media_path = media_entry.media_path
                       )",
                    params![&path],
                )?;
            }
            tx.execute(
                "DELETE FROM media_entry_keep_paths WHERE folder_path = ?1",
                params![&path],
            )?;
            tx.commit()?;
            Ok(())
        })
        .await
        .context("save manifest run error")
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
        self.interact(move |conn| {
            let row = if let Some(stamp_value) = stamp {
                conn.query_row(
                    "SELECT path, stamp, root_modified, media_total, image_total, gif_total, video_total, subfolders_json, watched_dirs_json
                     FROM folder_manifest WHERE path = ?1 AND stamp = ?2",
                    params![path, stamp_value],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, f64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                        ))
                    },
                )
                .optional()?
            } else {
                conn.query_row(
                    "SELECT path, stamp, root_modified, media_total, image_total, gif_total, video_total, subfolders_json, watched_dirs_json
                     FROM folder_manifest WHERE path = ?1",
                    params![path],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, f64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                        ))
                    },
                )
                .optional()?
            };
            let Some((path, stamp, root_modified, media_total, image_total, gif_total, video_total, subfolders_json, watched_dirs_json)) = row else {
                return Ok(None);
            };

            Ok(Some(PersistedManifestRecord {
                path,
                stamp,
                root_modified,
                media_total,
                image_total,
                gif_total,
                video_total,
                subfolders_json,
                watched_dirs_json,
            }))
        })
        .await
        .context("load manifest inner task error")
    }

    pub async fn has_media_entries(&self, folder_path: String) -> Result<bool> {
        self.interact(move |conn| {
            conn.query_row(
                "SELECT 1 FROM media_entry WHERE folder_path = ?1 LIMIT 1",
                params![folder_path],
                |_row| Ok(true),
            )
            .optional()
            .map(|value| value.unwrap_or(false))
            .map_err(Into::into)
        })
        .await
        .context("has media entries task error")
    }

    pub async fn load_media_page_payloads(
        &self,
        folder_path: String,
        filter_group: Option<String>,
        descending: bool,
        offset: i64,
        limit: i64,
    ) -> Result<Vec<String>> {
        self.interact(move |conn| {
            let order = if descending { "DESC" } else { "ASC" };
            let sql = if filter_group.is_some() {
                format!(
                    "SELECT payload_json FROM media_entry
                     WHERE folder_path = ?1 AND filter_group = ?2
                     ORDER BY sort_ts_ms {order}, name ASC, media_path ASC
                     LIMIT ?3 OFFSET ?4"
                )
            } else {
                format!(
                    "SELECT payload_json FROM media_entry
                     WHERE folder_path = ?1
                     ORDER BY sort_ts_ms {order}, name ASC, media_path ASC
                     LIMIT ?2 OFFSET ?3"
                )
            };
            let mut stmt = conn.prepare(&sql)?;
            let rows = if let Some(filter_group) = filter_group {
                stmt.query_map(params![folder_path, filter_group, limit, offset], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
            } else {
                stmt.query_map(params![folder_path, limit, offset], |row| {
                    row.get::<_, String>(0)
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?
            };
            Ok(rows)
        })
        .await
        .context("load media page payloads task error")
    }

    pub async fn count_media_entries(
        &self,
        folder_path: String,
        filter_group: Option<String>,
    ) -> Result<i64> {
        self.interact(move |conn| {
            if let Some(filter_group) = filter_group {
                conn.query_row(
                    "SELECT COUNT(*) FROM media_entry WHERE folder_path = ?1 AND filter_group = ?2",
                    params![folder_path, filter_group],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(Into::into)
            } else {
                conn.query_row(
                    "SELECT COUNT(*) FROM media_entry WHERE folder_path = ?1",
                    params![folder_path],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(Into::into)
            }
        })
        .await
        .context("count media entries task error")
    }

    pub async fn save_preview(
        &self,
        path: String,
        preview_limit: i64,
        stamp: String,
        payload_json: String,
    ) -> Result<()> {
        self.interact(move |conn| {
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
        .context("save preview task error")
    }

    pub async fn load_preview(
        &self,
        path: String,
        preview_limit: i64,
        stamp: String,
    ) -> Result<Option<String>> {
        self.interact(move |conn| {
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
        .context("load preview task error")
    }

    pub async fn save_thumbnail_job(
        &self,
        source_path: String,
        source_modified_ms: i64,
        status: String,
        error: Option<String>,
    ) -> Result<()> {
        self.interact(move |conn| {
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
        .context("save thumbnail job task error")
    }

    pub async fn save_thumbnail_asset(
        &self,
        source_path: String,
        source_modified_ms: i64,
        output_path: String,
    ) -> Result<()> {
        self.interact(move |conn| {
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
        .context("save thumbnail asset task error")
    }

    pub async fn load_thumbnail_asset(
        &self,
        source_path: String,
        source_modified_ms: i64,
    ) -> Result<Option<String>> {
        self.interact(move |conn| {
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
        .context("load thumbnail asset task error")
    }

    pub async fn load_thumbnail_job(
        &self,
        source_path: String,
        source_modified_ms: i64,
    ) -> Result<Option<PersistedThumbnailJobRecord>> {
        self.interact(move |conn| {
            conn.query_row(
                "SELECT status, error, updated_at FROM thumbnail_job
                 WHERE source_path = ?1 AND source_modified_ms = ?2",
                params![source_path, source_modified_ms],
                |row| {
                    Ok(PersistedThumbnailJobRecord {
                        status: row.get::<_, String>(0)?,
                        error: row.get::<_, Option<String>>(1)?,
                        updated_at: row.get::<_, i64>(2)?,
                    })
                },
            )
            .optional()
            .map_err(Into::into)
        })
        .await
        .context("load thumbnail job task error")
    }

    pub async fn put_runtime_meta(&self, key: String, value: String) -> Result<()> {
        self.interact(move |conn| {
            conn.execute(
                "INSERT INTO runtime_meta (key, value, updated_at)
                 VALUES (?1, ?2, unixepoch('now') * 1000)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, value],
            )?;
            Ok(())
        })
        .await
        .context("put runtime meta task error")
    }

    pub async fn set_folder_favorite(&self, path: String, favorite: bool) -> Result<()> {
        self.interact(move |conn| {
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
        .context("set folder favorite task error")
    }

    pub async fn is_folder_favorite(&self, path: String) -> Result<bool> {
        self.interact(move |conn| {
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
        .context("is folder favorite task error")
    }

    pub async fn load_all_folder_favorites(&self) -> Result<Vec<String>> {
        self.interact(move |conn| {
            let mut stmt = conn
                .prepare("SELECT path FROM folder_favorite ORDER BY updated_at DESC, path ASC")?;
            let favorites = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(anyhow::Error::from)?;
            Ok(favorites)
        })
        .await
        .context("load all folder favorites task error")
    }

    pub async fn save_viewer_preferences(&self, payload_json: String) -> Result<()> {
        self.interact(move |conn| {
            conn.execute(
                "INSERT INTO viewer_preferences (id, payload_json, updated_at)
                 VALUES (1, ?1, unixepoch('now') * 1000)
                 ON CONFLICT(id) DO UPDATE SET
                   payload_json = excluded.payload_json,
                   updated_at = excluded.updated_at",
                params![payload_json],
            )?;
            Ok(())
        })
        .await
        .context("save viewer preferences task error")
    }

    pub async fn load_viewer_preferences(&self) -> Result<Option<String>> {
        self.interact(move |conn| {
            conn.query_row(
                "SELECT payload_json FROM viewer_preferences WHERE id = 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(Into::into)
        })
        .await
        .context("load viewer preferences task error")
    }

    fn init_schema(conn: &Connection) -> Result<()> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS folder_manifest (
              path TEXT PRIMARY KEY,
              stamp TEXT NOT NULL,
              root_modified INTEGER NOT NULL,
              media_total INTEGER NOT NULL DEFAULT 0,
              image_total INTEGER NOT NULL DEFAULT 0,
              gif_total INTEGER NOT NULL DEFAULT 0,
              video_total INTEGER NOT NULL DEFAULT 0,
              subfolders_json TEXT NOT NULL,
              watched_dirs_json TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS media_entry (
              folder_path TEXT NOT NULL,
              ordinal INTEGER NOT NULL,
              media_path TEXT NOT NULL,
              filter_group TEXT NOT NULL DEFAULT 'image',
              name TEXT NOT NULL DEFAULT '',
              kind TEXT NOT NULL,
              sort_ts_ms INTEGER NOT NULL DEFAULT 0,
              modified INTEGER NOT NULL,
              size INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY (folder_path, media_path)
            );
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
            CREATE TABLE IF NOT EXISTS viewer_preferences (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              payload_json TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            ",
        )?;
        ensure_folder_manifest_v6_shape(conn)?;
        ensure_manifest_counts_columns(conn)?;
        ensure_media_entry_filter_group_column(conn)?;
        ensure_media_entry_name_column(conn)?;
        ensure_media_entry_sort_ts_ms_column(conn)?;
        ensure_media_entry_v5_identity(conn)?;
        ensure_media_entry_indexes(conn)?;
        conn.execute(
            "INSERT INTO runtime_meta (key, value, updated_at)
             VALUES ('schema_version', ?1, unixepoch('now') * 1000)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
    }
}

fn configure_connection(conn: &mut Connection) -> rusqlite::Result<()> {
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

fn ensure_folder_manifest_v6_shape(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(folder_manifest)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let has_required_columns = [
        "path",
        "stamp",
        "root_modified",
        "media_total",
        "image_total",
        "gif_total",
        "video_total",
        "subfolders_json",
        "watched_dirs_json",
        "updated_at",
    ]
    .iter()
    .all(|required| columns.iter().any(|column| column == required));
    let has_legacy_columns = ["media_json", "media_bin", "default_page_media_json"]
        .iter()
        .any(|legacy| columns.iter().any(|column| column == legacy));

    if has_required_columns && !has_legacy_columns {
        return Ok(());
    }

    let media_total_expr = if columns.iter().any(|column| column == "media_total") {
        "media_total"
    } else {
        "0"
    };
    let image_total_expr = if columns.iter().any(|column| column == "image_total") {
        "image_total"
    } else {
        "0"
    };
    let gif_total_expr = if columns.iter().any(|column| column == "gif_total") {
        "gif_total"
    } else {
        "0"
    };
    let video_total_expr = if columns.iter().any(|column| column == "video_total") {
        "video_total"
    } else {
        "0"
    };

    conn.execute_batch(
        "
        CREATE TABLE folder_manifest_v6 (
          path TEXT PRIMARY KEY,
          stamp TEXT NOT NULL,
          root_modified INTEGER NOT NULL,
          media_total INTEGER NOT NULL DEFAULT 0,
          image_total INTEGER NOT NULL DEFAULT 0,
          gif_total INTEGER NOT NULL DEFAULT 0,
          video_total INTEGER NOT NULL DEFAULT 0,
          subfolders_json TEXT NOT NULL,
          watched_dirs_json TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        ",
    )?;
    conn.execute(
        &format!(
            "INSERT INTO folder_manifest_v6 (
               path, stamp, root_modified, media_total, image_total, gif_total, video_total,
               subfolders_json, watched_dirs_json, updated_at
             )
             SELECT
               path, stamp, root_modified, {media_total_expr}, {image_total_expr},
               {gif_total_expr}, {video_total_expr}, subfolders_json, watched_dirs_json, updated_at
             FROM folder_manifest"
        ),
        [],
    )?;
    conn.execute_batch(
        "
        DROP TABLE folder_manifest;
        ALTER TABLE folder_manifest_v6 RENAME TO folder_manifest;
        ",
    )?;
    Ok(())
}

fn ensure_manifest_counts_columns(conn: &Connection) -> Result<()> {
    for (column, default_value) in [
        ("media_total", "0"),
        ("image_total", "0"),
        ("gif_total", "0"),
        ("video_total", "0"),
    ] {
        let mut stmt = conn.prepare("PRAGMA table_info(folder_manifest)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if columns.iter().any(|existing| existing == column) {
            continue;
        }

        conn.execute(
            &format!(
                "ALTER TABLE folder_manifest ADD COLUMN {column} INTEGER NOT NULL DEFAULT {default_value}"
            ),
            [],
        )?;
    }
    Ok(())
}

fn ensure_media_entry_filter_group_column(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(media_entry)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if columns.iter().any(|column| column == "filter_group") {
        return Ok(());
    }

    conn.execute(
        "ALTER TABLE media_entry ADD COLUMN filter_group TEXT NOT NULL DEFAULT 'image'",
        [],
    )?;
    Ok(())
}

fn ensure_media_entry_name_column(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(media_entry)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if columns.iter().any(|column| column == "name") {
        return Ok(());
    }

    conn.execute(
        "ALTER TABLE media_entry ADD COLUMN name TEXT NOT NULL DEFAULT ''",
        [],
    )?;
    Ok(())
}

fn ensure_media_entry_sort_ts_ms_column(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(media_entry)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if columns.iter().any(|column| column == "sort_ts_ms") {
        return Ok(());
    }

    conn.execute(
        "ALTER TABLE media_entry ADD COLUMN sort_ts_ms INTEGER NOT NULL DEFAULT 0",
        [],
    )?;
    Ok(())
}

fn ensure_media_entry_v5_identity(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(media_entry)")?;
    let columns = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let pk_column = |position| {
        columns
            .iter()
            .find_map(|(name, pk)| (*pk == position).then_some(name.as_str()))
    };
    let uses_v5_identity =
        pk_column(1) == Some("folder_path") && pk_column(2) == Some("media_path");
    if uses_v5_identity {
        return Ok(());
    }

    conn.execute_batch(
        "
        CREATE TABLE media_entry_v5 (
          folder_path TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          media_path TEXT NOT NULL,
          filter_group TEXT NOT NULL DEFAULT 'image',
          name TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL,
          sort_ts_ms INTEGER NOT NULL DEFAULT 0,
          modified INTEGER NOT NULL,
          size INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          PRIMARY KEY (folder_path, media_path)
        );
        INSERT OR IGNORE INTO media_entry_v5 (
          folder_path,
          ordinal,
          media_path,
          filter_group,
          name,
          kind,
          sort_ts_ms,
          modified,
          size,
          payload_json
        )
        SELECT
          folder_path,
          ordinal,
          media_path,
          filter_group,
          name,
          kind,
          sort_ts_ms,
          modified,
          size,
          payload_json
        FROM media_entry
        ORDER BY folder_path ASC, ordinal ASC;
        DROP TABLE media_entry;
        ALTER TABLE media_entry_v5 RENAME TO media_entry;
        ",
    )
    .map_err(|error| anyhow!("migrate media_entry to v5 identity: {error}"))?;

    Ok(())
}

fn ensure_media_entry_indexes(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_entry_folder_path ON media_entry (folder_path)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_entry_folder_group_sort
         ON media_entry (folder_path, filter_group, sort_ts_ms, name, media_path)",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_media_entry_folder_sort
         ON media_entry (folder_path, sort_ts_ms, name, media_path)",
        [],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{IndexStore, PersistedMediaRecord, SaveManifestInput};
    use rusqlite::Connection;
    use tempfile::tempdir;

    #[tokio::test]
    async fn opens_connections_with_wal_enabled() {
        let temp = tempdir().expect("tempdir");
        let store = IndexStore::new(temp.path()).await.expect("store");
        let conn_a = store.pool.get().await.expect("conn a");
        let conn_b = store.pool.get().await.expect("conn b");

        let read_pragmas = |conn: deadpool_sqlite::Connection| async move {
            conn.interact(|conn| {
                let jm = conn
                    .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
                    .expect("journal mode");
                let wac = conn
                    .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get::<_, i64>(0))
                    .expect("wal autocheckpoint");
                let busy_timeout = conn
                    .query_row("PRAGMA busy_timeout", [], |row| row.get::<_, i64>(0))
                    .expect("busy timeout");
                (jm, wac, busy_timeout)
            })
            .await
            .expect("read pragmas")
        };

        let (pragmas_a, pragmas_b) = tokio::join!(read_pragmas(conn_a), read_pragmas(conn_b));

        for (journal_mode, wal_autocheckpoint, busy_timeout) in [pragmas_a, pragmas_b] {
            assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
            assert_eq!(wal_autocheckpoint, 1000);
            assert_eq!(busy_timeout, 5000);
        }
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
                media_total: 1,
                image_total: 1,
                gif_total: 0,
                video_total: 0,
                media: vec![PersistedMediaRecord {
                    ordinal: 0,
                    media_path: "alpha/image.jpg".to_string(),
                    filter_group: "image".to_string(),
                    name: "image.jpg".to_string(),
                    kind: "image".to_string(),
                    sort_ts_ms: 123_000,
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
        assert_eq!(manifest.media_total, 1);
        assert_eq!(manifest.image_total, 1);

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
    async fn migrates_v3_schema_to_v6_columns() {
        let temp = tempdir().expect("tempdir");
        let db_path = temp.path().join("tmv-index.sqlite3");
        let conn = Connection::open(&db_path).expect("open sqlite");
        conn.execute_batch(
            "
            CREATE TABLE folder_manifest (
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
            CREATE TABLE media_entry (
              folder_path TEXT NOT NULL,
              ordinal INTEGER NOT NULL,
              media_path TEXT NOT NULL,
              kind TEXT NOT NULL,
              modified INTEGER NOT NULL,
              size INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY (folder_path, ordinal)
            );
            CREATE TABLE runtime_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            INSERT INTO runtime_meta (key, value, updated_at)
            VALUES ('schema_version', '3', 0);
            ",
        )
        .expect("seed v3 schema");
        drop(conn);

        let store = IndexStore::new(temp.path()).await.expect("migrate store");
        let columns = store
            .interact(|conn| {
                let mut manifest_stmt = conn.prepare("PRAGMA table_info(folder_manifest)")?;
                let manifest_columns = manifest_stmt
                    .query_map([], |row| row.get::<_, String>(1))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let mut media_stmt = conn.prepare("PRAGMA table_info(media_entry)")?;
                let media_columns = media_stmt
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(1)?, row.get::<_, i64>(5)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok((manifest_columns, media_columns))
            })
            .await
            .expect("load migrated columns");

        assert!(columns.0.contains(&"media_total".to_string()));
        assert!(columns.0.contains(&"image_total".to_string()));
        assert!(columns.0.contains(&"gif_total".to_string()));
        assert!(columns.0.contains(&"video_total".to_string()));
        assert!(!columns.0.contains(&"media_json".to_string()));
        assert!(!columns.0.contains(&"media_bin".to_string()));
        assert!(!columns.0.contains(&"default_page_media_json".to_string()));
        assert!(columns.1.iter().any(|(name, _)| name == "filter_group"));
        assert!(columns.1.iter().any(|(name, _)| name == "name"));
        assert!(columns.1.iter().any(|(name, _)| name == "sort_ts_ms"));
        assert!(columns
            .1
            .iter()
            .any(|(name, pk)| name == "folder_path" && *pk == 1));
        assert!(columns
            .1
            .iter()
            .any(|(name, pk)| name == "media_path" && *pk == 2));
    }

    #[tokio::test]
    async fn migrates_v5_manifest_schema_to_v6_without_losing_data() {
        let temp = tempdir().expect("tempdir");
        let db_path = temp.path().join("tmv-index.sqlite3");
        let conn = Connection::open(&db_path).expect("open sqlite");
        conn.execute_batch(
            "
            CREATE TABLE folder_manifest (
              path TEXT PRIMARY KEY,
              stamp TEXT NOT NULL,
              root_modified INTEGER NOT NULL,
              media_total INTEGER NOT NULL DEFAULT 0,
              image_total INTEGER NOT NULL DEFAULT 0,
              gif_total INTEGER NOT NULL DEFAULT 0,
              video_total INTEGER NOT NULL DEFAULT 0,
              subfolders_json TEXT NOT NULL,
              watched_dirs_json TEXT NOT NULL,
              media_json TEXT NOT NULL DEFAULT '[]',
              media_bin BLOB,
              default_page_media_json TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE media_entry (
              folder_path TEXT NOT NULL,
              ordinal INTEGER NOT NULL,
              media_path TEXT NOT NULL,
              filter_group TEXT NOT NULL DEFAULT 'image',
              name TEXT NOT NULL DEFAULT '',
              kind TEXT NOT NULL,
              sort_ts_ms INTEGER NOT NULL DEFAULT 0,
              modified INTEGER NOT NULL,
              size INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY (folder_path, media_path)
            );
            CREATE TABLE runtime_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            INSERT INTO runtime_meta (key, value, updated_at)
            VALUES ('schema_version', '5', 0);
            INSERT INTO folder_manifest (
              path, stamp, root_modified, media_total, image_total, gif_total, video_total,
              subfolders_json, watched_dirs_json, media_json, media_bin, default_page_media_json, updated_at
            ) VALUES (
              'alpha', 'stamp-v5', 123, 4, 3, 0, 1, '[]', '[]', '[1]', X'00', '[2]', 456
            );
            INSERT INTO media_entry (
              folder_path, ordinal, media_path, filter_group, name, kind, sort_ts_ms, modified, size, payload_json
            ) VALUES (
              'alpha', 0, 'alpha/a.jpg', 'image', 'a.jpg', 'image', 99, 99, 99, '{\"path\":\"alpha/a.jpg\"}'
            );
            ",
        )
        .expect("seed v5 schema");
        drop(conn);

        let store = IndexStore::new(temp.path()).await.expect("migrate store");
        let (columns, manifest, media_rows) = store
            .interact(|conn| {
                let mut manifest_stmt = conn.prepare("PRAGMA table_info(folder_manifest)")?;
                let manifest_columns = manifest_stmt
                    .query_map([], |row| row.get::<_, String>(1))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let manifest = conn.query_row(
                    "SELECT path, stamp, root_modified, media_total, image_total, gif_total, video_total, subfolders_json, watched_dirs_json
                     FROM folder_manifest
                     WHERE path = 'alpha'",
                    [],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                        ))
                    },
                )?;
                let mut media_stmt = conn.prepare(
                    "SELECT folder_path, ordinal, media_path
                     FROM media_entry
                     WHERE folder_path = 'alpha'",
                )?;
                let media_rows = media_stmt
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok((manifest_columns, manifest, media_rows))
            })
            .await
            .expect("read migrated schema");

        assert!(!columns.contains(&"media_json".to_string()));
        assert!(!columns.contains(&"media_bin".to_string()));
        assert!(!columns.contains(&"default_page_media_json".to_string()));
        assert_eq!(
            manifest,
            (
                "alpha".to_string(),
                "stamp-v5".to_string(),
                123,
                4,
                3,
                0,
                1,
                "[]".to_string(),
                "[]".to_string(),
            )
        );
        assert_eq!(
            media_rows,
            vec![("alpha".to_string(), 0, "alpha/a.jpg".to_string())]
        );
    }

    #[tokio::test]
    async fn migrates_media_entry_identity_without_losing_first_duplicate() {
        let temp = tempdir().expect("tempdir");
        let db_path = temp.path().join("tmv-index.sqlite3");
        let conn = Connection::open(&db_path).expect("open sqlite");
        conn.execute_batch(
            "
            CREATE TABLE folder_manifest (
              path TEXT PRIMARY KEY,
              stamp TEXT NOT NULL,
              root_modified INTEGER NOT NULL,
              media_total INTEGER NOT NULL DEFAULT 0,
              image_total INTEGER NOT NULL DEFAULT 0,
              gif_total INTEGER NOT NULL DEFAULT 0,
              video_total INTEGER NOT NULL DEFAULT 0,
              subfolders_json TEXT NOT NULL,
              watched_dirs_json TEXT NOT NULL,
              media_json TEXT NOT NULL DEFAULT '[]',
              media_bin BLOB,
              default_page_media_json TEXT,
              updated_at INTEGER NOT NULL
            );
            CREATE TABLE media_entry (
              folder_path TEXT NOT NULL,
              ordinal INTEGER NOT NULL,
              media_path TEXT NOT NULL,
              filter_group TEXT NOT NULL DEFAULT 'image',
              name TEXT NOT NULL DEFAULT '',
              kind TEXT NOT NULL,
              sort_ts_ms INTEGER NOT NULL DEFAULT 0,
              modified INTEGER NOT NULL,
              size INTEGER NOT NULL,
              payload_json TEXT NOT NULL,
              PRIMARY KEY (folder_path, ordinal)
            );
            CREATE TABLE runtime_meta (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            INSERT INTO runtime_meta (key, value, updated_at)
            VALUES ('schema_version', '4', 0);
            INSERT INTO media_entry (
              folder_path, ordinal, media_path, filter_group, name, kind, sort_ts_ms, modified, size, payload_json
            ) VALUES
              ('alpha', 0, 'alpha/a.jpg', 'image', 'a.jpg', 'image', 30, 30, 30, '{\"path\":\"alpha/a.jpg\",\"name\":\"a.jpg\"}'),
              ('alpha', 1, 'alpha/a.jpg', 'image', 'a-newer.jpg', 'image', 20, 20, 20, '{\"path\":\"alpha/a.jpg\",\"name\":\"a-newer.jpg\"}'),
              ('alpha', 2, 'alpha/b.jpg', 'image', 'b.jpg', 'image', 10, 10, 10, '{\"path\":\"alpha/b.jpg\",\"name\":\"b.jpg\"}');
            ",
        )
        .expect("seed v4 schema");
        drop(conn);

        let store = IndexStore::new(temp.path()).await.expect("migrate store");
        let migrated_rows = store
            .interact(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT ordinal, media_path, name
                     FROM media_entry
                     WHERE folder_path = 'alpha'
                     ORDER BY ordinal ASC",
                )?;
                let rows = stmt
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows)
            })
            .await
            .expect("load migrated rows");

        assert_eq!(
            migrated_rows,
            vec![
                (0, "alpha/a.jpg".to_string(), "a.jpg".to_string()),
                (2, "alpha/b.jpg".to_string(), "b.jpg".to_string()),
            ]
        );
    }

    #[tokio::test]
    async fn save_manifest_updates_in_place_and_deletes_removed_rows() {
        let temp = tempdir().expect("tempdir");
        let store = IndexStore::new(temp.path()).await.expect("store");

        let make_record = |ordinal: i64, media_path: &str, size: i64| PersistedMediaRecord {
            ordinal,
            media_path: media_path.to_string(),
            filter_group: "image".to_string(),
            name: media_path
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_string(),
            kind: "image".to_string(),
            sort_ts_ms: size,
            modified: size as f64,
            size,
            payload_json: format!("{{\"path\":\"{media_path}\",\"size\":{size}}}"),
        };

        store
            .save_manifest(SaveManifestInput {
                path: "alpha".to_string(),
                stamp: "stamp-1".to_string(),
                root_modified: 1.0,
                media_total: 2,
                image_total: 2,
                gif_total: 0,
                video_total: 0,
                subfolders_json: "[]".to_string(),
                watched_dirs_json: "[]".to_string(),
                media: vec![
                    make_record(0, "alpha/a.jpg", 100),
                    make_record(1, "alpha/b.jpg", 50),
                ],
            })
            .await
            .expect("save first manifest");

        let initial_rowid = store
            .interact(|conn| {
                conn.query_row(
                    "SELECT rowid FROM media_entry
                     WHERE folder_path = 'alpha' AND media_path = 'alpha/a.jpg'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(Into::into)
            })
            .await
            .expect("load initial rowid");

        store
            .save_manifest(SaveManifestInput {
                path: "alpha".to_string(),
                stamp: "stamp-2".to_string(),
                root_modified: 2.0,
                media_total: 2,
                image_total: 2,
                gif_total: 0,
                video_total: 0,
                subfolders_json: "[]".to_string(),
                watched_dirs_json: "[]".to_string(),
                media: vec![
                    make_record(0, "alpha/a.jpg", 200),
                    make_record(1, "alpha/c.jpg", 25),
                ],
            })
            .await
            .expect("save second manifest");

        let (rowid_after_update, remaining_rows) = store
            .interact(|conn| {
                let rowid = conn.query_row(
                    "SELECT rowid FROM media_entry
                     WHERE folder_path = 'alpha' AND media_path = 'alpha/a.jpg'",
                    [],
                    |row| row.get::<_, i64>(0),
                )?;
                let mut stmt = conn.prepare(
                    "SELECT media_path, size
                     FROM media_entry
                     WHERE folder_path = 'alpha'
                     ORDER BY ordinal ASC",
                )?;
                let rows = stmt
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok((rowid, rows))
            })
            .await
            .expect("load updated rows");

        assert_eq!(rowid_after_update, initial_rowid);
        assert_eq!(
            remaining_rows,
            vec![
                ("alpha/a.jpg".to_string(), 200),
                ("alpha/c.jpg".to_string(), 25),
            ]
        );
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

    #[tokio::test]
    async fn persists_viewer_preferences_roundtrip() {
        let temp = tempdir().expect("tempdir");
        let store = IndexStore::new(temp.path()).await.expect("store");

        store
            .save_viewer_preferences(
                serde_json::json!({
                    "search": "beta",
                    "sortMode": "favorite",
                    "randomSeed": 7,
                    "mediaSort": "random",
                    "mediaRandomSeed": 11,
                    "mediaFilter": "video",
                    "categoryPath": "beta",
                    "theme": "dark",
                    "manualTheme": true,
                    "effectsMode": "full",
                    "effectsRenderer": "canvas2d",
                })
                .to_string(),
            )
            .await
            .expect("save viewer preferences");

        let payload = store
            .load_viewer_preferences()
            .await
            .expect("load viewer preferences")
            .expect("viewer preferences payload");
        let parsed: serde_json::Value =
            serde_json::from_str(&payload).expect("parse viewer preferences payload");

        assert_eq!(parsed["search"], "beta");
        assert_eq!(parsed["sortMode"], "favorite");
        assert_eq!(parsed["effectsRenderer"], "canvas2d");
    }
}
