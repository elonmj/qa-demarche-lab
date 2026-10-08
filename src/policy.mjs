import { safeId } from './store.mjs';
import { isDeepStrictEqual } from 'node:util';

export function validateConfig(config, {readbackOnly=false} = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('Configuration object required');
  safeId(config.id);
  for(const [id,definition] of Object.entries(config.agents || {})){safeId(id);if(!definition.kind)throw Error('Agent provider kind required');}
  if(config.agents&&(!config.defaultAgent||!config.agents[config.defaultAgent]))throw Error('Explicit defaultAgent required');
  const origin = new URL(config.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.origin !== config.origin) throw Error('Plain origin required');
  if (origin.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw Error('HTTPS required except loopback fixtures');
  if (!Array.isArray(config.reads) || !Array.isArray(config.scenarios)) throw Error('Explicit reads and scenarios arrays required');
  for (const read of config.reads) validateEndpoint(read, true);
  validatePath(config.entry ?? '/');
  if (!config.reads.some(r => r.path === (config.entry ?? '/') && r.methods.includes('GET'))) throw Error('Entry must be a declared safe GET');
  if (config.role !== undefined) safeId(config.role);
  for (const scenario of config.scenarios || []) {
    safeId(scenario.id);
    if (scenario.role !== undefined) safeId(scenario.role);
    for (const name of ['steps','probes','readChecks','assertions']) if (scenario[name] !== undefined && !Array.isArray(scenario[name])) throw Error(`Scenario ${name} must be an array`);
    for (const name of ['settleMs','probeTimeoutMs']) if (scenario[name] !== undefined && (!Number.isSafeInteger(scenario[name]) || scenario[name] < (name === 'settleMs' ? 0 : 1) || scenario[name] > 120000)) throw Error(`Invalid bounded ${name}`);
    if(scenario.agent&&!config.agents?.[scenario.agent])throw Error('Scenario agent not declared');
    if (scenario.writeConsent) {
      if (scenario.writeConsent.confirmed !== true || !scenario.writeConsent.reason) throw Error('Explicit write consent required');
      if (!Array.isArray(scenario.writeConsent.endpoints) || !scenario.writeConsent.endpoints.length) throw Error('Scoped write endpoints required');
      for (const endpoint of scenario.writeConsent.endpoints) {
        validateEndpoint(endpoint, false);
        if (config.reads.some(r => r.path === endpoint.path && r.methods.some(m => endpoint.methods.includes(m)))) throw Error('Write endpoint overlaps safe read consent');
      }
      const scopes = scenario.writeConsent.endpoints.flatMap(e => e.methods.map(m => `${m} ${e.path}`));
      if (new Set(scopes).size !== scopes.length) throw Error('Duplicate write endpoint scope');
    }
    for (const probe of [...(scenario.probes || []),...(scenario.readChecks || [])]) {
      if ((scenario.probes?.includes(probe) && !['confirmed', 'rejected'].includes(probe.verdict)) || !probe.path || !Array.isArray(probe.checks) || !probe.checks.length) throw Error('Probe requires explicit checks');
      if (!config.reads.some(r => r.path === probe.path && r.methods.includes('GET'))) throw Error('Probe not declared as safe read');
      for (const check of probe.checks) validateCheck(check);
      if (probe.scopeChecks !== undefined) {
        if(!Array.isArray(probe.scopeChecks) || !probe.scopeChecks.length)throw Error('Explicit scope checks required');
        for(const check of probe.scopeChecks)validateCheck(check);
      }
      if(!readbackOnly && scenario.probes?.includes(probe) && scenario.writeConsent) {
        if(typeof scenario.operationId !== 'string' || !scenario.operationId.length || !probe.correlation || !['equals','includes'].includes(probe.correlation.op) || probe.correlation.value !== scenario.operationId)throw Error('Business probe requires explicit operation correlation');
        validateCheck(probe.correlation);
      }
      if (probe.id !== undefined) safeId(probe.id);
    }
    for (const check of scenario.assertions || []) validateCheck(check);
    for (const step of scenario.steps || []) {
      safeId(step.id);
      if (step.submit !== undefined && typeof step.submit !== 'boolean') throw Error('submit must be boolean');
      if (step.action !== undefined && !['observe','navigate','click','fill','select','slider','upload','scroll'].includes(step.action)) throw Error('Unsupported authored action');
      if (step.submit && (!scenario.writeConsent?.confirmed || !step.action)) throw Error('Submission requires explicit consent and authored action');
    }
    if (new Set((scenario.steps || []).map(s=>s.id)).size !== (scenario.steps || []).length) throw Error('Duplicate step identifier');
  }
  if (new Set((config.scenarios || []).map(s=>s.id)).size !== (config.scenarios || []).length) throw Error('Duplicate scenario identifier');
  if (config.maxNetworkRequests !== undefined && (!Number.isSafeInteger(config.maxNetworkRequests) || config.maxNetworkRequests < 1)) throw Error('Invalid network budget');
  for(const [name,max] of [['maxObservations',10000],['maxArtifactBytes',1024*1024*1024]])if(config[name]!==undefined && (!Number.isSafeInteger(config[name])||config[name]<1||config[name]>max))throw Error(`Invalid ${name}`);
  if(config.viewport && (!Number.isSafeInteger(config.viewport.width)||!Number.isSafeInteger(config.viewport.height)||config.viewport.width<1||config.viewport.height<1||config.viewport.width>4096||config.viewport.height>4096))throw Error('Bounded viewport required');
  for (const name of ['maxExternalActions','maxRepeatedStates']) if (config[name] !== undefined && (!Number.isSafeInteger(config[name]) || config[name] < 1)) throw Error(`Invalid ${name}`);
  if(config.budget?.maxDurationMs!==undefined&&(!Number.isSafeInteger(config.budget.maxDurationMs)||config.budget.maxDurationMs<1))throw Error('Invalid deadline');
  if(config.budget?.workerTimeoutMs!==undefined&&(!Number.isSafeInteger(config.budget.workerTimeoutMs)||config.budget.workerTimeoutMs<1||config.budget.workerTimeoutMs>120000))throw Error('Invalid worker timeout');
  if (!config.budget || !Number.isSafeInteger(config.budget.maxCalls) || config.budget.maxCalls < 0 || !Number.isSafeInteger(config.budget.maxCostMicros) || config.budget.maxCostMicros < 0 || !Number.isFinite(config.budget.reserveFraction) || !(config.budget.reserveFraction >= 0 && config.budget.reserveFraction < 1) || !Number.isSafeInteger(config.budget.quotaMaxAgeMs) || config.budget.quotaMaxAgeMs < 1) throw Error('Invalid persistent budget');
  return config;
}
function validatePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[?#\\\s]/.test(value) || new URL(value, 'https://qa.invalid').pathname !== value) throw Error('Exact canonical path required');
}
function validateCheck(check) {
  if (!check || typeof check.path !== 'string' || !check.path.length || !['equals','includes','sum'].includes(check.op) || !Object.hasOwn(check,'value')) throw Error('Explicit assertion path, operation and value required');
  if (check.op === 'includes' && typeof check.value !== 'string') throw Error('includes requires string expectation');
  if (check.op === 'sum' && !Number.isFinite(check.value)) throw Error('sum requires finite expectation');
  if(!jsonValue(check.value))throw Error('JSON-compatible finite assertion expectation required');
}
function jsonValue(value,depth=0,seen=new Set()) {
  if(depth>64)return false;
  if(value===null || typeof value==='string' || typeof value==='boolean')return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(!value || typeof value!=='object' || seen.has(value))return false;
  if(!Array.isArray(value) && ![Object.prototype,null].includes(Object.getPrototypeOf(value)))return false;
  seen.add(value);
  const result=Object.values(value).every(v=>jsonValue(v,depth+1,seen));seen.delete(value);return result;
}
function validateEndpoint(endpoint, read) {
  validatePath(endpoint?.path);
  if (!Array.isArray(endpoint.methods) || !endpoint.methods.length || endpoint.methods.some(m=>!['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'].includes(m)) || new Set(endpoint.methods).size !== endpoint.methods.length) throw Error('Exact methods required');
  if (read && endpoint.methods.some(m => !['GET', 'HEAD'].includes(m))) throw Error('Safe reads only GET/HEAD');
  if (!read && (!Number.isSafeInteger(endpoint.maxRequests) || endpoint.maxRequests < 1)) throw Error('Bounded request count required');
  if (endpoint.allowedFields !== undefined && (!Array.isArray(endpoint.allowedFields) || endpoint.allowedFields.some(f=>typeof f!=='string' || !f.length))) throw Error('allowedFields must be an array of field names');
  if (endpoint.bodyChecks !== undefined) {
    if (!Array.isArray(endpoint.bodyChecks)) throw Error('bodyChecks must be an array');
    for (const check of endpoint.bodyChecks) validateCheck(check);
  }
}
export class Policy {
  constructor(config, store) { this.config = config; this.store = store; this.active = null; }
  isRead(url, method) {
    const u = new URL(url);
    return u.origin === this.config.origin && !u.username && !u.password && !u.search && this.config.reads.some(r => r.path === u.pathname && r.methods.includes(method));
  }
  request(url, method, payload = null) {
    this.store.assertOpen();
    if ((this.store.state.networkRequests || 0) >= (this.config.maxNetworkRequests || 500)) return {allow:false,reason:'Persistent network budget exhausted'};
    if (this.isRead(url, method)) {
      this.store.state.networkRequests=(this.store.state.networkRequests || 0)+1;
      this.store.commit('safe-read-dispatched',{method});
      return { allow: true, kind: 'declared-read' };
    }
    const u = new URL(url), intent = this.active && this.store.state.intents[this.active];
    if (u.origin !== this.config.origin || u.search || u.username || u.password || !intent || intent.phase !== 'attempted') return { allow: false, reason: 'No active scoped consent' };
    if(this.config.budget.maxDurationMs && Date.now()-Date.parse(this.store.state.createdAt)>=this.config.budget.maxDurationMs)return {allow:false,reason:'Campaign deadline reached; write denied'};
    const index = intent.endpoints.findIndex(e => e.path === u.pathname && e.methods.includes(method));
    const endpoint = this.config.scenarios.find(s=>s.id===intent.scenario)?.writeConsent?.endpoints[index] || intent.endpoints[index];
    if (!endpoint || (intent.requests[index] || 0) >= endpoint.maxRequests) return { allow: false, reason: 'Endpoint or request cap denied' };
    if (endpoint.bodyChecks?.length || endpoint.allowedFields) {
      let data;
      try { data = JSON.parse(payload); } catch { return { allow:false, reason:'Declared JSON body required' }; }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return {allow:false,reason:'Declared JSON object required'};
      if (endpoint.allowedFields && Object.keys(data).some(k=>!endpoint.allowedFields.includes(k))) return {allow:false,reason:'Undeclared payload field'};
      if (endpoint.bodyChecks?.some(c=>!checkValue(readPath(data,c.path),c))) return {allow:false,reason:'Payload outside consent scope'};
    }
    intent.requests[index] = (intent.requests[index] || 0) + 1;
    this.store.state.networkRequests=(this.store.state.networkRequests || 0)+1;
    this.store.commit('network-dispatched', { intent: this.active, endpoint: index, method });
    return { allow: true, kind: 'write', intent: this.active };
  }
}

export class Redactor {
  constructor(secrets = []) { this.secrets = [...new Set(secrets.filter(v=>v!==null && v!==undefined && String(v).length).flatMap(v => [String(v), encodeURIComponent(v)]))].sort((a,b)=>b.length-a.length); }
  text(value) {
    let clean = String(value);
    for (const secret of this.secrets) clean = clean.split(secret).join('[REDACTED]');
    return clean.replace(/\bBearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]');
  }
  value(value) {
    const clean = item => {
      if (typeof item === 'string') return this.text(item);
      if (Array.isArray(item)) return item.map(clean);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key,entry])=>[this.text(key),clean(entry)]));
      return item;
    };
    return clean(JSON.parse(JSON.stringify(value)));
  }
}

export function readPath(value, key) {
  for (const part of key.split('.')) value = value != null && Object.hasOwn(Object(value),part) ? value[part] : undefined;
  return value;
}
export function checkValue(actual, check) {
  if (check.op === 'equals') return isDeepStrictEqual(actual,check.value);
  if (check.op === 'includes') return (typeof actual === 'string' || Array.isArray(actual)) && actual.includes(check.value);
  if (check.op === 'sum') return Array.isArray(actual) && actual.every(Number.isFinite) && actual.reduce((a,b) => a+b,0) === check.value;
  throw Error('Unknown assertion operation');
}
