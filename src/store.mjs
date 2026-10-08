import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function safeId(value) {
  if (!/^[a-zA-Z0-9_-]{1,90}$/.test(value)) throw Error('Invalid identifier');
  return value;
}
// An append-only fsynced ledger is authoritative; a truncated/corrupt ledger fails closed.
// One writer per run. Locks never expire automatically: an operator verifies process exit.
export class Store {
  constructor(directory, config) {
    this.allowedProviders=new Set(Object.keys(config.agents || {}));
    this.directory = path.resolve(directory);
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.lock = path.join(this.directory, 'run.lock');
    this.token = randomUUID();
    const fd = fs.openSync(this.lock, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, token: this.token }));
    fs.fsyncSync(fd); fs.closeSync(fd);
    this.file = path.join(this.directory, 'ledger.jsonl');
    try {
      this.sequence = 0; this.previous = 'genesis'; this.events = [];
      if (fs.existsSync(this.file)) {
        const content = fs.readFileSync(this.file, 'utf8');
        if (content && !content.endsWith('\n')) throw Error('Truncated ledger; recovery review required');
        for (const line of content.split('\n').filter(Boolean)) {
          const row = JSON.parse(line), { digest, ...entry } = row;
          if (entry.sequence !== this.sequence + 1 || entry.previous !== this.previous || hash(entry) !== digest) throw Error('Corrupt ledger');
          this.sequence = entry.sequence; this.previous = digest;
          this.state = entry.state; this.events.push(row);
        }
      }
      if (this.state && this.state.configHash !== hash(config)) throw Error('Configuration changed; use another run directory');
      if (!this.state) {
        this.state = { configHash: hash(config), createdAt:new Date().toISOString(), calls: 0, reservedMicros: 0, intents: {}, steps: {}, observations: [], candidates: [], coverage: [], visits: {}, holds: [], status: 'ready' };
        this.commit('created');
      }
    } catch (error) { this.close(); throw error; }
  }
  commit(type, facts = {}) {
    const entry = { sequence: this.sequence + 1, previous: this.previous, time: new Date().toISOString(), type, facts, state: this.state };
    const digest = hash(entry);
    const serialized = JSON.stringify({ ...entry, digest }) + '\n';
    if ((fs.existsSync(this.file) ? fs.statSync(this.file).size : 0) + Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw Error('Ledger storage cap reached; no further actions');
    const fd = fs.openSync(this.file, 'a', 0o600);
    try { fs.writeSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.sequence++; this.previous = digest; this.events.push(JSON.parse(JSON.stringify({ ...entry, digest })));
  }
  reserve(provider, quota, budget) {
    if(this.allowedProviders.size&&!this.allowedProviders.has(provider.id))throw Error('Undeclared worker; no fallback');
    if(!this.allowedProviders.size && this.state.provider && (this.state.provider.id !== provider.id || this.state.provider.maxCostMicros !== provider.maxCostMicros)) throw Error('Provider changed; no implicit fallback');
    const previous=this.state.workerUsage?.[provider.id];
    if(previous&&previous.maxCostMicros!==provider.maxCostMicros)throw Error('Worker cost definition changed');
    if (!quota || quota.available !== true || !Number.isFinite(quota.remainingFraction) || quota.remainingFraction > 1 || quota.remainingFraction <= budget.reserveFraction || !Number.isFinite(quota.checkedAt) || Math.abs(Date.now() - quota.checkedAt) > budget.quotaMaxAgeMs) throw Error('Quota unavailable, stale or reserve reached');
    const cost = provider.maxCostMicros;
    if (!Number.isSafeInteger(cost) || cost < 0 || this.state.calls >= budget.maxCalls || this.state.reservedMicros + cost > budget.maxCostMicros) throw Error('Budget exhausted or invalid');
    this.state.calls++; this.state.reservedMicros += cost;
    this.state.provider = {id:provider.id,maxCostMicros:cost};
    this.state.workerUsage ||= {};
    this.state.workerUsage[provider.id]={calls:(previous?.calls || 0)+1,maxCostMicros:cost,billingMode:provider.billingMode || 'reservation',reportedTokens:previous?.reportedTokens || 0};
    this.commit('call-reserved', { provider: provider.id, cost, quota });
  }
  close() {
    if (fs.existsSync(this.lock) && JSON.parse(fs.readFileSync(this.lock)).token === this.token) fs.unlinkSync(this.lock);
  }
}

export function unlock(directory) {
  const file = path.join(path.resolve(directory), 'run.lock');
  const lock = JSON.parse(fs.readFileSync(file));
  try { process.kill(lock.pid, 0); throw Error('Process still alive; lock retained'); } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  fs.unlinkSync(file);
}
