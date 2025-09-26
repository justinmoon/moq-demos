use bytes::Bytes;
use tokio::sync::broadcast;

use crate::codec::Codec;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackKind {
    Audio,
}

#[derive(Debug)]
pub struct MediaTrack {
    receiver: broadcast::Receiver<MediaFrame>,
    codec: Codec,
    kind: TrackKind,
}

impl Clone for MediaTrack {
    fn clone(&self) -> Self {
        Self {
            receiver: self.receiver.resubscribe(),
            codec: self.codec,
            kind: self.kind,
        }
    }
}

impl MediaTrack {
    pub fn new(receiver: broadcast::Receiver<MediaFrame>, codec: Codec, kind: TrackKind) -> Self {
        Self {
            receiver,
            codec,
            kind,
        }
    }

    pub async fn recv(&mut self) -> Result<MediaFrame, broadcast::error::RecvError> {
        self.receiver.recv().await
    }

    pub fn try_recv(&mut self) -> Result<MediaFrame, broadcast::error::TryRecvError> {
        self.receiver.try_recv()
    }

    pub fn codec(&self) -> Codec {
        self.codec
    }
}

#[derive(Debug, Clone)]
pub struct MediaFrame {
    pub payload: Bytes,
    #[allow(dead_code)]
    pub sample_count: Option<u32>,
    pub skipped_frames: Option<u32>,
    #[allow(dead_code)]
    pub skipped_samples: Option<u32>,
}
