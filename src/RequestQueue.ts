interface QueuedRequest<T> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  abortController: AbortController;
}

export class RequestQueue {
  private queue: QueuedRequest<any>[] = [];
  private running = 0;
  private readonly maxConcurrent: number;
  private readonly maxRetries: number;
  private readonly retryDelay: number;

  constructor(
    maxConcurrent: number = 5,
    maxRetries: number = 3,
    retryDelay: number = 1000
  ) {
    this.maxConcurrent = maxConcurrent;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
  }

  /**
   * Adds a request to the queue and processes it when a slot is available
   */
  async enqueue<T>(
    fn: () => Promise<T>,
    abortController?: AbortController
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const controller = abortController || new AbortController();

      this.queue.push({
        fn,
        resolve,
        reject,
        abortController: controller,
      });

      this.process();
    });
  }

  /**
   * Processes the queue, respecting maxConcurrent limit
   */
  private async process(): Promise<void> {
    if (this.running >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const request = this.queue.shift();
    if (!request) {
      return;
    }

    this.running++;

    // Check if request was aborted before processing
    if (request.abortController.signal.aborted) {
      this.running--;
      request.reject(new Error("Request aborted"));
      this.process(); // Process next request
      return;
    }

    try {
      const result = await this.executeWithRetry(
        request.fn,
        request.abortController.signal
      );
      request.resolve(result);
    } catch (error) {
      // Only reject if not aborted
      if (!request.abortController.signal.aborted) {
        request.reject(error as Error);
      }
    } finally {
      this.running--;
      this.process(); // Process next request
    }
  }

  /**
   * Executes a function with retry logic and exponential backoff
   */
  private async executeWithRetry<T>(
    fn: () => Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Check if aborted before each attempt
      if (signal.aborted) {
        throw new Error("Request aborted");
      }

      try {
        return await fn();
      } catch (error: any) {
        lastError = error;

        // Check if it's a rate limit error (429) or network error
        const isRateLimit = error?.status === 429;
        const isNetworkError =
          error?.code === "ECONNRESET" ||
          error?.code === "ETIMEDOUT" ||
          error?.message?.includes("fetch");

        // Only retry on rate limit or network errors
        if (attempt < this.maxRetries && (isRateLimit || isNetworkError)) {
          const delay = this.retryDelay * Math.pow(2, attempt); // Exponential backoff
          await this.sleep(delay, signal);
          continue;
        }

        // Don't retry on other errors or if max retries reached
        throw error;
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  /**
   * Sleep with abort signal support
   */
  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Request aborted"));
        return;
      }

      const timeout = setTimeout(() => {
        resolve();
      }, ms);

      signal.addEventListener("abort", () => {
        clearTimeout(timeout);
        reject(new Error("Request aborted"));
      });
    });
  }

  /**
   * Aborts all pending requests
   */
  abortAll(): void {
    while (this.queue.length > 0) {
      const request = this.queue.shift();
      if (request) {
        request.abortController.abort();
        request.reject(new Error("Request queue aborted"));
      }
    }
  }

  /**
   * Gets the current queue size
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Gets the number of currently running requests
   */
  getRunningCount(): number {
    return this.running;
  }
}
