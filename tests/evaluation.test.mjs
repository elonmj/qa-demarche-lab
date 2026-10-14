import test from 'node:test';
import assert from 'node:assert/strict';
import {makeCases,confusion} from '../fixtures/seeded-evaluation.mjs';
import {challengeCases,discoveryMetrics} from '../fixtures/discovery-evaluation.mjs';

test('seed reproduces data, case order and truth; different seeds vary scenarios',()=>{
  assert.deepEqual(makeCases(17),makeCases(17));assert.notDeepEqual(makeCases(17),makeCases(18));
  assert.throws(()=>makeCases(-1));assert.throws(()=>makeCases('17'));
});

test('discovery denominator includes semantic misses and prerequisite cases',()=>{
  assert.deepEqual(challengeCases(17),challengeCases(17));assert.notDeepEqual(challengeCases(17),challengeCases(18));
  const result=discoveryMetrics([{kind:'overflow',defect:true,findings:1},{kind:'wrong-total',defect:true,findings:0},{kind:'clean',defect:false,findings:0},{kind:'resource-blocked',defect:false,findings:0,incomplete:true}]);
  assert.equal(result.recall,.5);assert.equal(result.contractRecall,1);assert.equal(result.falseNegatives,1);assert.equal(result.falsePositives,0);assert.equal(result.unresolved,1);
});
test('evaluation counts actual false positives and false negatives, including prerequisites',()=>{
  const result=confusion([{truth:'wrong-total',findings:1,verdict:'fail'},{truth:'wrong-total',findings:0,verdict:'pass'},{truth:'clean',findings:1,verdict:'fail'},{truth:'unavailable',findings:1,verdict:'blocked-prerequisite'},{truth:'clean',findings:0,verdict:'pass'}]);
  assert.equal(result.falsePositives,2);assert.equal(result.falseNegatives,1);assert.equal(result.truePositives,1);assert.equal(result.falsePositiveRate,2/3);assert.equal(result.recall,0.5);assert.equal(result.unresolved,1);
  assert.equal(confusion([]).falsePositiveRate,null);
});
