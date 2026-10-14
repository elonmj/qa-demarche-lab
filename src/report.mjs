import fs from 'node:fs';
import path from 'node:path';
export function reportExitCode(report) {
  if (report.holds) return 2;
  if (report.coverage.some(c=>c.verdict==='fail')) return 3;
  if (report.providerFault || report.pendingWorker || report.missions?.some(m=>['blocked','interrupted','attempted'].includes(m.status)) || report.coverage.some(c=>['not-run','blocked-prerequisite','inconclusive'].includes(c.verdict))) return 4;
  return 0;
}
export function writeReport(store, config) {
  store.assertOpen();
  const state = store.state;
  const report = { label: 'Agents simulant une démarche de QA humain — noyau expérimental', id: config.id, calls: state.calls, reservedMicros: state.reservedMicros, holds: state.holds.length, intents: Object.values(state.intents), coverage: [...state.coverage], hypotheses: state.candidates, observations: state.observations.map(o=>({id:o.id,path:o.path,screenshot:o.screenshot,errors:o.errors,overflow:o.overflow})), limits: ['Un verdict métier vaut seulement pour les checks et le périmètre des probes configurés.', 'Aucune certification exhaustive, de paie ou de sécurité serveur.', 'Hypothèses du modèle non confirmées : revue indépendante requise.', 'Captures privées ; masquage des secrets connus ne garantit pas anonymisation de toutes données.'] };
  // Missing configured checks are report projections, never fabricated ledger reads.
  for (const scenario of config.scenarios) {
    const checks = [...(scenario.assertions || []),...(scenario.readChecks || [])];
    for (const check of checks) {
      const ambiguous = !check.id || check.id==='business-outcome' || checks.filter(c=>c.id===check.id).length>1;
      if (ambiguous || !state.coverage.some(c=>c.scenario===scenario.id && c.check===check.id)) report.coverage.push({scenario:scenario.id,check:check.id || '(unnamed)',verdict:ambiguous?'blocked-prerequisite':'not-run',evidence:[],...(ambiguous?{reason:'Legacy check identities ambiguous; review required'}:{})});
    }
  }
  report.workers=state.workerUsage || {};
  report.findings=report.hypotheses.filter(c=>['ui-assertion-failure','deterministic-failure'].includes(c.kind));
  report.limits.push('Les compteurs de requêtes sont des réservations durables avant transport ; ils ne prouvent pas leur réception par le serveur.');
  report.missions=config.scenarios.map(s=>{
    const mission=state.missions?.[s.id];
    const steps=Object.entries(state.steps).filter(([key])=>key.startsWith(`${s.id}/`)).map(([,step])=>step);
    const intent=Object.values(state.intents).find(i=>i.scenario===s.id);
    const factual=steps.length?{mode:'steps',status:intent?.phase || (steps.every(step=>step.phase==='observed')?'observed':'attempted'),observation:steps.at(-1).after || steps.at(-1).before}: {status:'not-run'};
    const incomplete = steps.some(step=>!step.intent && step.phase!=='observed');
    return {id:s.id,role:intent?.role || s.role || config.role || steps.at(-1)?.role || state.defaultRole || 'visitor',...(mission || factual),
      ...(mission?.status==='running'?{status:'interrupted',reason:'Mission has no durable stop event; review required before resume'}:{}),
      ...(incomplete && mission?.status!=='running'?{status:'attempted',lastRunStatus:mission?.status || null,reason:'A preparation gesture has no durable resulting observation; review required, no replay'}:{})};
  });
  report.actions=Object.entries(state.steps).map(([id,step])=>({id,...step}));
  report.providerFault=state.providerFault || null;
  report.pendingWorker=state.pendingWorker || null;
  report.costMeaning=Object.values(report.workers).some(w=>w.billingMode==='subscription')?'Subscription CLI: reported USD cost is unavailable; zero reservation is not a zero-cost invoice.':'Persistent maximum reservations; not a supplier invoice.';
  report.exitCode=reportExitCode(report);
  fs.writeFileSync(path.join(store.directory,'report.json'),JSON.stringify(report,null,2));
  const line = value => String(value ?? '').replace(/[\r\n|]/g,' ');
  const outcomeProof = intent => ['confirmed','rejected'].includes(intent.phase) ? (intent.outcomeEvidence || intent.evidence.filter(e=>e.matched && e.verdict===intent.phase).map(e=>e.id)).join(', ') : '';
  const candidates = report.hypotheses.map(c=>c.kind==='ui-assertion-failure'?`- Échec UI ${line(c.scenario)} / ${line(c.check)} (${line(c.page)}, rôle ${line(c.role)}) : ${line(c.path)} ${line(c.op)}, attendu ${line(JSON.stringify(c.expected))} ; observé ${line(JSON.stringify(c.observed))}. Impact : ${line(c.impact)}. Reproduction : scénario ${line(c.scenario)}, page ${line(c.page)}, viewport ${line(JSON.stringify(c.viewport))}, gestes ${line(JSON.stringify(c.reproduction?.actions || []))}. Preuves : ${line(c.evidenceIds.join(', '))}. Limite : ${line(c.qualification)}.`:c.kind==='deterministic-failure'?`- Contrôle ${line(c.check)} : attendu ${line(JSON.stringify(c.expected))} ; observé ${line(JSON.stringify(c.observed[0]?.checks))}. Impact : ${line(c.impact)}. Reproduction : scénario ${line(c.scenario)}, puis deux lectures de contrôle ; preuve UI ${c.evidence}. Portée et revue : ${line(c.qualification)}.`:`- Proposition non confirmée : ${line(c.claim || JSON.stringify(c.finding))}. Preuve UI ${c.evidence}. Impact à revoir indépendamment.`).join('\n');
  const markdown = `# Rapport QA — ${line(config.id)}\n\n${report.label}\n\n${report.calls} appels ; réservation ${report.reservedMicros} micro-USD ; ${report.holds} intention(s) non rapprochée(s).\n\n| Scénario | Observé par le moteur | Reproduction | Preuve indépendante |\n|---|---|---|---|\n` + report.intents.map(i=>`| ${line(i.scenario)} | ${i.phase} | configuration scénario ${line(i.scenario)}, étape ${line(i.step)} ; ne pas resoumettre | ${outcomeProof(i) || 'aucune preuve concluante'} |`).join('\n') + '\n\n## Contrôles\n\n' + report.coverage.map(c=>`- ${line(c.scenario)} / ${line(c.check)} : ${c.verdict} (${c.evidence.join(', ')})`).join('\n') + '\n\n## Observations, hypothèses et impact\n\n' + (candidates || 'Aucune hypothèse modèle.') + '\n\n' + report.limits.map(l=>`- ${l}`).join('\n') + '\n\nLes valeurs attendues/observées, scopes (unité/date/fuseau/compte) et preuves sont dans report.json. Les images observation-*.png sont locales et privées. Une absence de requête ou HTTP 200 ne prouve aucun succès métier.\n';
  const missions='\n## Missions\n\n| Mission | Rôle | État | Appels du passage | Arrêt / dernière preuve |\n|---|---|---|---|---|\n'+report.missions.map(m=>`| ${line(m.id)} | ${line(m.role)} | ${line(m.status)} | ${m.callsUsed ?? '—'} | ${line(m.reason || m.observation || '—')} |`).join('\n')+'\n\n`observed` décrit une observation ; `bounded` indique une borne atteinte. Aucun de ces états ne certifie un résultat métier.\n';
  fs.writeFileSync(path.join(store.directory,'REPORT.md'),markdown+missions+`\nCoûts : ${report.costMeaning}\n\nAgents exécutants : ${Object.entries(report.workers).map(([id,w])=>`${id}: ${w.calls} appel(s), ${w.reportedTokens == null?'tokens indisponibles':`${w.reportedTokens} tokens rapportés`}${(w.usageReportedCalls || 0)<w.calls?' (usage incomplet)':''}, ${w.billingMode}`).join(' ; ') || 'aucun appel modèle'}.\n`);
  return report;
}
