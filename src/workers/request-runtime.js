/** Comparte recursos solo mientras hay solicitudes activas; no deja sockets o timers en reposo. */
export class RequestRuntime {
  constructor({ open, close, onCloseError = () => {} }) {
    this.open = open;
    this.close = close;
    this.onCloseError = onCloseError;
    this.pending = null;
    this.closing = null;
    this.active = 0;
  }

  get() {
    if (!this.active) throw new Error('Runtime requested outside an active request');
    if (!this.pending) {
      const pending = Promise.resolve().then(this.open);
      this.pending = pending;
      pending.catch(() => {
        if (this.pending === pending) this.pending = null;
      });
    }
    return this.pending;
  }

  async run(handle) {
    this.active++;
    try {
      // Una solicitud puede llegar mientras se cierran los sockets de la anterior.
      if (this.closing) await this.closing;
      return await handle();
    } finally {
      if (--this.active === 0 && this.pending) {
        const pending = this.pending;
        this.pending = null;
        const closing = pending
          .then(
            (runtime) => this.close(runtime),
            () => {},
          )
          .catch((error) => this.onCloseError(error));
        this.closing = closing;
        try {
          await closing;
        } finally {
          if (this.closing === closing) this.closing = null;
        }
      }
    }
  }
}
