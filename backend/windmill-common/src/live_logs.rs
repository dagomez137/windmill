//! Live job output. A worker tees each log line to the API server as it reads it,
//! ahead of the batched `job_logs` write, and the server fans it out to
//! subscribers of the job and of its root flow. The stored log stays the source of
//! truth: frames are best effort, and every `offset` is a position in that stored
//! log, so a subscriber repairs any loss from it.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// One line of the worker's publish stream (newline-delimited JSON).
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PublishFrame {
    /// `text` exactly as appended to the job's log, starting at character `offset`
    /// of the whole log (`job_logs.log_offset + char_length(job_logs.logs)`).
    Log {
        offset: i64,
        text: String,
    },
    /// The worker dropped frames since the previous one.
    Gap,
    /// `wmill.set_progress`, as a percentage.
    Progress {
        percent: i32,
    },
    End {
        success: bool,
    },
}

/// One server-sent event of a live subscription.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LiveEvent {
    Start {
        job: Uuid,
        parent: Option<Uuid>,
        root: Uuid,
        step: Option<String>,
        path: Option<String>,
        kind: String,
        /// The worker running the job, and the host it runs on.
        worker: Option<String>,
        hostname: Option<String>,
    },
    Log {
        job: Uuid,
        offset: i64,
        text: String,
    },
    Gap {
        job: Uuid,
    },
    Progress {
        job: Uuid,
        percent: i32,
    },
    /// The status of `flow` (a flow or subflow under the subscribed root) changed:
    /// a step was queued, skipped or completed, or the flow itself finished.
    FlowChanged {
        flow: Uuid,
    },
    /// `success` is `None` when the publisher went away without reporting one.
    End {
        job: Uuid,
        success: Option<bool>,
    },
    /// The subscriber fell behind and missed events of any job.
    Lagged,
}

impl LiveEvent {
    pub fn job(&self) -> Option<Uuid> {
        match self {
            LiveEvent::Start { job, .. }
            | LiveEvent::Log { job, .. }
            | LiveEvent::Gap { job }
            | LiveEvent::Progress { job, .. }
            | LiveEvent::End { job, .. } => Some(*job),
            LiveEvent::FlowChanged { .. } | LiveEvent::Lagged => None,
        }
    }

    pub fn weight(&self) -> usize {
        match self {
            LiveEvent::Log { text, .. } => text.len() + 64,
            _ => 128,
        }
    }
}

type Sink = Box<dyn Fn(Uuid, PublishFrame) + Send + Sync>;

static SINK: std::sync::OnceLock<Sink> = std::sync::OnceLock::new();

/// Lets code that only knows a job id (the embedded API server a script calls)
/// reach the job's live stream, which the worker owns.
pub fn set_sink(sink: Sink) {
    let _ = SINK.set(sink);
}

pub fn emit(job: Uuid, frame: PublishFrame) {
    if let Some(sink) = SINK.get() {
        sink(job, frame);
    }
}
