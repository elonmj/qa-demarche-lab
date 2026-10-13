import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function safeId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,90}$/.test(value)) throw Error('Invalid identifier');
  return value;
}
// Full genesis/legacy snapshots remain readable. New rows record top-level changes;
// growing evidence arrays append only their suffix. No compaction deletes intent history.
function diffState(before,after) {
  const set={},append={},remove=Object.keys(before).filter(k=>!Object.hasOwn(after,k));
  for(const [key,value] of Object.entries(after)) {
    if(JSON.stringify(before[key])===JSON.stringify(value))continue;
    const old=before[key];
    if(Array.isArray(value) && Array.isArray(old) && value.length>=old.length && hash(value.slice(0,old.length))===hash(old))append[key]=value.slice(old.length);
    else set[key]=value;
  }
  return {set,append,remove};
}
function applyPatch(state,patch) {
  if(!state || !patch || !patch.set || !patch.append || !Array.isArray(patch.remove))throw Error('Invalid ledger state patch');
  for(const key of patch.remove)delete state[key];
  for(const [key,value] of Object.entries(patch.set))Object.defineProperty(state,key,{value,writable:true,enumerable:true,configurable:true});
  for(const [key,values] of Object.entries(patch.append)) {
    if(!Array.isArray(state[key]) || !Array.isArray(values))throw Error('Invalid ledger append patch');
    for(const value of values)state[key].push(value);
  }
  return state;
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
        if (fs.statSync(this.file).size > 64 * 1024 * 1024) throw Error('Ledger storage cap exceeded; recovery review required');
        const content = fs.readFileSync(this.file, 'utf8');
        if (content && !content.endsWith('\n')) throw Error('Truncated ledger; recovery review required');
        for (const line of content.split('\n').filter(Boolean)) {
          const row = JSON.parse(line), { digest, ...entry } = row;
          if (entry.sequence !== this.sequence + 1 || entry.previous !== this.previous || hash(entry) !== digest) throw Error('Corrupt ledger');
          this.sequence = entry.sequence; this.previous = digest;
          if(entry.format!==undefined && entry.format!==2)throw Error('Unsupported ledger format');
          this.state = entry.format===2 ? applyPatch(this.state,entry.statePatch) : entry.state; this.#remember(row);
        }
      }
      if (this.state && this.state.configHash !== hash(config)) throw Error('Configuration changed; use another run directory');
      if(this.state)this.persisted = structuredClone(this.state);
      if (!this.state) {
        this.state = { configHash: hash(config), createdAt:new Date().toISOString(), calls: 0, reservedMicros: 0, intents: {}, steps: {}, observations: [], candidates: [], coverage: [], visits: {}, holds: [], status: 'ready' };
        this.commit('created');
      }
    } catch (error) { this.close(); throw error; }
  }
  assertOpen() {
    if (this.closed) throw Error('Store closed; no further actions');
    if (this.failed) throw Error('Ledger failure; stop and review the run before recovery');
    try {
      if (JSON.parse(fs.readFileSync(this.lock)).token !== this.token) throw Error('Run lock ownership lost');
    } catch (error) { this.failed = true; throw error; }
  }
  commit(type, facts = {}) {
    this.assertOpen();
    try { this.#append(type, facts); }
    catch (error) { this.failed = true; throw error; }
  }
  #append(type, facts) {
    const snapshot=JSON.parse(JSON.stringify(this.state));
    const entry = { sequence: this.sequence + 1, previous: this.previous, time: new Date().toISOString(), type, facts, ...(this.persisted ? {format:2,state:{configHash:'qa-lab/2: upgrade required; never reset this run'},statePatch:diffState(this.persisted,snapshot)} : {state:snapshot}) };
    const digest = hash(entry);
    const serialized = JSON.stringify({ ...entry, digest }) + '\n';
    if ((fs.existsSync(this.file) ? fs.statSync(this.file).size : 0) + Buffer.byteLength(serialized) > 64 * 1024 * 1024) throw Error('Ledger storage cap reached; no further actions');
    const fd = fs.openSync(this.file, 'a', 0o600);
    try {
      const buffer = Buffer.from(serialized);
      for (let offset=0; offset<buffer.length;) {
        const written = fs.writeSync(fd,buffer,offset,buffer.length-offset);
        if (!written) throw Error('Ledger append incomplete');
        offset += written;
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    this.sequence++; this.previous = digest; this.persisted=snapshot; this.#remember({ ...entry, digest });
  }
  #remember({state, statePatch, ...metadata}) {
    this.events.push(metadata);
    if(this.events.length > 256)this.events.shift();
  }
  reserve(provider, quota, budget) {
    this.assertOpen();
    if(this.allowedProviders.size&&!this.allowedProviders.has(provider.id))throw Error('Undeclared worker; no fallback');
    if(!this.allowedProviders.size && this.state.provider && (this.state.provider.id !== provider.id || this.state.provider.maxCostMicros !== provider.maxCostMicros)) throw Error('Provider changed; no implicit fallback');
    const previous=this.state.workerUsage?.[provider.id];
    if(previous&&previous.maxCostMicros!==provider.maxCostMicros)throw Error('Worker cost definition changed');
    if (!quota || quota.available !== true || !Number.isFinite(quota.remainingFraction) || quota.remainingFraction > 1 || quota.remainingFraction <= budget.reserveFraction || !Number.isFinite(quota.checkedAt) || Math.abs(Date.now() - quota.checkedAt) > budget.quotaMaxAgeMs) throw Error('Quota unavailable, stale or reserve reached');
    const cost = provider.maxCostMicros;
    if (!Number.isSafeInteger(cost) || cost < 0 || this.state.calls >= budget.maxCalls || this.state.reservedMicros + cost > budget.maxCostMicros) throw Error('Budget exhausted or invalid');
    this.state.calls++; this.state.reservedMicros += cost;
    this.state.pendingWorker = {provider:provider.id,call:this.state.calls,time:new Date().toISOString()};
    this.state.provider = {id:provider.id,maxCostMicros:cost};
    this.state.workerUsage ||= {};
    this.state.workerUsage[provider.id]={calls:(previous?.calls || 0)+1,maxCostMicros:cost,billingMode:provider.billingMode || 'reservation',reportedTokens:previous?.reportedTokens || 0};
    this.commit('call-reserved', { provider: provider.id, cost, quota });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { if (fs.existsSync(this.lock) && JSON.parse(fs.readFileSync(this.lock)).token === this.token) fs.unlinkSync(this.lock); }
    catch { /* A missing/corrupt/foreign lock is never removed or replaced here. */ }
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
