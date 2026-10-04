import type { Logger } from './logger.js';

/** Aucune exception ne doit tuer le processus : on journalise et on continue. */
export function installProcessGuards(logger: Logger): () => void {
  const onException = (err: unknown) => logger.error({ err }, 'exception non rattrapée (processus maintenu)');
  const onRejection = (reason: unknown) => logger.error({ err: reason }, 'promesse rejetée non gérée (processus maintenu)');
  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };
}

/** Exécute une promesse avec un délai maximal ; rejette avec TimeoutError au-delà. */
export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} : délai de ${ms} ms dépassé`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
