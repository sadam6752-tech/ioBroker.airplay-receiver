![Logo](admin/airplay-receiver.png)

# ioBroker.airplay-receiver

[![NPM version](https://img.shields.io/npm/v/iobroker.airplay-receiver.svg)](https://www.npmjs.com/package/iobroker.airplay-receiver)
[![Downloads](https://img.shields.io/npm/dm/iobroker.airplay-receiver.svg)](https://www.npmjs.com/package/iobroker.airplay-receiver)
[![License](https://img.shields.io/github/license/sadam6752-tech/ioBroker.airplay-receiver.svg)](LICENSE)

[![NPM](https://nodei.co/npm/iobroker.airplay-receiver.png?downloads=true)](https://nodei.co/npm/iobroker.airplay-receiver/)

![Test and Release](https://github.com/sadam6752-tech/ioBroker.airplay-receiver/workflows/Test%20and%20Release/badge.svg)

## AirPlay receiver adapter for ioBroker

Turns ioBroker players into AirPlay speakers. An iPhone, iPad or Mac shows every configured speaker in its AirPlay
list; the music sent there plays on any ioBroker player that takes a URL:

- the voice satellites of [ioBroker.assistant](https://github.com/ioBroker/ioBroker.assistant), for example a
  [Waveshare ESP32-S3-AUDIO board](https://www.waveshare.com/wiki/ESP32-S3-AUDIO-Board) running ESPHome,
- the tile panels of ioBroker.satellite-display, for example a Waveshare ESP32-S3-Touch-LCD-2 with a MAX98357A
  amplifier,
- a [Dune HD](https://dune-hd.com/) media player through ioBroker.dune-hd-remote,
- any other adapter with a state that plays a URL (role `media.url`).

```
iPhone ──AirPlay 1 (RTSP/RTP, ALAC)──▶ adapter ──▶ ffmpeg ──FLAC/MP3 over HTTP──▶ player
                                          └── writes the stream URL into the player's play URL state
```

- **Nothing to install on the system.** mDNS (Bonjour) is pure JavaScript, ffmpeg comes with the adapter
  ([ffmpeg-static](https://github.com/eugeneware/ffmpeg-static)). No Docker, no shairport-sync, no avahi needed.
- **No clicks on Wi-Fi.** Lost UDP packets are asked for again (twice) before a gap is played as silence.
- **Volume and title.** The AirPlay volume sets the player's volume (on its own scale), artist and title go to its
  display when it has one.
- **Pauses keep the stream.** While the iPhone pauses, the stream goes on with silence, so the player does not drop
  it; only a pause longer than the stop time stops the player.
- **One speaker, one player.** Each AirPlay speaker plays on exactly one player. AirPlay 1 has no multi-room sync, so
  the adapter does not spread one stream over several players.
- **AirPlay 1 only.** Current iPhones and Macs still stream to AirPlay 1 speakers. AirPlay 2 features (multi-room
  sync with HomePods, the Home app) are not available.

## Requirements

- A player adapter with a state that plays a URL, e.g. ioBroker.assistant 1.4.10 or newer
  (`assistant.0.satellites.<satellite>.controls.<player>.url`), ioBroker.satellite-display
  (`satellite-display.0.satellites.<panel>.media.url`) or ioBroker.dune-hd-remote (`dune-hd-remote.0.media.playUrl`).
- The iPhone and the ioBroker host in the same network (mDNS does not cross routers).
- The player must reach the HTTP port of the adapter (default 8095).

## Settings

### Speakers

One row per AirPlay speaker. Only the name and the play URL state are needed; the other fields come from a preset
that the play URL state selects. Type a value to override the preset, or `-` for none.

| Column         | Meaning                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| AirPlay name   | Name in the AirPlay list of the iPhone, e.g. `Gast`                                                      |
| Play URL state | The state that plays a URL; the list offers every writable state with role `media.url`, or type one      |
| Stream         | _Auto_ (the preset) or FLAC/MP3 with 44.1/48 kHz, mono or stereo                                         |
| Stop state     | State written to stop the player                                                                         |
| Stop value     | Value written to the stop state (`stop`, `true`, a number …); a stop state of its own defaults to `true` |
| Volume state   | Volume of the player; the value is scaled to its `min` … `max` (0 … 1 without a max)                     |
| Title state    | Text state for "Artist – Title"                                                                          |
| RTSP port      | 0 = any free port (announced via mDNS); set a fixed port only for a firewall rule                        |

| Preset (play URL state)                              | Stream              | Stop                          | Volume                             | Title                             |
| ---------------------------------------------------- | ------------------- | ----------------------------- | ---------------------------------- | --------------------------------- |
| `assistant.0.satellites.<sat>.controls.<player>.url` | FLAC 48 kHz mono    | `stop` into the URL state     | `controls.<player>.volume` (0 … 1) | `controls.media_title` (48 bytes) |
| `satellite-display.0.satellites.<panel>.media.url`   | FLAC 48 kHz mono    | `media.stop` = `true`         | `media.volume` (0 … 100)           | `media.title` (48 bytes)          |
| `dune-hd-remote.0.media.playUrl`                     | MP3 44.1 kHz stereo | `control.stop` = `true`       | `control.volume` (0 … 100)         | none                              |
| any other state                                      | MP3 44.1 kHz stereo | empty text into the URL state | none                               | none                              |

MP3 is sent like an internet radio stream (`audio/mpeg`, no ID3 tag), which most players accept. For a Chromecast
choose the `url2play` state of ioBroker.chromecast and set its stop state.

Without any row, _one speaker for every satellite with a media player_ creates a speaker per satellite of
ioBroker.assistant, named after the satellite. Rows of version 0.0.x (a satellite player instead of a play URL state)
are converted once at the start.

### Settings

| Setting                                     | Default       | Meaning                                                                         |
| ------------------------------------------- | ------------- | ------------------------------------------------------------------------------- |
| Instance of ioBroker.assistant              | `assistant.0` | For the satellite search and the rows of version 0.0.x                          |
| HTTP port of the stream / Listen on         | 8095, all     | The player fetches `http://<host>:8095/<name>.flac` or `.mp3`                   |
| Address of this host for the player         | empty         | Empty = the address the iPhone reached; set it if ioBroker has several networks |
| Volume of the sender sets the player volume | on            | AirPlay -30 … 0 dB → the volume state, mute → its minimum                       |
| Wait for a lost packet                      | 350 ms        | How long a gap waits for its retransmission                                     |
| Audio kept until the player connects        | 1500 ms       | The beginning of a song is not lost while the player opens the stream           |
| Stop the player after a pause of            | 60 s          | Silence keeps the stream open until then; a longer pause stops the player       |
| Path of ffmpeg                              | empty         | Empty = the bundled ffmpeg                                                      |

## What happens

1. The adapter announces `_raop._tcp` for every speaker. The name on the iPhone is the AirPlay name.
2. The iPhone connects (RTSP), sends the encrypted session key and starts streaming ALAC over UDP.
3. When audio arrives the adapter writes the stream URL into the play URL state; the player opens the HTTP stream.
   Each listener gets its own ffmpeg, which turns ALAC into FLAC or MP3.
4. Volume changes on the iPhone go to the volume state, artist and title to the title state.
5. Pause on the iPhone: the stream goes on with silence. Stop, another speaker chosen, or a pause longer than the stop
   time: the adapter writes the stop value.

## Latency

AirPlay 1 gives no way to delay the player to the iPhone, so the delay is whatever the player buffers:

| Player                           | Delay        |
| -------------------------------- | ------------ |
| ioBroker.assistant satellite     | about 2–3 s  |
| Dune HD, Chromecast, other boxes | about 3–10 s |

Music is fine; video on the iPhone is not delayed to match.

## States

For every speaker below `airplay-receiver.0.receivers.<name>`:

| State       | Meaning                       |
| ----------- | ----------------------------- |
| `connected` | A sender is connected         |
| `playing`   | Audio is arriving             |
| `client`    | Name of the sender (iPhone)   |
| `title`     | Track title                   |
| `artist`    | Artist                        |
| `album`     | Album                         |
| `volume`    | Volume of the sender, 0–100 % |
| `streamUrl` | The URL the player fetches    |

`info.connection` is true while the speakers are announced.

## Used ports

With js-controller 8 the adapter declares its fixed ports in the used resources registry of the host
(`system.host.<host>.usedResources.tcpPort`), so the admin shows them as occupied: the HTTP port of the streams and
every fixed RTSP port. RTSP port 0, the RTP UDP ports (chosen by the system) and mDNS (UDP 5353, shared) are not
declared. Before opening a port the adapter warns when another instance declares it. Older controllers are not
affected.

## Troubleshooting

| Symptom                               | Cause and remedy                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The speaker does not show up          | iPhone and ioBroker in different networks or VLANs; a firewall blocks UDP 5353 (mDNS)                 |
| It shows up, but nothing plays        | Look at the log: does the adapter write the URL? Can the player reach port 8095 of the ioBroker host? |
| The iPhone connects and drops at once | A firewall blocks the RTSP port or UDP; set a fixed RTSP port and open it together with UDP           |
| Wrong address in the stream URL       | Set _Address of this host for the player_                                                             |
| The player refuses the stream         | Choose another _Stream_ (MP3 44.1 kHz stereo is the most compatible)                                  |
| Dropouts                              | Weak Wi-Fi of the player; raise _Wait for a lost packet_                                              |

## Provenance

The protocol code is written for this adapter from public protocol descriptions. The AirPort Express RSA key in
`lib/airport-key.js` has been public since 2011 and is used by every open AirPlay 1 receiver; projects such as
shairport-sync and nodetunes served as protocol reference only. AirPlay is a trademark of Apple Inc.; this adapter is
not affiliated with Apple.

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### 0.1.3 (2026-11-13)

- (sadam6752-tech) No gap of silence in the music after the process stood still for a moment (e.g. a slow start of
  ffmpeg): the packets that wait in the socket come first; this also made a test fail now and then
- (sadam6752-tech) The state `connected` of a speaker has the role `indicator` (`indicator.connected` is meant for the
  instance only); the stream choice _Auto_ is translated; the message command `listPlayers` of 0.0.x is removed
- (sadam6752-tech) A stop while the adapter is still starting no longer logs "Cannot open the HTTP port"

### 0.1.2 (2026-11-10)

- (sadam6752-tech) Preset for the tile panels of ioBroker.satellite-display: the `media.url` state fills stop,
  volume (0 … 100 %), title (48 bytes) and a FLAC 48 kHz mono stream by itself
- (sadam6752-tech) The stream is sent without chunked encoding, like an internet radio: an ESPHome player (ESP-IDF
  HTTP client) hung when it stopped the endless chunked stream; starting and switching are faster now

### 0.1.1 (2026-11-06)

- (sadam6752-tech) Fixed ports are declared in the used resources registry of js-controller 8

### 0.1.0 (2026-11-06)

- (sadam6752-tech) Any player that takes a URL: a row names the play URL state; presets fill stop, volume, title and
  stream for ioBroker.assistant satellites and Dune HD; rows of 0.0.x are converted once
- (sadam6752-tech) The admin offers every writable state with role media.url
- (sadam6752-tech) MP3 streams work (ffmpeg refused the sample format), sent like an internet radio without ID3 tag
- (sadam6752-tech) A pause keeps the stream open with silence, by default for 60 s, before the player is stopped

### 0.0.3 (2026-11-05)

- (sadam6752-tech) The display shows "AirPlay – <sender>" right away instead of the radio station that played
  before, and the track title is written again once the satellite has opened the stream

## License

MIT License

Copyright (c) 2026 sadam6752-tech <sadam6752@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
