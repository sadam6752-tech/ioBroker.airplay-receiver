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
    /** Which preset filled the empty fields */
    kind: 'assistant' | 'dune' | 'custom';
    /** State that takes the stream URL */
    urlState: string;
    /** State written to stop the target */
    stopState: string;
    /** Value written to the stop state */
    stopValue: ioBroker.StateValue;
    /** Volume state of the target, empty = none */
    volumeState: string;
    /** Title state of the target, empty = none */
    titleState: string;
    /** Byte limit of the title text, 0 = none */
    titleBytes: number;
    /** Output codec */
    codec: 'flac' | 'mp3';
    /** Output sample rate */
    sampleRate: number;
    /** Output channels */
    channels: number;
    /** RTSP port, 0 = any free port */
    rtspPort: number;
}

/** The used resources calls of js-controller 8 (not in the typings of 7) */
export interface UsedResourcesApi {
    /** Whether the controller has a feature */
    supportsFeature?: (feature: string) => boolean;
    /** Other running instances that declare the port */
    checkUsedResource: (type: 'tcpPort', data: { port: number; bind?: string }) => Promise<{ instance: string }[]>;
    /** Declares a port of this instance */
    registerUsedResource: (type: 'tcpPort', data: { port: number; bind?: string }) => Promise<void>;
}
