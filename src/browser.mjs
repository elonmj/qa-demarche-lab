import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { Redactor, readPath, checkValue } from './policy.mjs';

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
      this.network.push(row);
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
    this.page.on('pageerror', error => this.errors.push(this.redactor.text(error.message)));
    this.page.on('console', message => { if (message.type() === 'error') this.errors.push(this.redactor.text(message.text())); });
    this.page.on('dialog', dialog => dialog.dismiss());
    await this.page.goto(this.config.origin + (this.config.entry || '/'), { waitUntil: 'domcontentloaded' });
  }
  async observe() {
    for (const ref of this.refs) await ref.handle.dispose().catch(() => {});
    this.refs = []; this.snapshotId = randomUUID();
    const handles = await this.page.$$('button,a[href],input,select,textarea,[role="slider"],[role="button"]');
    const elements = [];
    for (const handle of handles) {
      const descriptor = await handle.evaluate((element,sensitiveSelectors) => {
        const r = element.getBoundingClientRect(), style = getComputedStyle(element);
        const visible = element.isConnected && r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0 && r.left < innerWidth && r.right > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
        const x = (Math.max(0,r.left) + Math.min(innerWidth,r.right))/2, y = (Math.max(0,r.top) + Math.min(innerHeight,r.bottom))/2;
        const hit = visible && document.elementFromPoint(x,y);
        const occluded = visible && hit !== element && !element.contains(hit);
        const name = (element.getAttribute('aria-label') || [...(element.labels || [])].map(l => l.innerText).join(' ') || element.innerText || '').trim().slice(0,160);
        return { visible:visible && !sensitiveSelectors.some(selector=>element.closest(selector)), occluded, disabled: !!element.disabled || element.getAttribute('aria-disabled') === 'true', tag: element.tagName, type: element.getAttribute('type'), name, value: element.type === 'password' ? '[REDACTED]' : element.value || null, href: element.tagName === 'A' ? element.getAttribute('href')?.split(/[?#]/)[0] : null };
      },this.config.sensitiveSelectors || []).catch(() => null);
      if (!descriptor?.visible || descriptor.occluded) { await handle.dispose(); continue; }
      const signature = JSON.stringify([descriptor.tag,descriptor.type,descriptor.name]);
      this.refs.push({ handle, descriptor, signature });
      elements.push(this.redactor.value({ ...descriptor, ref: this.refs.length - 1 }));
    }
    const text = await this.page.evaluate(selectors=>{
      const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),lines=[];let node;
      while((node=walker.nextNode())){const parent=node.parentElement;if(!parent || parent.closest('script,style') || selectors.some(s=>parent.closest(s)))continue;const r=parent.getBoundingClientRect(),style=getComputedStyle(parent);if(r.width&&r.height&&style.display!=='none'&&style.visibility!=='hidden'&&node.textContent.trim())lines.push(node.textContent.trim());}
      return lines.join('\n');
    },this.config.sensitiveSelectors || []);
    // Screenshots are private artifacts. Known secrets and owner-specified sensitive regions
    // are masked at capture time; raw Playwright traces intentionally remain disabled.
    const mask = [this.page.locator('input,textarea')];
    for (const selector of this.config.sensitiveSelectors || []) mask.push(this.page.locator(selector));
    for (const secret of this.redactor.secrets) mask.push(this.page.getByText(secret, { exact: false }));
    const file = `observation-${this.snapshotId}.png`;
    await this.page.screenshot({ path: path.join(this.store.directory,file), mask, timeout: 4000 });
    const view = this.redactor.value({ id: this.snapshotId, role: this.role, path: new URL(this.page.url()).pathname, text: text.slice(0,14000), elements, screenshot: file, errors: this.errors.splice(0), network: this.network.splice(0), overflow: await this.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), busy: await this.page.locator('[aria-busy=true]').evaluateAll(nodes=>nodes.some(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';})), viewport: this.page.viewportSize() });
    fs.writeFileSync(path.join(this.store.directory,`observation-${view.id}.json`), JSON.stringify(view,null,2));
    return view;
  }
  async act(decision) {
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
      const name = (e.getAttribute('aria-label') || [...(e.labels || [])].map(l=>l.innerText).join(' ') || e.innerText || '').trim().slice(0,160);
      const hit = document.elementFromPoint((Math.max(0,r.left)+Math.min(innerWidth,r.right))/2,(Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2);
      return e.isConnected && r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none' && s.opacity!=='0' && !e.disabled && e.getAttribute('aria-disabled')!=='true' && (hit===e || e.contains(hit)) && JSON.stringify([e.tagName,e.getAttribute('type'),name])===signature;
    },ref.signature).catch(() => false);
    if (!valid) throw Error('Control changed, hidden, disabled or occluded');
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
  async probe(probe) {
    const url = this.config.origin + probe.path;
    if (!this.policy.request(url, 'GET').allow) throw Error('Probe is not a declared read or network budget exhausted');
    // New transport, no browser cache, no DOM or model assertion as business oracle.
    const response = await fetch(url, { headers: { ...(this.privateOptions.roles?.[this.role]?.probeHeaders || {}), 'cache-control': 'no-cache' }, redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { available:false, matched: false, httpStatus: response.status, checks: [], scope: probe.scope || null };
    const text = await response.text();
    if (text.length > 100000) throw Error('Probe response too large');
    const data = JSON.parse(text);
    const checks = probe.checks.map(check => ({ path: check.path, expected: check.value, observed: readPath(data,check.path), pass: checkValue(readPath(data,check.path),check) }));
    return this.redactor.value({ available:true, matched: checks.every(c => c.pass), httpStatus: response.status, checks, scope: probe.scope || null });
  }
  async close() { await this.browser?.close(); }
}
