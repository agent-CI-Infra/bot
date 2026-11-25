import { watch } from 'node:fs';
import { EventEmitter } from 'node:events';

const SUBDIRS = ['tool-requests', 'token-requests'];

class MailboxWatchEntry {
  constructor(dir) {
    this.dir = dir;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
    this.refCount = 0;
    this.watchers = new Map();
    this.closed = false;
    this._attachAll();
  }

  _attach(key, targetPath) {
    if (this.closed || this.watchers.has(key)) return;
    try {
      const w = watch(targetPath, { persistent: false }, (eventType, filename) => {
        if (this.closed) return;
        const name = filename ? String(filename) : '';
        if (key === 'root' && SUBDIRS.includes(name)) {
          this._attach(name, `${this.dir}/${name}`);
        }
        this.emitter.emit('change', {
          dir: this.dir,
          subdir: key === 'root' ? null : key,
          event: eventType,
          filename: name,
          at: Date.now(),
        });
      });
      w.on('error', () => {
        this._detach(key);
      });
      this.watchers.set(key, w);
    } catch {
      // Directory may not exist yet; root watcher or next poll will attach it once created.
    }
  }

  _attachAll() {
    this._attach('root', this.dir);
    for (const sub of SUBDIRS) {
      this._attach(sub, `${this.dir}/${sub}`);
    }
  }

  ensureAttached() {
    if (!this.closed) this._attachAll();
  }

  _detach(key) {
    const w = this.watchers.get(key);
    if (!w) return;
    this.watchers.delete(key);
    try { w.close(); } catch {}
  }

  close() {
    this.closed = true;
    for (const key of [...this.watchers.keys()]) this._detach(key);
    this.emitter.emit('close');
    this.emitter.removeAllListeners();
  }
}

const activeHubs = new Map();

function acquire(dir) {
  let entry = activeHubs.get(dir);
  if (!entry || entry.closed) {
    entry = new MailboxWatchEntry(dir);
    activeHubs.set(dir, entry);
  } else {
    entry.ensureAttached();
  }
  entry.refCount++;
  let released = false;
  return {
    entry,
    release() {
      if (released) return;
      released = true;
      entry.refCount = Math.max(0, entry.refCount - 1);
      if (entry.refCount === 0) {
        entry.close();
        if (activeHubs.get(dir) === entry) activeHubs.delete(dir);
      }
    },
  };
}

/**
 * Subscribes to filesystem change events in a task's `<taskRoot>/agent` mailbox directory
 * (covering state.json, boundary.json, events.jsonl, harness-state.json, harness-stdout.bin,
 * tool-requests/, and token-requests/). Returns an unsubscribe callback.
 */
export function watchMailbox(dir, onChange) {
  const { entry, release } = acquire(dir);
  entry.emitter.on('change', onChange);
  return () => {
    entry.emitter.off('change', onChange);
    release();
  };
}

export function closeAllMailboxWatchers() {
  for (const entry of activeHubs.values()) entry.close();
  activeHubs.clear();
}
