// Models propose a single bounded action. They receive no tools, credentials or raw trace.
export class ScriptedProvider {
  constructor(decide) { this.id = 'scripted-fixture'; this.maxCostMicros = 0; this.capabilities = { json: true, vision: false, live: false }; this.decide = decide; }
  async quota() { return { available: true, remainingFraction: 1, checkedAt: Date.now() }; }
}

// Explicit gateway contract, usable for any vendor behind a trusted local/service adapter.
// No auto-retries, fallback, SDK environment loading or automatic credit purchase.
export class JsonGatewayProvider {
  constructor({ id, endpoint, quotaEndpoint, maxCostMicros, token, model }) {
    for (const target of [endpoint, quotaEndpoint]) {
      const url = new URL(target);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1')) throw Error('Secure provider endpoint required');
      if (url.username || url.password) throw Error('Credentials in URL denied');
    }
    this.id = id; this.endpoint = endpoint; this.quotaEndpoint = quotaEndpoint; this.maxCostMicros = maxCostMicros; this.token = token; this.model = model;
    this.capabilities = { json: true, vision: false, live: true };
  }
  async quota() {
    const response = await fetch(this.quotaEndpoint, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) throw Error('Provider quota unavailable');
    return response.json();
  }
  async decide(input) {
    const response = await fetch(this.endpoint, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20000), body: JSON.stringify({ model: this.model, maxCostMicros: this.maxCostMicros, input }) });
    if (!response.ok) throw Error('Provider request rejected; no retry');
    const text = await response.text();
    if (text.length > 20000) throw Error('Provider reply too large');
    return JSON.parse(text);
  }
}

export function validateDecision(decision) {
  const allowed = ['action', 'ref', 'snapshotId', 'text', 'value', 'path', 'intent', 'claim', 'finding'];
  if (!decision || typeof decision !== 'object' || Array.isArray(decision) || Object.keys(decision).some(k => !allowed.includes(k)) || !['observe','scroll','click','fill','select','slider','upload','navigate','finish'].includes(decision.action)) throw Error('Invalid model decision');
  if (['click','fill','select','slider','upload'].includes(decision.action) && (!Number.isSafeInteger(decision.ref) || decision.ref<0 || typeof decision.snapshotId !== 'string' || !decision.snapshotId.length)) throw Error('Fresh reference required');
  if (decision.action === 'fill' && typeof decision.text !== 'string') throw Error('Explicit fill text required');
  if (['select','upload'].includes(decision.action) && typeof decision.value !== 'string') throw Error('Explicit selection value required');
  if (decision.action === 'slider' && (!Number.isFinite(decision.value) || decision.value<0 || decision.value>1)) throw Error('Slider requires ratio 0..1');
  if (decision.action === 'scroll' && decision.value !== undefined && decision.value !== null && !Number.isFinite(decision.value)) throw Error('Scroll requires finite value');
  if (decision.action === 'navigate' && (typeof decision.path !== 'string' || !decision.path.startsWith('/') || decision.path.startsWith('//'))) throw Error('Local navigation only');
  return decision;
}
