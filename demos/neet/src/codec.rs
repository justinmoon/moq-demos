use self::opus::OpusChannels;

pub mod opus;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
#[non_exhaustive]
pub enum Codec {
    Opus { channels: OpusChannels },
}
