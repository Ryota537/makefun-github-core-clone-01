// Lifecycle of this entry, written for the harness the kit describes
// (see env/src/wire.ts in the kit for the authoritative contract):
//
//   The entry is a plain HTTP server built by app.ts. It does not pick its
//   own port: it asks the kernel for any free one, tells the trial env
//   which port that was, and then sits in a polling loop until the env
//   reports the trial finished. Only then does it shut down and exit 0.
//
//   The env's base URL comes from MAKEFUN_ENV_URL. With that variable
//   missing there is no env to talk to at all, so the process bails out
//   with exit code 1 instead of hanging around uselessly.
//
//   Three details the suite depends on, so they are load-bearing here:
//   - listen(0) — an ephemeral port. Port 8080 belongs to the env; the
//     entry must never try to claim it.
//   - POST /register {"port": N} — the env derives the entry's base URL
//     from the request's source address plus N, and dials it from then on.
//     A 409 just means some other entry registered first; it is not an
//     error for this process, which keeps waiting like everyone else.
//   - GET /done — answered immediately with {"done": false} while the
//     suite is still running, {"done": true} when it is over. This is a
//     poll: a failed or slow answer is never fatal, it only means "not
//     done yet, ask again".
//
// Nothing else is imported here: the server comes from ./app.ts, and no
// Node built-in, package, or model call is involved in this file.

import { createApp } from './app.ts';

// The env origin, with any trailing slashes stripped so URL building
// below can just append paths.
const envOrigin = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envOrigin === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

// One register or done request gets this long before it is abandoned;
// the caller then treats it as a failed attempt and tries again.
const REQUEST_BUDGET_MS = 30_000;
// Backoff between attempts starts here and doubles each failure...
const BACKOFF_START_MS = 250;
// ...until it reaches this ceiling, where it stays for the rest.
const BACKOFF_CEILING_MS = 2_000;
// ...doubling this many times reaches the ceiling exactly
// (250 -> 500 -> 1000 -> 2000).
const BACKOFF_DOUBLINGS = 3;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait after `failures` consecutive failed attempts: exponential
// growth from BACKOFF_START_MS, capped at BACKOFF_CEILING_MS.
function backoffMs(failures: number): number {
  const doublings = Math.min(failures, BACKOFF_DOUBLINGS);
  return Math.min(BACKOFF_CEILING_MS, BACKOFF_START_MS << doublings);
}

// Run `step` over and over until it reports success. A step returns
// true when its job is done, false when it should be retried after a
// backoff. A step that throws is making a judgement call — the failure
// is final, not retryable — so the error propagates to the caller.
async function repeatUntilSettled(step: () => Promise<boolean>): Promise<void> {
  let failures = 0;
  for (;;) {
    if (await step()) return;
    await pause(backoffMs(failures));
    failures += 1;
  }
}

// Announce the bound port to the env. 200 is the ordinary answer and
// 409 means another entry already won the first registration; both
// count as done. 400 and 405 are contract mistakes on our side, so
// they end the program instead of looping forever. Anything else —
// the env still starting up, a network hiccup, an unexpected status —
// is retried, because the env may simply not be ready yet.
async function announcePort(port: number): Promise<void> {
  await repeatUntilSettled(async () => {
    let response: Response;
    try {
      response = await fetch(`${envOrigin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
    } catch {
      return false;
    }
    if (response.status === 200 || response.status === 409) return true;
    if (response.status === 400 || response.status === 405) {
      throw new Error(`register rejected: HTTP ${response.status} ${await response.text()}`);
    }
    return false;
  });
}

// Keep asking GET /done until the env answers {"done": true}. Any
// failure to reach the env, any non-OK status, any body that is not
// done yet — all of these just mean "poll again".
async function awaitCompletion(): Promise<void> {
  await repeatUntilSettled(async () => {
    try {
      const response = await fetch(`${envOrigin}/done`, {
        signal: AbortSignal.timeout(REQUEST_BUDGET_MS),
      });
      if (!response.ok) return false;
      const payload = (await response.json()) as { done?: unknown };
      return payload.done === true;
    } catch {
      return false;
    }
  });
}

// The whole life of the process: bind, announce, wait, shut down.
async function boot(): Promise<void> {
  const server = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === 'string') {
        reject(new Error('the server did not bind an ephemeral TCP port'));
        return;
      }
      resolve(bound.port);
    });
  });
  process.stdout.write(`[entry] listening on port ${port}\n`);

  await announcePort(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await awaitCompletion();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await boot();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
