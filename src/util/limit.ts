/**
 * Bounded-concurrency runner. Returns a function that, given a task, queues it
 * if too many are in flight and runs it when a slot frees up. Used by scan_markets
 * and infer_book to avoid hammering Sera with hundreds of parallel quotes.
 */
export function createLimit(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    if (active >= concurrency) return;
    const task = queue.shift();
    if (task) {
      active++;
      task();
    }
  };

  return function limited<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const run = () => {
        fn().then(
          (v) => {
            active--;
            resolve(v);
            next();
          },
          (e) => {
            active--;
            reject(e);
            next();
          },
        );
      };
      queue.push(run);
      next();
    });
  };
}
