import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Redactor, readPath, checkValue } from './policy.mjs';
import { readJson } from './bounds.mjs';

export class BrowserAdapter {
  constructor(config, policy, store, privateOptions = {}) {
    this.config = config; this.policy = policy; this.store = store;
    this.privateOptions = privateOptions;
    const sessionSecrets = Object.values(privateOptions.roles || {}).flatMap(role=>[...Object.values(role.headers || {}),...Object.values(role.probeHeaders || {}),...(role.storageState?.cookies || []).map(c=>c.value),...(role.storageState?.origins || []).flatMap(o=>(o.localStorage || []).map(s=>s.value))]);
    this.redactor = new Redactor([...(privateOptions.secrets || []),...sessionSecrets]);
    this.errors = []; this.network = []; this.refs = []; this.snapshotId = null;
  }
  async start(role = 'visitor') {
    this.role = role;
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({ viewport: this.config.viewport || { width: 390, height: 844 }, serviceWorkers: 'block', acceptDownloads:false, storageState: this.privateOptions.roles?.[role]?.storageState, extraHTTPHeaders: this.privateOptions.roles?.[role]?.headers });
    await this.context.routeWebSocket('**/*', socket => socket.close());
    await this.context.route('**/*', async route => {
      const request = route.request();
      let result;
      try { result = this.policy.request(request.url(), request.method(), request.postData()); }
      catch { result = {allow:false,reason:'Journal unavailable; request denied'}; }
      // Never persist headers, query strings, request/response bodies or raw URLs.
      const row = { method: request.method(), path: this.redactor.text(new URL(request.url()).pathname), ...result };
      if(this.network.length<500)this.network.push(row);else this.networkDropped=(this.networkDropped || 0)+1;
      if (result.allow) {
        const response = await route.fetch({ maxRedirects: 0 }).catch(() => null);
        if (!response) { row.transport = 'failed'; return route.abort(); }
        row.httpStatus = response.status();
        if (response.status() >= 300 && response.status() < 400) { row.transport = 'redirect-blocked'; return route.abort(); }
        await route.fulfill({ response });
      } else await route.abort();
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(1200); this.page.setDefaultNavigationTimeout(5000);
    const recordError=message=>{if(this.errors.length<100)this.errors.push(this.redactor.text(message).slice(0,2000));else this.errorsDropped=(this.errorsDropped || 0)+1;};
    this.page.on('pageerror', error => recordError(error.message));
    this.page.on('console', message => { if (message.type() === 'error') recordError(message.text()); });
    this.page.on('dialog', dialog => dialog.dismiss());
    await this.page.goto(this.config.origin + (this.config.entry || '/'), { waitUntil: 'domcontentloaded' });
  }
  async observe() {
    this.store.assertOpen();
    for (const ref of this.refs) await ref.handle.dispose().catch(() => {});
    this.refs = []; this.snapshotId = randomUUID();
    const selector='button,a[href],input,select,textarea,[role="slider"],[role="button"]';
    if(await this.page.locator(selector).count()>200)throw Error('DOM control cap reached; observation refused');
    const handles = await this.page.$$(selector);
    const elements = [];
    for (const handle of handles) {
      const descriptor = await handle.evaluate((element,sensitiveSelectors) => {
        const r = element.getBoundingClientRect(), style = getComputedStyle(element);
        const visible = element.isConnected && r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        const x = (Math.max(0,r.left) + Math.min(innerWidth,r.right))/2, y = (Math.max(0,r.top) + Math.min(innerHeight,r.bottom))/2;
        const hit = visible && document.elementFromPoint(x,y);
        const occluded = visible && hit !== element && !element.contains(hit);
        const name = (element.getAttribute('aria-label') || [...(element.labels || [])].map(l => l.innerText).join(' ') || element.innerText || '').trim();
        if(name.length>100000 || (element.value?.length || 0)>100000)throw Error('Control text cap reached');
        return { visible:visible && !sensitiveSelectors.some(selector=>element.closest(selector)), occluded, disabled: !!element.disabled || element.getAttribute('aria-disabled') === 'true', tag: element.tagName, type: element.getAttribute('type'), name, value: element.type === 'password' ? '[REDACTED]' : element.value || null, href: element.tagName === 'A' ? element.getAttribute('href')?.split(/[?#]/)[0] : null };
      },this.config.sensitiveSelectors || []).catch(error => {if(error.message.includes('text cap'))throw Error('Control text cap reached');return null;});
      if (!descriptor?.visible || descriptor.occluded) { await handle.dispose(); continue; }
      const signature = JSON.stringify([descriptor.tag,descriptor.type,descriptor.name]);
      this.refs.push({ handle, descriptor, signature });
      const clean=this.redactor.value({ ...descriptor, ref: this.refs.length - 1 });
      clean.name=clean.name.slice(0,160); if(typeof clean.value==='string')clean.value=clean.value.slice(0,2000);
      elements.push(clean);
    }
    const text = await this.page.evaluate(selectors=>{
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),lines=[];let node;
      let length=0,count=0;
      while((node=walker.nextNode())){if(++count>20000)throw Error('DOM node cap reached');const parent=node.parentElement;if(!parent || parent.closest('script,style') || selectors.some(s=>parent.closest(s)))continue;const r=parent.getBoundingClientRect(),style=getComputedStyle(parent);if(r.width&&r.height&&style.display!=='none'&&style.visibility!=='hidden'&&node.textContent.trim()){const text=node.textContent.trim();length+=text.length;if(length>100000)throw Error('DOM text cap reached');lines.push(text);}}
      return lines.join('\n');
    },this.config.sensitiveSelectors || []);
    // Screenshots are private artifacts. Known secrets and owner-specified sensitive regions
    // are masked at capture time; raw Playwright traces intentionally remain disabled.
    const mask = [this.page.locator('input,textarea')];
    for (const selector of this.config.sensitiveSelectors || []) mask.push(this.page.locator(selector));
    for (const secret of this.redactor.secrets) mask.push(this.page.getByText(secret, { exact: false }));
    const file = `observation-${this.snapshotId}.png`;
    const png=await this.page.screenshot({ mask, timeout: 4000 });
    const view = this.redactor.value({ id: this.snapshotId, role: this.role, path: new URL(this.page.url()).pathname, text: this.redactor.text(text).slice(0,14000), elements, screenshot: file, errors: this.errors.splice(0), network: this.network.splice(0), overflow: await this.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), busy: await this.page.locator('[aria-busy=true]').evaluateAll(nodes=>nodes.some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';})), viewport: this.page.viewportSize() });
    this.store.assertOpen();
    view.errorsDropped=this.errorsDropped || 0;view.networkDropped=this.networkDropped || 0;
    this.errorsDropped=0;this.networkDropped=0;
    const json=JSON.stringify(view,null,2),bytes=png.byteLength+Buffer.byteLength(json);
    if((this.store.state.artifactBytes || 0)+bytes>(this.config.maxArtifactBytes || 64*1024*1024))throw Error('Persistent artifact byte cap reached; no capture written');
    this.store.state.artifactBytes=(this.store.state.artifactBytes || 0)+bytes;
    this.store.commit('artifacts-reserved',{id:view.id,bytes});
    fs.writeFileSync(path.join(this.store.directory,file),png,{mode:0o600});
    fs.writeFileSync(path.join(this.store.directory,`observation-${view.id}.json`), json,{mode:0o600});
    return view;
  }
  async act(decision) {
    this.store.assertOpen();
    if (decision.action === 'navigate') {
      const url = new URL(decision.path, this.config.origin);
      if (!this.policy.isRead(url.href, 'GET')) throw Error('Navigation undeclared');
      await this.page.goto(url.href, { waitUntil: 'domcontentloaded' }); return;
    }
    if (decision.action === 'observe') return;
    if (decision.action === 'scroll') { await this.page.mouse.move(this.page.viewportSize().width/2,this.page.viewportSize().height/2);await this.page.mouse.wheel(0,Math.max(-800,Math.min(800,Number(decision.value)||550)));return; }
    if (decision.snapshotId !== this.snapshotId) throw Error('Stale snapshot');
    const ref = this.refs[decision.ref];
    if (!ref) throw Error('Unknown control reference');
    const valid = await ref.handle.evaluate((e, signature) => {
      const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      const name = (e.getAttribute('aria-label') || [...(e.labels || [])].map(l=>l.innerText).join(' ') || e.innerText || '').trim();
      const hit = document.elementFromPoint((Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2);
      return e.isConnected && r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none' && s.opacity!=='0' && !e.disabled && e.getAttribute('aria-disabled')!=='true' && (hit===e || e.contains(hit)) && JSON.stringify([e.tagName,e.getAttribute('type'),name])===signature;
    },ref.signature).catch(() => false);
    if (!valid) throw Error('Control changed, hidden, disabled or occluded');
    this.store.assertOpen();
    const el = ref.handle;
    if (decision.action === 'click') await el.click();
    else if (decision.action === 'fill') {
      if (ref.descriptor.type === 'password') throw Error('Credentials belong to private bootstrap');
      await el.fill(decision.text);
    } else if (decision.action === 'select') await el.selectOption({ label: decision.value });
    else if (decision.action === 'slider') {
      const box = await el.boundingBox();
      if (!box || !Number.isFinite(decision.value) || decision.value < 0 || decision.value > 1) throw Error('Slider requires ratio 0..1');
      await this.page.mouse.move(box.x+2,box.y+box.height/2);
      await this.page.mouse.down();
      try { await this.page.mouse.move(box.x+2+(box.width-4)*decision.value,box.y+box.height/2,{steps:12}); } finally { await this.page.mouse.up(); }
    } else if (decision.action === 'upload') {
      const file = this.config.uploadFixtures?.[decision.value];
      if (!file || ref.descriptor.type !== 'file') throw Error('Only owner-supplied synthetic upload payload allowed');
      await el.setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: Buffer.from(file.content) });
    } else throw Error('Unsupported browser action');
  }
  async probe(probe, {timeoutMs=1500,signal} = {}) {
    const url = this.config.origin + probe.path;
    if (!this.policy.request(url, 'GET').allow) throw Error('Probe is not a declared read or network budget exhausted');
    // New transport, no browser cache, no DOM or model assertion as business oracle.
    const response = await fetch(url, { headers: { ...(this.privateOptions.roles?.[this.role]?.probeHeaders || {}), 'cache-control': 'no-cache' }, redirect: 'error', signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); return { available:false, matched: false, httpStatus: response.status, checks: [], scope: probe.scope || null }; }
    const data = await readJson(response,100000,'Probe');
    const checks = probe.checks.map(check => ({ path: check.path, expected: check.value, observed: readPath(data,check.path), pass: checkValue(readPath(data,check.path),check) }));
    const scopeChecks = (probe.scopeChecks || []).map(check=>({path:check.path,expected:check.value,observed:readPath(data,check.path),pass:checkValue(readPath(data,check.path),check)}));
    const correlated=probe.correlation && readPath(data,probe.correlation.path);
    const correlation = probe.correlation ? {path:probe.correlation.path,expected:probe.correlation.value,observed:correlated,pass:(probe.correlation.op!=='includes' || Array.isArray(correlated)) && checkValue(correlated,probe.correlation)} : null;
    return this.redactor.value({ available:true, matched: checks.every(c => c.pass) && scopeChecks.every(c=>c.pass) && (!correlation || correlation.pass), httpStatus: response.status, checks, scope: probe.scope || null,scopeChecks,scopeMatched:scopeChecks.every(c=>c.pass),scopeAssurance:scopeChecks.length?'explicit-checks':'owner-declared-metadata-only',correlation });
  }
  async close() { await this.browser?.close(); }
}
