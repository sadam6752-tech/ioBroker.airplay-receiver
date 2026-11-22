'use strict';

/*
 * The answer to the message "help" (js-controller PR #3638, common.supportedMessages.help): a fixed text for an AI
 * agent or a script author, and the commands with `write: true` for those that change something.
 *
 * The text must stay the same while the adapter runs: pi-agent keeps a fingerprint of it and tells its conversations
 * to read the help again whenever it changes. No speaker names, addresses or values in it — those are in the states.
 *
 * Left out on purpose: `listUrlStates` only fills the list of play URL states in the admin settings.
 */

const HELP = [
    'airplay-receiver is an AirPlay 1 receiver. For every speaker configured in its settings it announces an AirPlay',
    'speaker in the network; iPhone, iPad and Mac (Apple Music, Spotify, any app with the AirPlay button) can play on it.',
    'The audio goes as an HTTP stream (ffmpeg, FLAC or MP3) into the play URL state of an ioBroker player: an',
    'ioBroker.assistant satellite (assistant.0.satellites.<sat>.controls.<player>.url), a satellite-display panel',
    '(satellite-display.0.satellites.<panel>.media.url), a Dune HD (dune-hd-remote.0.media.playUrl) or any writable',
    'state with role media.url. Volume and "Artist – Title" from the sender go to the volume and title states of that',
    'player.',
    '',
    'Playback is started, paused and stopped on the sender (the iPhone), not from ioBroker: the adapter has no command',
    'and no writable state to start AirPlay or to choose what plays. To stop the sound in the room, stop the player',
    'itself (its stop state) or tell the user to stop AirPlay on the phone. A pause keeps the stream open with silence;',
    'a longer pause (60 s by default) or stopping on the phone stops the player.',
    '',
    'States, all read-only, for every speaker below airplay-receiver.<instance>.receivers.<speaker>:',
    '- connected (boolean): a sender is connected',
    '- playing (boolean): audio is arriving',
    '- client (string): name of the sender, e.g. the name of the iPhone',
    '- title, artist, album (string): what plays',
    '- volume (number, 0–100 %): volume set on the sender',
    '- streamUrl (string): the URL the player fetches',
    'The channel airplay-receiver.<instance>.receivers.<speaker> has the AirPlay name as its name and the play URL',
    'state it plays on as its description (common.desc). info.connection is true while the speakers are announced.',
    'To answer "what plays on AirPlay?" read playing, client, title and artist of every speaker.',
    '',
    'Speakers are added, removed and assigned to players in the adapter settings (admin), not by messages.',
].join('\n');

/** Commands an agent may use, in the order of the answer */
const COMMANDS = [{ command: 'help', write: false }];

/**
 * @returns {{help: string, commands: {command: string, write: boolean}[]}} Answer to "help"
 */
function helpAnswer() {
    return { help: HELP, commands: COMMANDS.map(c => ({ ...c })) };
}

module.exports = { HELP, COMMANDS, helpAnswer };
