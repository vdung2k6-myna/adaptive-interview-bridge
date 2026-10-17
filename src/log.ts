import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The wire log.
 *
 * Every line carries the seconds elapsed since start, stamped the way the rig
 * that preceded this service stamped its own. That was not cosmetic: the rig's
 * captures were read back days later and a turn's problem was almost always a
 * gap between two stamps rather than an exception, so a bridge log and a rig log
 * should be readable side by side without translation.
 *
 * A line written on behalf of a session carries the gadget that session belongs
 * to as well, inside the same bracket, so that a log holding two gadgets at once
 * reads as two columns rather than as one interleaved stream:
 *
 *   [  14.02 b81f3f4a9b01]   turn from speech: 1.20s of the person's own voice
 *   [  14.02 3c0f02d07efc] == device disconnected ==
 *
 * The **gadget** and not the session id, because the question such a log has to
 * answer is which gadget a line is about, and a gadget that reconnects keeps its
 * identity while its session id does not. The name is the one the allowlist
 * carries, so a line and the entry it belongs to read as the same string.
 *
 * Nothing is passed down to produce it. `runWithDevice` establishes the scope and
 * the gadget is read at the line, which is why this module is the one place where
 * something ambient is allowed to be: `t0` and the stamp below are already the
 * same kind of thing, and every line already carries a timestamp that no call
 * site hands over. What the scope buys is that the six modules in a turn's path
 * neither take a logger nor know this exists.
 *
 * A line written with no scope set carries no gadget — which is the whole of how
 * "this line is about no gadget" is said, and what leaves the service's own lines
 * (its start, the endpoint a gadget is provisioned at) and every test that reads
 * log output exactly as they were.
 */
const t0 = Date.now();
const stamp = (): string => ((Date.now() - t0) / 1000).toFixed(2).padStart(7);

/**
 * The gadget a line belongs to, for the length of the work that writes it. Set by
 * the socket, which is the one place a session begins — and set nowhere else.
 */
const device = new AsyncLocalStorage<string>();

/**
 * Run `fn` on behalf of one gadget, so that every line written inside it — and
 * inside anything it starts — names that gadget.
 *
 * What `AsyncLocalStorage` follows is the async resources created within `fn`, so
 * a timer armed here carries the scope to its own callback. What it does **not**
 * follow is an `EventEmitter` listener registered here and called later, which is
 * a measurement rather than a reading of the docs: hence the socket re-establishing
 * the scope at each of its own listeners instead of once around the connection.
 */
export function runWithDevice<T>(deviceId: string, fn: () => T): T {
  return device.run(deviceId, fn);
}

/** The bracket a line opens with: the stamp, and the gadget where there is one to name. */
const lead = (): string => {
  const scope = device.getStore();
  return scope === undefined ? `[${stamp()}]` : `[${stamp()} ${scope}]`;
};

/** An event worth a line: a connection, a turn, a decision. */
export const log = (...a: unknown[]): void => console.log(lead(), ...a);
/** Detail under an event: headers, the payload sent. */
export const info = (...a: unknown[]): void => console.log(`${lead()}  `, ...a);
/** Something that is not what it should be, but not fatal. */
export const warn = (...a: unknown[]): void => console.log(`${lead()}  !`, ...a);
/** A failure. */
export const err = (...a: unknown[]): void => console.log(`${lead()}  X`, ...a);
/** A heading, so a long log can be scanned rather than read. */
export const section = (s: string): void => console.log(`\n${lead()} == ${s} ==`);
