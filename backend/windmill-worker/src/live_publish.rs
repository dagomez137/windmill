//! Worker side of live job output (see `windmill_common::live_logs`): one streamed
//! POST per job to `LIVE_LOGS_URL`, authenticated with the job's own token, fed by
//! a bounded channel that the log reader never waits on.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};

use futures::StreamExt;
use tokio::sync::mpsc;
use uuid::Uuid;
use windmill_common::live_logs::PublishFrame;
use windmill_common::utils::HTTP_CLIENT_STREAMING;
use windmill_common::worker::Connection;

static LIVE_LOGS_URL: LazyLock<Option<String>> = LazyLock::new(|| {
    std::env::var("LIVE_LOGS_URL")
        .ok()
        .map(|u| u.trim_end_matches('/').to_string())
        .filter(|u| !u.is_empty())
});

const QUEUE_FRAMES: usize = 4096;

static PUBLISHERS: LazyLock<Mutex<HashMap<Uuid, LivePublisher>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
pub struct LivePublisher {
    tx: mpsc::Sender<PublishFrame>,
    dropped: Arc<AtomicBool>,
}

impl LivePublisher {
    /// Never waits: a full queue drops the frame and the next one sent is a `Gap`.
    pub fn send(&self, frame: PublishFrame) {
        if self.dropped.load(Ordering::Relaxed) {
            if self.tx.try_send(PublishFrame::Gap).is_err() {
                return;
            }
            self.dropped.store(false, Ordering::Relaxed);
        }
        if let Err(mpsc::error::TrySendError::Full(_)) = self.tx.try_send(frame) {
            self.dropped.store(true, Ordering::Relaxed);
        }
    }
}

pub fn publisher(job_id: &Uuid) -> Option<LivePublisher> {
    if LIVE_LOGS_URL.is_none() {
        return None;
    }
    PUBLISHERS.lock().ok()?.get(job_id).cloned()
}

/// Ends the job's stream when finished or dropped; only `finish` reports a status.
pub struct LiveGuard {
    job_id: Uuid,
}

impl LiveGuard {
    pub fn finish(self, success: bool) {
        if let Some(p) = publisher(&self.job_id) {
            p.send(PublishFrame::End { success });
        }
    }
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = PUBLISHERS.lock() {
            map.remove(&self.job_id);
        }
    }
}

pub fn register(job_id: Uuid, w_id: &str, token: &str) -> Option<LiveGuard> {
    let base = LIVE_LOGS_URL.as_ref()?;
    if job_id.is_nil() || token.is_empty() {
        return None;
    }
    let (tx, rx) = mpsc::channel::<PublishFrame>(QUEUE_FRAMES);
    PUBLISHERS.lock().ok()?.insert(
        job_id,
        LivePublisher { tx, dropped: Arc::new(AtomicBool::new(false)) },
    );

    let url = format!("{base}/api/w/{w_id}/jobs_u/live/{job_id}/publish");
    let token = token.to_string();
    tokio::spawn(async move {
        let body = tokio_stream::wrappers::ReceiverStream::new(rx).map(|frame| {
            let mut line = serde_json::to_vec(&frame).unwrap_or_default();
            line.push(b'\n');
            Ok::<_, std::convert::Infallible>(line)
        });
        let res = HTTP_CLIENT_STREAMING
            .post(&url)
            .bearer_auth(token)
            .header("Content-Type", "application/x-ndjson")
            .body(reqwest::Body::wrap_stream(body))
            .send()
            .await;
        match res {
            Ok(r) if !r.status().is_success() => {
                tracing::warn!(%job_id, status = %r.status(), "live log publish refused")
            }
            Err(e) => tracing::warn!(%job_id, %e, "live log publish failed"),
            _ => {}
        }
    });
    Some(LiveGuard { job_id })
}

/// Where the next appended character lands in the job's whole log.
pub async fn log_end_offset(conn: &Connection, job_id: &Uuid) -> Option<i64> {
    let db = conn.as_sql()?;
    sqlx::query_scalar::<_, i64>(
        "SELECT (log_offset + COALESCE(char_length(logs), 0))::bigint FROM job_logs WHERE job_id = $1",
    )
    .bind(job_id)
    .fetch_optional(db)
    .await
    .map(|o| o.unwrap_or(0))
    .map_err(|e| tracing::warn!(%job_id, %e, "live log offset read failed"))
    .ok()
}
