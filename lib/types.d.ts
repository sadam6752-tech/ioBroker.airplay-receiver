// Shared types of the adapter modules (JSDoc in the .js files refers to them with import('./types').X)

/** Timer functions of the adapter (they end with the adapter) */
export interface Timers {
    /** Starts a timeout */
    setTimeout: (cb: () => void, ms: number) => unknown;
    /** Clears a timeout */
    clearTimeout: (handle: unknown) => void;
    /** Starts an interval */
    setInterval: (cb: () => void, ms: number) => unknown;
    /** Clears an interval */
    clearInterval: (handle: unknown) => void;
}

/** Logger of the adapter */
export interface Logger {
    /** Debug line */
    debug(msg: string): void;
    /** Info line */
    info(msg: string): void;
    /** Warning */
    warn(msg: string): void;
    /** Error */
    error(msg: string): void;
}

/** A receiver row of the settings after normalization */
export interface ReceiverConfig {
    /** Object id part */
    id: string;
    /** AirPlay name shown on the iPhone */
    name: string;
    /** Satellite id below assistant.X.satellites */
    satellite: string;
    /** Media player object id below satellites.<id>.controls */
    player: string;
    /** RTSP port, 0 = any free port */
    rtspPort: number;
    /** Output format */
    format: 'flac' | 'mp3';
}
