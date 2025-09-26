mod audio;
mod codec;
mod media;
mod moq;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use crate::{
    audio::{AudioConfig, AudioContext},
    moq::{MoqOptions, Role},
};

const DEFAULT_RELAY: &str = "https://moq.justinmoon.com/anon";

#[derive(Parser, Debug)]
#[command(
    author,
    version,
    about = "Experimental MoQ audio calling",
    disable_help_subcommand = true
)]
struct Cli {
    #[command(flatten)]
    audio: AudioArgs,

    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Clone, Args)]
struct AudioArgs {
    /// Input device name (default system microphone)
    #[arg(long)]
    input_device: Option<String>,
    /// Output device name (default system speakers)
    #[arg(long)]
    output_device: Option<String>,
    /// Disable audio processing / echo cancellation
    #[arg(long)]
    disable_processing: bool,
}

#[derive(Debug, Clone, Args)]
struct SessionArgs {
    /// Shared session identifier for this call
    #[arg(long)]
    session: String,
    /// MoQ relay base URL (defaults to hosted relay)
    #[arg(long, default_value = DEFAULT_RELAY)]
    relay: url::Url,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// Wait for a caller and bridge microphone/speakers over MoQ
    Listen(SessionArgs),
    /// Dial a listener using the shared session identifier
    Call(SessionArgs),
    /// Run local microphone → speakers loopback without networking
    Loopback,
    /// List available audio input and output devices
    ListDevices,
}

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();

    let cli = Cli::parse();
    match cli.command {
        Command::Listen(session) => run_session(Role::Listener, session, cli.audio).await?,
        Command::Call(session) => run_session(Role::Caller, session, cli.audio).await?,
        Command::Loopback => run_loopback(cli.audio).await?,
        Command::ListDevices => run_list_devices().await?,
    }

    Ok(())
}

fn init_tracing() {
    let default_level = "info".to_string();
    let filter = std::env::var("RUST_LOG").unwrap_or(default_level);
    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new(filter))
        .try_init();
}

fn build_audio_config(args: &AudioArgs) -> AudioConfig {
    AudioConfig {
        input_device: args.input_device.clone(),
        output_device: args.output_device.clone(),
        processing_enabled: !args.disable_processing,
    }
}

async fn run_session(role: Role, session: SessionArgs, audio_args: AudioArgs) -> Result<()> {
    let audio_config = build_audio_config(&audio_args);
    let audio = AudioContext::new(audio_config).await?;

    let options = MoqOptions {
        relay_url: session.relay,
        session_id: session.session,
        role,
    };

    crate::moq::run_audio_session(options, audio).await
}

async fn run_loopback(audio_args: AudioArgs) -> Result<()> {
    let audio_config = build_audio_config(&audio_args);
    let audio = AudioContext::new(audio_config).await?;
    audio.feedback_encoded().await?;
    tracing::info!("loopback running – press Ctrl+C to stop");
    tokio::signal::ctrl_c().await?;
    Ok(())
}

async fn run_list_devices() -> Result<()> {
    let devices = AudioContext::list_devices().await?;
    println!("Input devices:");
    for name in devices.input {
        println!("  {name}");
    }
    println!("Output devices:");
    for name in devices.output {
        println!("  {name}");
    }
    Ok(())
}
