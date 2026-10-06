//! Server side of live job output (see `windmill_common::live_logs`): an in-memory
//! hub with one channel per job and per root flow, fed by workers' publish streams
//! and read by SSE subscribers. Each channel keeps a bounded backlog, replayed to a
//! subscriber that attaches after output started.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::{
    body::Body,
    extract::{Path, Query},
    http::StatusCode,
    response::Response,
    Extension,
};
use futures::StreamExt;
use serde::Deserialize;
use sqlx::Row;
use tokio::sync::broadcast;
use uuid::Uuid;
use windmill_common::{
    db::UserDB,
    error::{self, Error},
    live_logs::{LiveEvent, PublishFrame},
    DB,
};

use crate::{db::ApiAuthed, users::OptAuthed};

const BACKLOG_BYTES: usize = 1 << 20;
const SUBSCRIBER_EVENTS: usize = 4096;
const KEEP_CLOSED: Duration = Duration::from_secs(120);
const KEEP_IDLE: Duration = Duration::from_secs(3600);
const PING: Duration = Duration::from_secs(15);

struct Backlog {
    events: VecDeque<Arc<LiveEvent>>,
    bytes: usize,
    closed: bool,
    touched: Instant,
}

struct Channel {
    tx: broadcast::Sender<Arc<LiveEvent>>,
    backlog: Mutex<Backlog>,
}

static HUB: LazyLock<Mutex<HashMap<Uuid, Arc<Channel>>>> = LazyLock::new(|| {
    tokio::spawn(async {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            if let Ok(mut hub) = HUB.lock() {
                hub.retain(|_, c| {
                    let b = c.backlog.lock().unwrap();
                    let idle = b.touched.elapsed();
                    !(b.closed && idle > KEEP_CLOSED || idle > KEEP_IDLE)
                });
            }
        }
    });
    Mutex::new(HashMap::new())
});

fn channel(id: Uuid) -> Arc<Channel> {
    HUB.lock()
        .unwrap()
        .entry(id)
        .or_insert_with(|| {
            Arc::new(Channel {
                tx: broadcast::channel(SUBSCRIBER_EVENTS).0,
                backlog: Mutex::new(Backlog {
                    events: VecDeque::new(),
                    bytes: 0,
                    closed: false,
                    touched: Instant::now(),
                }),
            })
        })
        .clone()
}

/// The backlog lock is held across the send so that a subscriber, which takes it to
/// subscribe and copy the backlog, sees every event exactly once.
fn publish(targets: &[Uuid], ev: LiveEvent, closes: Option<Uuid>) {
    let ev = Arc::new(ev);
    for id in targets {
        let c = channel(*id);
        let mut b = c.backlog.lock().unwrap();
        b.bytes += ev.weight();
        b.events.push_back(ev.clone());
        while b.bytes > BACKLOG_BYTES {
            match b.events.pop_front() {
                Some(old) => b.bytes -= old.weight(),
                None => break,
            }
        }
        b.touched = Instant::now();
        if closes == Some(*id) {
            b.closed = true;
        }
        let _ = c.tx.send(ev.clone());
    }
}

struct JobInfo {
    parent: Option<Uuid>,
    root: Uuid,
    step: Option<String>,
    path: Option<String>,
    kind: String,
    worker: Option<String>,
    hostname: Option<String>,
}

async fn job_info(db: &DB, w_id: &str, job_id: Uuid) -> error::Result<JobInfo> {
    let row = sqlx::query(
        "SELECT j.parent_job, COALESCE(j.root_job, j.flow_innermost_root_job, j.parent_job, j.id) AS root, \
         j.flow_step_id, j.runnable_path, j.kind::text AS kind, \
         COALESCE(q.worker, c.worker) AS worker, w.worker_instance AS hostname \
         FROM v2_job j \
         LEFT JOIN v2_job_queue q ON q.id = j.id \
         LEFT JOIN v2_job_completed c ON c.id = j.id \
         LEFT JOIN worker_ping w ON w.worker = COALESCE(q.worker, c.worker) \
         WHERE j.id = $1 AND j.workspace_id = $2",
    )
    .bind(job_id)
    .bind(w_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| Error::NotFound(format!("job {job_id} not found")))?;
    Ok(JobInfo {
        parent: row.try_get("parent_job")?,
        root: row.try_get("root")?,
        step: row.try_get("flow_step_id")?,
        path: row.try_get("runnable_path")?,
        kind: row.try_get("kind")?,
        worker: row.try_get("worker")?,
        hostname: row.try_get("hostname")?,
    })
}

/// `POST /w/{w}/jobs_u/live/{id}/publish`: a worker's newline-delimited
/// `PublishFrame` stream for one job, accepted only with that job's own token.
pub async fn publish_stream(
    authed: ApiAuthed,
    Extension(db): Extension<DB>,
    Path((w_id, job_id)): Path<(String, Uuid)>,
    body: Body,
) -> error::Result<StatusCode> {
    if authed.job_id != Some(job_id) {
        return Err(Error::NotAuthorized(
            "live output is published with the job's own token".to_string(),
        ));
    }
    let info = job_info(&db, &w_id, job_id).await?;
    let mut targets = vec![job_id];
    if info.root != job_id {
        targets.push(info.root);
    }
    publish(
        &targets,
        LiveEvent::Start {
            job: job_id,
            parent: info.parent,
            root: info.root,
            step: info.step,
            path: info.path,
            kind: info.kind,
            worker: info.worker,
            hostname: info.hostname,
        },
        None,
    );

    let mut ended = false;
    let mut buf: Vec<u8> = Vec::new();
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk);
        while let Some(nl) = buf.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buf.drain(..=nl).collect();
            let ev = match serde_json::from_slice::<PublishFrame>(&line[..nl]) {
                Ok(PublishFrame::Log { offset, text }) => {
                    LiveEvent::Log { job: job_id, offset, text }
                }
                Ok(PublishFrame::Gap) => LiveEvent::Gap { job: job_id },
                Ok(PublishFrame::Progress { percent }) => {
                    LiveEvent::Progress { job: job_id, percent }
                }
                Ok(PublishFrame::End { success }) => {
                    ended = true;
                    LiveEvent::End { job: job_id, success: Some(success) }
                }
                Err(e) => {
                    tracing::warn!(%job_id, %e, "malformed live log frame");
                    continue;
                }
            };
            publish(&targets, ev, ended.then_some(job_id));
        }
    }
    if !ended {
        publish(
            &targets,
            LiveEvent::End { job: job_id, success: None },
            Some(job_id),
        );
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn root_of(db: &DB, w_id: &str, job_id: Uuid) -> error::Result<Option<Uuid>> {
    Ok(sqlx::query_scalar::<_, Uuid>(
        "SELECT COALESCE(root_job, flow_innermost_root_job, parent_job, id) \
         FROM v2_job WHERE id = $1 AND workspace_id = $2",
    )
    .bind(job_id)
    .bind(w_id)
    .fetch_optional(db)
    .await?)
}

/// `POST /w/{w}/jobs_u/live/{flow}/changed`: a worker reports that `flow`'s status
/// moved, with the token of any job under the same root.
pub async fn flow_changed(
    authed: ApiAuthed,
    Extension(db): Extension<DB>,
    Path((w_id, flow)): Path<(String, Uuid)>,
) -> error::Result<StatusCode> {
    let token_job = authed.job_id.ok_or_else(|| {
        Error::NotAuthorized("flow changes are reported with a job token".to_string())
    })?;
    let root = root_of(&db, &w_id, flow)
        .await?
        .ok_or_else(|| Error::NotFound(format!("job {flow} not found")))?;
    if root_of(&db, &w_id, token_job).await? != Some(root) {
        return Err(Error::NotAuthorized(format!(
            "job {token_job} is not under the root of {flow}"
        )));
    }
    let mut targets = vec![root];
    if flow != root {
        targets.push(flow);
    }
    publish(&targets, LiveEvent::FlowChanged { flow }, None);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct SubscribeQuery {
    /// Skip the backlog: only events published from now on.
    no_backlog: Option<bool>,
}

/// `GET /w/{w}/jobs_u/live/{id}`: server-sent `LiveEvent`s of the job and, for a
/// flow, of every job under it. The stream ends after the job's own `End`.
pub async fn subscribe(
    OptAuthed(opt_authed): OptAuthed,
    Extension(db): Extension<DB>,
    Extension(user_db): Extension<UserDB>,
    Path((w_id, job_id)): Path<(String, Uuid)>,
    Query(q): Query<SubscribeQuery>,
) -> error::Result<Response> {
    let authed =
        opt_authed.ok_or_else(|| Error::NotAuthorized("live output needs a login".to_string()))?;
    crate::jobs::require_job_update_read_access(&db, &user_db, &authed, &w_id, &job_id, None)
        .await?;

    let c = channel(job_id);
    let (backlog, mut rx, closed) = {
        let b = c.backlog.lock().unwrap();
        let backlog: Vec<Arc<LiveEvent>> = if q.no_backlog.unwrap_or(false) {
            vec![]
        } else {
            b.events.iter().cloned().collect()
        };
        (backlog, c.tx.subscribe(), b.closed)
    };

    let (tx, out) = tokio::sync::mpsc::channel::<String>(256);
    tokio::spawn(async move {
        let sse = |ev: &LiveEvent| {
            format!(
                "data: {}\n\n",
                serde_json::to_string(ev).unwrap_or_default()
            )
        };
        let is_own_end =
            |ev: &LiveEvent| matches!(ev, LiveEvent::End { job, .. } if *job == job_id);
        for ev in &backlog {
            if tx.send(sse(ev)).await.is_err() || is_own_end(ev) {
                return;
            }
        }
        if closed {
            return;
        }
        let mut ping = tokio::time::interval(PING);
        loop {
            tokio::select! {
                r = rx.recv() => match r {
                    Ok(ev) => {
                        if tx.send(sse(&ev)).await.is_err() || is_own_end(&ev) {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        if tx.send(sse(&LiveEvent::Lagged)).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                _ = ping.tick() => {
                    if tx.send(": ping\n\n".to_string()).await.is_err() {
                        return;
                    }
                }
            }
        }
    });

    let body = Body::from_stream(
        tokio_stream::wrappers::ReceiverStream::new(out)
            .map(Result::<_, std::convert::Infallible>::Ok),
    );
    Ok(Response::builder()
        .status(200)
        .header("X-Accel-Buffering", "no")
        .header("Content-Type", "text/event-stream")
        .header("Cache-Control", "no-cache")
        .body(body)
        .unwrap())
}
