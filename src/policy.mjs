import { safeId } from './store.mjs';

export function validateConfig(config) {
  safeId(config.id);
  for(const [id,definition] of Object.entries(config.agents || {})){safeId(id);if(!definition.kind)throw Error('Agent provider kind required');}
  if(config.agents&&(!config.defaultAgent||!config.agents[config.defaultAgent]))throw Error('Explicit defaultAgent required');
  const origin = new URL(config.origin);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.origin !== config.origin) throw Error('Plain origin required');
  if (origin.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw Error('HTTPS required except loopback fixtures');
  for (const read of config.reads || []) validateEndpoint(read, true);
  for (const scenario of config.scenarios || []) {
    safeId(scenario.id);
    if(scenario.agent&&!config.agents?.[scenario.agent])throw Error('Scenario agent not declared');
    if (scenario.writeConsent) {
      if (scenario.writeConsent.confirmed !== true || !scenario.writeConsent.reason) throw Error('Explicit write consent required');
      for (const endpoint of scenario.writeConsent.endpoints) validateEndpoint(endpoint, false);
    }
    for (const probe of [...(scenario.probes || []),...(scenario.readChecks || [])]) {
      if ((scenario.probes?.includes(probe) && !['confirmed', 'rejected'].includes(probe.verdict)) || !probe.path || !Array.isArray(probe.checks) || !probe.checks.length) throw Error('Probe requires explicit checks');
      if (!config.reads.some(r => r.path === probe.path && r.methods.includes('GET'))) throw Error('Probe not declared as safe read');
    }
    for (const step of scenario.steps || []) safeId(step.id);
    if (new Set((scenario.steps || []).map(s=>s.id)).size !== (scenario.steps || []).length) throw Error('Duplicate step identifier');
  }
  if (new Set((config.scenarios || []).map(s=>s.id)).size !== (config.scenarios || []).length) throw Error('Duplicate scenario identifier');
  if (config.maxNetworkRequests !== undefined && (!Number.isSafeInteger(config.maxNetworkRequests) || config.maxNetworkRequests < 1)) throw Error('Invalid network budget');
  if(config.budget?.maxDurationMs!==undefined&&(!Number.isSafeInteger(config.budget.maxDurationMs)||config.budget.maxDurationMs<1))throw Error('Invalid deadline');
  if (!config.budget || !Number.isSafeInteger(config.budget.maxCalls) || config.budget.maxCalls < 0 || !Number.isSafeInteger(config.budget.maxCostMicros) || config.budget.maxCostMicros < 0 || !(config.budget.reserveFraction >= 0 && config.budget.reserveFraction < 1) || !(config.budget.quotaMaxAgeMs > 0)) throw Error('Invalid persistent budget');
  return config;
}
function validateEndpoint(endpoint, read) {
  if (!endpoint.path?.startsWith('/') || endpoint.path.startsWith('//') || endpoint.path.includes('?') || endpoint.path.includes('#') || !Array.isArray(endpoint.methods) || !endpoint.methods.length) throw Error('Exact path and methods required');
  if (read && endpoint.methods.some(m => !['GET', 'HEAD'].includes(m))) throw Error('Safe reads only GET/HEAD');
  if (!read && (!Number.isSafeInteger(endpoint.maxRequests) || endpoint.maxRequests < 1)) throw Error('Bounded request count required');
}
export class Policy {
  constructor(config, store) { this.config = config; this.store = store; this.active = null; }
  isRead(url, method) {
    const u = new URL(url);
    return u.origin === this.config.origin && !u.username && !u.password && !u.search && this.config.reads.some(r => r.path === u.pathname && r.methods.includes(method));
  }
  request(url, method, payload = null) {
    if ((this.store.state.networkRequests || 0) >= (this.config.maxNetworkRequests || 500)) return {allow:false,reason:'Persistent network budget exhausted'};
    if (this.isRead(url, method)) {
      this.store.state.networkRequests=(this.store.state.networkRequests || 0)+1;
      this.store.commit('safe-read-dispatched',{method});
      return { allow: true, kind: 'declared-read' };
    }
    const u = new URL(url), intent = this.active && this.store.state.intents[this.active];
    if (u.origin !== this.config.origin || u.search || u.username || u.password || !intent || intent.phase !== 'attempted') return { allow: false, reason: 'No active scoped consent' };
    const index = intent.endpoints.findIndex(e => e.path === u.pathname && e.methods.includes(method));
    const endpoint = intent.endpoints[index];
    if (!endpoint || (intent.requests[index] || 0) >= endpoint.maxRequests) return { allow: false, reason: 'Endpoint or request cap denied' };
    if (endpoint.bodyChecks?.length || endpoint.allowedFields) {
      let data;
      try { data = JSON.parse(payload); } catch { return { allow:false, reason:'Declared JSON body required' }; }
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
  constructor(secrets = []) { this.secrets = secrets.filter(Boolean).flatMap(v => [String(v), encodeURIComponent(v)]); }
  text(value) {
    let clean = String(value);
    for (const secret of this.secrets) clean = clean.split(secret).join('[REDACTED]');
    return clean.replace(/\bBearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]');
  }
  value(value) { return JSON.parse(this.text(JSON.stringify(value))); }
}

export function readPath(value, key) {
  for (const part of key.split('.')) value = value?.[part];
  return value;
}
export function checkValue(actual, check) {
  if (check.op === 'equals') return JSON.stringify(actual) === JSON.stringify(check.value);
  if (check.op === 'includes') return typeof actual === 'string' && actual.includes(check.value);
  if (check.op === 'sum') return Array.isArray(actual) && actual.every(Number.isFinite) && actual.reduce((a,b) => a+b,0) === check.value;
  throw Error('Unknown assertion operation');
}
