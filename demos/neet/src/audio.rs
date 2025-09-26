use std::time::Duration;

use anyhow::Result;
use cpal::{ChannelCount, SampleRate};

use self::{capture::AudioCapture, device::list_devices, playback::AudioPlayback};
pub use self::{
    capture::AudioSink,
    device::{AudioConfig, Devices},
    playback::AudioSource,
};
use crate::media::MediaTrack;

#[cfg(feature = "audio-processing")]
mod processor;
#[cfg(feature = "audio-processing")]
pub use processor::WebrtcAudioProcessor;

#[cfg(not(feature = "audio-processing"))]
#[derive(Debug, Clone)]
pub struct WebrtcAudioProcessor;

mod capture;
mod device;
mod playback;

pub const SAMPLE_RATE: SampleRate = SampleRate(48_000);
pub const ENGINE_FORMAT: AudioFormat = AudioFormat::new(SAMPLE_RATE, 2);

const DURATION_10MS: Duration = Duration::from_millis(10);
const DURATION_20MS: Duration = Duration::from_millis(20);

#[derive(Debug, Clone)]
pub struct AudioContext {
    playback: AudioPlayback,
    capture: AudioCapture,
}

impl AudioContext {
    pub async fn list_devices() -> Result<Devices> {
        tokio::task::spawn_blocking(list_devices).await?
    }

    /// Create a new [`AudioContext`].
    pub async fn new(config: AudioConfig) -> Result<Self> {
        let host = cpal::default_host();

        #[cfg(feature = "audio-processing")]
        let processor = WebrtcAudioProcessor::new(config.processing_enabled)?;
        #[cfg(not(feature = "audio-processing"))]
        let processor = WebrtcAudioProcessor;

        let capture =
            AudioCapture::build(&host, config.input_device.as_deref(), processor.clone()).await?;
        let playback =
            AudioPlayback::build(&host, config.output_device.as_deref(), processor.clone()).await?;
        Ok(Self { playback, capture })
    }

    pub async fn capture_track(&self) -> Result<MediaTrack> {
        self.capture.create_opus_track().await
    }

    pub async fn play_track(&self, track: MediaTrack) -> Result<()> {
        self.playback.add_track(track).await?;
        Ok(())
    }

    pub async fn feedback_encoded(&self) -> Result<()> {
        let track = self.capture_track().await?;
        self.play_track(track).await?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct AudioFormat {
    pub sample_rate: SampleRate,
    pub channel_count: ChannelCount,
}

impl AudioFormat {
    pub const fn new(sample_rate: SampleRate, channel_count: ChannelCount) -> Self {
        Self {
            sample_rate,
            channel_count,
        }
    }
    pub const fn new2(sample_rate: u32, channel_count: u16) -> Self {
        Self {
            sample_rate: SampleRate(sample_rate),
            channel_count,
        }
    }

    pub fn duration_from_sample_count(&self, sample_count: usize) -> Duration {
        Duration::from_secs_f32(
            (sample_count as f32 / self.channel_count as f32) / self.sample_rate.0 as f32,
        )
    }

    pub const fn block_count(&self, duration: Duration) -> usize {
        (self.sample_rate.0 as usize / 1000) * duration.as_millis() as usize
    }

    pub const fn sample_count(&self, duration: Duration) -> usize {
        self.block_count(duration) * self.channel_count as usize
    }
}
