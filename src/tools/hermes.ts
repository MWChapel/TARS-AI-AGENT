import { config } from '../config';

// ACP (Agent Communication Protocol) client for the Hermes agent.
// Implements the BeeAI ACP REST spec: POST /runs, then poll GET /runs/{id}
// if the first response is still "running" or "created".

interface AcpContentBlock {
  type: string;
  text?: string;
}

interface AcpMessage {
  role: string;
  content: AcpContentBlock[];
}

interface AcpRunResponse {
  run_id: string;
  status: 'created' | 'running' | 'completed' | 'failed' | string;
  output?: AcpMessage[];
  error?: string;
}

function extractText(output: AcpMessage[] | undefined): string {
  if (!output?.length) return '';
  return output
    .flatMap(m => m.content)
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('\n')
    .trim();
}

async function pollRun(runId: string, headers: Record<string, string>): Promise<string> {
  const base = config.hermes.acpUrl.replace(/\/$/, '');
  const maxWait = config.hermes.timeoutMs;
  const interval = 1000;
  const deadline = Date.now() + maxWait;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval));

    const res = await fetch(`${base}/runs/${runId}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ACP poll HTTP ${res.status}`);

    const run = await res.json() as AcpRunResponse;
    if (run.status === 'completed') return extractText(run.output);
    if (run.status === 'failed') throw new Error(`Hermes run failed: ${run.error ?? 'unknown'}`);
  }

  throw new Error(`Hermes agent timed out after ${maxWait / 1000}s`);
}

export async function callHermes(message: string): Promise<string> {
  const { acpUrl, acpToken, agentName, timeoutMs } = config.hermes;
  const base = acpUrl.replace(/\/$/, '');

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (acpToken) headers['Authorization'] = `Bearer ${acpToken}`;

  const body = {
    agent_name: agentName,
    input: [
      { role: 'user', content: [{ type: 'text', text: message }] },
    ],
  };

  const res = await fetch(`${base}/runs`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ACP HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const run = await res.json() as AcpRunResponse;

  if (run.status === 'completed') return extractText(run.output);
  if (run.status === 'failed') throw new Error(`Hermes run failed: ${run.error ?? 'unknown'}`);

  // Still running — poll until done
  return pollRun(run.run_id, headers);
}
