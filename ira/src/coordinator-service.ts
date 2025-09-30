import axios, { AxiosError } from 'axios';
import * as vscode from 'vscode';

// Minimal shape returned by the coordinator
export interface CoordinatorResponse {
  isFirstOccurrence: boolean;
  hint?: string;
  reasoning?: string;
  answer?: string; // we display this as "Fix" in the webview
  context?: string;
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('ira');
  const rawBase = String(cfg.get('coordinatorEndpoint') || '').trim();
  const base = rawBase.replace(/\/+$/,'');
  const apiKey = String(cfg.get('apiKey') || '').trim();
  if (!base) {
    throw new Error('IRA: coordinator endpoint is not set. Open Settings and set "IRA: Coordinator Endpoint".');
  }
  return { base, apiKey };
}

function headers(apiKey?: string) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) { h['Authorization'] = `Bearer ${apiKey}`; }
  return h;
}

function toFixText(answerAny: any): string | undefined {
  if (!answerAny) {
    return undefined;
  }
  if (typeof answerAny === 'string') {
    return answerAny;
  }
  if (typeof answerAny !== 'object') {
    return undefined;
  }
  const parts: string[] = [];
  if (answerAny.fix_explanation) {
    parts.push(`Why: ${answerAny.fix_explanation}`);
  }
  if (answerAny.patched_code) {
    parts.push(`Patched code:\n${answerAny.patched_code}`);
  }
  if (answerAny.diff_unified) {
    parts.push(`Patch (diff):\n${answerAny.diff_unified}`);
  }
  if (typeof answerAny.confidence === 'number') {
    parts.push(`Confidence: ${(answerAny.confidence * 100).toFixed(0)}%`);
  }
  return parts.join('\n\n');
}

function normalize(data: any): CoordinatorResponse {
  // Support nested { hra: { hint, reasoning, answer } } as well as top-level fields
  const root = data?.hra ? data.hra : data;

  const isFirst = !!(data?.isFirstOccurrence ?? data?.firstOccurrence ?? data?.first_time ?? false);
  const hint = root?.hint ?? data?.hint ?? root?.tier1 ?? data?.tier1 ?? root?.hint_text ?? data?.hint_text ?? undefined;
  const reasoning = root?.reasoning ?? data?.reasoning ?? root?.tier2 ?? data?.tier2 ?? root?.reasoning_text ?? data?.reasoning_text ?? undefined;

  const rawAnswer =
    root?.answer ?? data?.answer ??
    root?.fix ?? data?.fix ??
    root?.tier3 ?? data?.tier3 ??
    data?.solution;

  const answer = toFixText(rawAnswer);
  const context = data?.context ?? root?.context ?? data?.ctx ?? undefined;

  return { isFirstOccurrence: isFirst, hint, reasoning, answer, context };
}

/**
 * Send a PEM log to the coordinator and return tiers from the LLM pipeline.
 * Tries preferred endpoint first, falls back to legacy paths if needed.
 */
export async function logPemToCoordinator(entry: any): Promise<CoordinatorResponse> {
  const { base, apiKey } = getConfig();
  const opts = { headers: headers(apiKey), timeout: 20000 };

  const candidates = [
    '/v1/pems',                // preferred JSON API path
    '/process-pem',            // legacy root path
    '/pems',                   // very old root path
    '/api/pems/process-pem'    // coordinator behind API prefix
  ];

  let lastErr: any = null;
  for (const path of candidates) {
    try {
      const { data } = await axios.post(`${base}${path}`, entry, opts);
      return normalize(data);
    } catch (err) {
      const e = err as AxiosError;
      lastErr = e;
      // Retry on 404 to probe next path. Otherwise rethrow.
      if (!e.response || (e.response && e.response.status !== 404)) {
        break;
      }
    }
  }

  // Surface a clear message to the user, without mock content
  const msg = lastErr?.response
    ? `IRA coordinator error ${lastErr.response.status}: ${JSON.stringify(lastErr.response.data)}`
    : `IRA coordinator unreachable: ${lastErr?.message || lastErr}`;

  vscode.window.showErrorMessage(msg);
  // Return empty tiers so UI still opens without fake content
  return {
    isFirstOccurrence: false,
    hint: undefined,
    reasoning: undefined,
    answer: undefined,
    context: undefined,
  };
}
