# Older changes

The README keeps the changelog of the last five versions; older entries move here.

### 0.1.0 (2026-11-06)

- (sadam6752-tech) Any player that takes a URL: a row names the play URL state; presets fill stop, volume, title and
  stream for ioBroker.assistant satellites and Dune HD; rows of 0.0.x are converted once
- (sadam6752-tech) The admin offers every writable state with role media.url
- (sadam6752-tech) MP3 streams work (ffmpeg refused the sample format), sent like an internet radio without ID3 tag
- (sadam6752-tech) A pause keeps the stream open with silence, by default for 60 s, before the player is stopped

### 0.0.3 (2026-11-05)

- (sadam6752-tech) The display shows "AirPlay – <sender>" right away instead of the radio station that played
  before, and the track title is written again once the satellite has opened the stream

### 0.0.2 (2026-11-05)

- (sadam6752-tech) Release through the GitHub workflow with npm provenance; stricter types in the code

### 0.0.1 (2026-11-05)

- (sadam6752-tech) First version: every voice satellite of ioBroker.assistant becomes an AirPlay speaker for iPhone,
  iPad and Mac

Older changes are in [CHANGELOG_OLD.md](CHANGELOG_OLD.md).
