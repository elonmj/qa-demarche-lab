// Supplier usage is a declaration, not a bill. Cached/reasoning tokens are subsets
// of input/output and must not be counted again. Missing counters are unknown.
export function tokenCount(usage) {
  const count=value=>Number.isSafeInteger(value)&&value>=0;
  for(const key of ['total_tokens','totalTokens'])if(count(usage?.[key]))return usage[key];
  for(const [input,output] of [['input_tokens','output_tokens'],['inputTokens','outputTokens'],['prompt_tokens','completion_tokens']]) {
    if(count(usage?.[input])&&count(usage?.[output])) {
      const total=usage[input]+usage[output];return count(total)?total:null;
    }
  }
  return null;
}
