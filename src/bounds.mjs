// Transport caps apply while streaming (including decompressed fetch bodies), not after
// accumulating arbitrary responses. No retry; cancel the transport on every rejection.
export async function readJson(response, maxBytes, label = 'Response') {
  const reader = response.body?.getReader();
  if (!reader) throw Error(`${label} body unavailable`);
  const chunks = []; let bytes = 0;
  try {
    for (;;) {
      const {value,done} = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw Error(`${label} reply too large`);
      chunks.push(value);
    }
    const data = Buffer.concat(chunks,bytes);
    try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data)); }
    catch { throw Error(`${label} returned invalid JSON`); }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

export async function boundedCall(fn, timeoutMs, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort',abort,{once:true});
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(()=>{controller.signal.throwIfAborted();return fn(controller.signal);}),
      new Promise((_,reject)=>{
        controller.signal.addEventListener('abort',()=>reject(Error('Worker timeout or campaign deadline; no retry')),{once:true});
        timer = setTimeout(()=>controller.abort(),timeoutMs);
      })
    ]);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
}
