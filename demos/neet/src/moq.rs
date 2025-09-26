use std::fmt;

use anyhow::{anyhow, Context, Result};
use moq_lite as moq;
use tokio::{select, sync::broadcast as chan};
use tracing::{debug, info, warn};
use url::Url;

use crate::{
    audio::AudioContext,
    codec::{opus::OpusChannels, Codec},
    media::{MediaFrame, MediaTrack, TrackKind},
};

/// Default namespace appended to the relay path before the session identifier.
const SESSION_NAMESPACE: &str = "neet";
const AUDIO_TRACK_NAME: &str = "audio";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Listener,
    Caller,
}

impl Role {
    fn publish_path(self) -> &'static str {
        match self {
            Role::Listener => "listener",
            Role::Caller => "caller",
        }
    }

    fn subscribe_path(self) -> &'static str {
        match self {
            Role::Listener => "caller",
            Role::Caller => "listener",
        }
    }

    fn remote_label(self) -> &'static str {
        match self {
            Role::Listener => "caller",
            Role::Caller => "listener",
        }
    }

    fn local_label(self) -> &'static str {
        match self {
            Role::Listener => "listener",
            Role::Caller => "caller",
        }
    }
}

#[derive(Clone)]
pub struct MoqOptions {
    pub relay_url: Url,
    pub session_id: String,
    pub role: Role,
}

impl fmt::Debug for MoqOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MoqOptions")
            .field("relay_url", &self.relay_url)
            .field("session_id", &self.session_id)
            .field("role", &self.role)
            .finish()
    }
}

pub async fn run_audio_session(options: MoqOptions, audio: AudioContext) -> Result<()> {
    let mut url = options.relay_url.clone();
    append_session_path(&mut url, &options.session_id).with_context(|| {
        format!(
            "failed to extend relay url with session '{}': {url}",
            options.session_id
        )
    })?;

    info!(role = ?options.role, %url, "connecting to relay");

    let client = moq_native::Client::new(moq_native::ClientConfig::default())
        .context("failed to build MoQ client")?;
    let connection = client
        .connect(url.clone())
        .await
        .context("failed to connect to relay")?;

    let moq::Produce {
        producer: publish_producer,
        consumer: publish_consumer,
    } = moq::Origin::produce();
    let moq::Produce {
        producer: subscribe_producer,
        consumer: subscribe_consumer,
    } = moq::Origin::produce();

    let session = moq::Session::connect(connection, publish_consumer, Some(subscribe_producer))
        .await
        .context("failed to establish MoQ session")?;

    // Start piping capture audio -> MoQ
    let publish_task = publish_audio(audio.clone(), options.role, publish_producer);

    // Start reading remote MoQ audio -> playback
    let subscribe_task = subscribe_audio(audio.clone(), options.role, subscribe_consumer);

    tokio::pin!(publish_task);
    tokio::pin!(subscribe_task);

    let session_closed = async { session.closed().await };
    tokio::pin!(session_closed);

    select! {
        res = &mut publish_task => {
            res.context("publish task failed")?
        }
        res = &mut subscribe_task => {
            res.context("subscribe task failed")?
        }
        err = &mut session_closed => {
            return Err(anyhow!("MoQ session closed: {err}"));
        }
    }

    Ok(())
}

fn append_session_path(url: &mut Url, session: &str) -> Result<()> {
    if session.is_empty() {
        return Err(anyhow!("session id must not be empty"));
    }

    let mut segments = url
        .path_segments_mut()
        .map_err(|_| anyhow!("relay URL cannot be a base"))?;
    if !SESSION_NAMESPACE.is_empty() {
        segments.push(SESSION_NAMESPACE);
    }
    segments.push(session);
    Ok(())
}

fn publish_audio(
    audio: AudioContext,
    role: Role,
    origin: moq::OriginProducer,
) -> impl std::future::Future<Output = Result<()>> {
    async move {
        let capture_track = audio
            .capture_track()
            .await
            .context("failed to create capture track")?;

        let mut broadcast = moq::Broadcast::produce();
        let track_producer = broadcast.producer.create_track(moq::Track {
            name: AUDIO_TRACK_NAME.to_string(),
            priority: 0,
        });

        let path = role.publish_path();
        let published = origin.publish_broadcast(path, broadcast.consumer.clone());
        if !published {
            warn!(%path, "broadcast already existed; replacing");
        }

        forward_media_to_moq(capture_track, track_producer).await?;

        Ok(())
    }
}

fn subscribe_audio(
    audio: AudioContext,
    role: Role,
    mut origin: moq::OriginConsumer,
) -> impl std::future::Future<Output = Result<()>> {
    async move {
        let target_path = role.subscribe_path();
        info!(
            local = role.local_label(),
            remote = role.remote_label(),
            target_path,
            "waiting for remote broadcast"
        );

        loop {
            if let Some(broadcast) = origin.consume_broadcast(target_path) {
                info!(target_path, "remote broadcast available; attaching");
                handle_remote_broadcast(audio.clone(), broadcast).await?;
                return Ok(());
            }

            match origin.announced().await {
                Some((path, Some(broadcast))) => {
                    let path_str = path.as_str();
                    debug!(%path_str, "received broadcast announcement");
                    if path_str == target_path {
                        handle_remote_broadcast(audio.clone(), broadcast).await?;
                        return Ok(());
                    }
                }
                Some((_path, None)) => {
                    // broadcast removed; keep waiting
                }
                None => {
                    return Err(anyhow!("announcement stream closed"));
                }
            }
        }
    }
}

async fn handle_remote_broadcast(
    audio: AudioContext,
    broadcast: moq::BroadcastConsumer,
) -> Result<()> {
    let track = moq::Track {
        name: AUDIO_TRACK_NAME.to_string(),
        priority: 0,
    };

    let track_consumer = broadcast.subscribe_track(&track);

    let (sender, receiver) = chan::channel::<MediaFrame>(32);
    let media_track = MediaTrack::new(
        receiver,
        Codec::Opus {
            channels: OpusChannels::Stereo,
        },
        TrackKind::Audio,
    );
    audio
        .play_track(media_track)
        .await
        .context("failed to add remote track to playback")?;

    forward_moq_to_media(track_consumer, sender).await?;

    Ok(())
}

async fn forward_media_to_moq(
    mut media_track: MediaTrack,
    mut track_producer: moq::TrackProducer,
) -> Result<()> {
    loop {
        match media_track.recv().await {
            Ok(frame) => {
                let mut group = track_producer.append_group();
                let mut frame_writer = group.create_frame(moq::Frame {
                    size: frame.payload.len() as u64,
                });
                frame_writer.write_chunk(frame.payload.clone());
                frame_writer.close();
                group.close();
            }
            Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                info!("capture media track closed; stopping publisher");
                break;
            }
            Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                warn!(skipped, "lost {} capture frames before publish", skipped);
            }
        }
    }
    Ok(())
}

async fn forward_moq_to_media(
    mut track: moq::TrackConsumer,
    sender: chan::Sender<MediaFrame>,
) -> Result<()> {
    loop {
        match track.next_group().await {
            Ok(Some(mut group)) => {
                while let Some(payload) = group
                    .read_frame()
                    .await
                    .context("failed to read frame from MoQ group")?
                {
                    let frame = MediaFrame {
                        payload,
                        sample_count: None,
                        skipped_frames: None,
                        skipped_samples: None,
                    };
                    let _ = sender.send(frame);
                }
            }
            Ok(None) => {
                info!("remote track closed");
                break;
            }
            Err(err) => {
                if matches!(err, moq::Error::Cancel) {
                    info!("remote track cancelled");
                    break;
                }
                return Err(anyhow!(err).context("failed to read from MoQ track"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    #[tokio::test]
    async fn append_session_path_appends_namespace() {
        let mut url = Url::parse("https://example.com/anon").unwrap();
        append_session_path(&mut url, "test-session").unwrap();
        assert_eq!(url.as_str(), "https://example.com/anon/neet/test-session");
    }

    #[tokio::test]
    async fn forward_roundtrip_delivers_payload() {
        let (media_tx, media_rx) = chan::channel::<MediaFrame>(8);
        let media_track = MediaTrack::new(
            media_rx,
            Codec::Opus {
                channels: OpusChannels::Stereo,
            },
            TrackKind::Audio,
        );

        let track_pair = moq::Track::new(AUDIO_TRACK_NAME).produce();
        let producer = track_pair.producer;
        let consumer = track_pair.consumer;

        let (sink_tx, mut sink_rx) = chan::channel::<MediaFrame>(8);

        let publish = tokio::spawn(async move {
            forward_media_to_moq(media_track, producer).await.unwrap();
        });

        let subscribe = tokio::spawn(async move {
            forward_moq_to_media(consumer, sink_tx).await.unwrap();
        });

        let payload = Bytes::from_static(b"hello");
        media_tx
            .send(MediaFrame {
                payload: payload.clone(),
                sample_count: None,
                skipped_frames: None,
                skipped_samples: None,
            })
            .unwrap();
        drop(media_tx);

        let received = sink_rx.recv().await.unwrap();
        assert_eq!(received.payload, payload);

        publish.await.unwrap();
        subscribe.await.unwrap();
    }
}
