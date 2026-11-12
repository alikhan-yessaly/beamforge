export interface Transport {
  open(): Promise<void>;
  close(): Promise<void>;
  /** Raw wire bytes (already swizzled). Rejects on I/O error. */
  write(bytes: Uint8Array): Promise<void>;
  /** Subscribe to raw wire bytes; returns an unsubscribe function. */
  onData(cb: (bytes: Uint8Array) => void): () => void;
  /** Fired once when the link drops or errors unexpectedly. */
  onClose(cb: (reason?: Error) => void): () => void;
  readonly isOpen: boolean;
}
