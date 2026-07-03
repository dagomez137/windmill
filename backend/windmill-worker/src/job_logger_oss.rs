#[cfg(feature = "private")]
#[allow(unused)]
pub use crate::job_logger_ee::*;

#[cfg(not(feature = "private"))]
use {
    crate::job_logger::CompactLogs, std::io, std::sync::atomic::AtomicU32, std::sync::Arc,
    uuid::Uuid, windmill_common::DB,
};

#[cfg(all(feature = "enterprise", feature = "parquet", not(feature = "private")))]
pub(crate) async fn s3_storage(
    _job_id: &Uuid,
    _w_id: &str,
    _db: &sqlx::Pool<sqlx::Postgres>,
    _logs: &str,
    _total_size: Arc<AtomicU32>,
    _worker_name: &str,
) {
    tracing::info!("Logs length of {_job_id} has exceeded a threshold. Implementation to store excess on s3 in not OSS");
}

/// Store a job's compacted logs on local disk, in the layout the reading side
/// already serves (`get_logs_from_disk` streams every `log_file_index` entry
/// under `WINDMILL_DIR` and then the database tail; `get_log_file` serves one
/// `logs/<job>/<n>.txt` entry). The accumulated database logs plus the current
/// batch move into a new indexed file, and the row keeps the moved-out length
/// in `log_offset` and the file list in `log_file_index`. Without this, any
/// job whose output crosses the compaction threshold silently loses that
/// batch, which for a log-streaming job means most of its stream. On any disk
/// or database failure the batch is appended back to the database row instead,
/// so output is never dropped.
#[cfg(not(feature = "private"))]
pub(crate) async fn default_disk_log_storage(
    job_id: &Uuid,
    w_id: &str,
    db: &DB,
    logs: &str,
    total_size: Arc<AtomicU32>,
    _compact_kind: CompactLogs,
    _worker_name: &str,
) {
    use sqlx::Row;
    use std::sync::atomic::Ordering;
    use windmill_common::worker::WINDMILL_DIR;

    let job_id = *job_id;
    let res: Result<(), String> = async {
        let row = sqlx::query(
            "SELECT logs, log_offset, log_file_index FROM job_logs \
             WHERE job_id = $1 AND workspace_id = $2",
        )
        .bind(job_id)
        .bind(w_id)
        .fetch_optional(db)
        .await
        .map_err(|e| format!("reading job_logs: {e}"))?;

        let (prev_logs, prev_offset, mut file_index) = row
            .map(|r| {
                (
                    r.try_get::<Option<String>, _>("logs")
                        .ok()
                        .flatten()
                        .unwrap_or_default(),
                    r.try_get::<Option<i32>, _>("log_offset")
                        .ok()
                        .flatten()
                        .unwrap_or(0),
                    r.try_get::<Option<Vec<String>>, _>("log_file_index")
                        .ok()
                        .flatten()
                        .unwrap_or_default(),
                )
            })
            .unwrap_or_default();

        let combined = format!("{prev_logs}{logs}");
        let rel = format!("logs/{job_id}/{}.txt", file_index.len() + 1);
        let abs = format!("{}/{rel}", *WINDMILL_DIR);
        let parent = std::path::Path::new(&abs)
            .parent()
            .ok_or_else(|| "log file path has no parent".to_string())?
            .to_path_buf();
        tokio::fs::create_dir_all(&parent)
            .await
            .map_err(|e| format!("creating {}: {e}", parent.display()))?;
        tokio::fs::write(&abs, combined.as_bytes())
            .await
            .map_err(|e| format!("writing {abs}: {e}"))?;

        // log_offset counts characters no longer in the database row, matching
        // the char-based length() the append paths compare against.
        let new_offset = prev_offset + combined.chars().count() as i32;
        file_index.push(rel.clone());
        sqlx::query(
            "INSERT INTO job_logs (logs, job_id, workspace_id, log_offset, log_file_index) \
             VALUES ('', $1, $2, $3, $4) \
             ON CONFLICT (job_id) DO UPDATE \
             SET logs = '', log_offset = $3, log_file_index = $4",
        )
        .bind(job_id)
        .bind(w_id)
        .bind(new_offset)
        .bind(&file_index)
        .execute(db)
        .await
        .map_err(|e| format!("updating job_logs: {e}"))?;

        total_size.store(0, Ordering::SeqCst);
        tracing::info!(%job_id, "compacted job logs to disk at {rel}");
        Ok(())
    }
    .await;

    if let Err(reason) = res {
        tracing::error!(
            %job_id,
            "storing compacted logs on disk failed ({reason}); appending to the database instead"
        );
        if let Err(err) = sqlx::query(
            "INSERT INTO job_logs (logs, job_id, workspace_id) VALUES ($1, $2, $3) \
             ON CONFLICT (job_id) DO UPDATE SET logs = concat(job_logs.logs, EXCLUDED.logs)",
        )
        .bind(logs)
        .bind(job_id)
        .bind(w_id)
        .execute(db)
        .await
        {
            tracing::error!(%job_id, %err, "fallback append failed for job {job_id}");
        }
    }
}

#[cfg(not(feature = "private"))]
pub(crate) fn process_streaming_log_lines(
    r: Result<Option<String>, io::Error>,
    _stderr: bool,
    _job_id: &Uuid,
    _w_id: &str,
) -> Option<Result<String, io::Error>> {
    r.transpose()
}
