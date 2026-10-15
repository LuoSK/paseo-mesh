export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Plugin stdout/stderr are captured by Paseo (`paseo plugin logs <id>`). Never log secrets. */
export const consoleLogger: Logger = {
  info: (message) => console.log(`[mesh] ${message}`),
  warn: (message) => console.warn(`[mesh] ${message}`),
  error: (message) => console.error(`[mesh] ${message}`),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
