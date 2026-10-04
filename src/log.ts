/**
 * The wire log.
 *
 * Every line carries the seconds elapsed since start, stamped the way the rig
 * that preceded this service stamped its own. That was not cosmetic: the rig's
 * captures were read back days later and a turn's problem was almost always a
 * gap between two stamps rather than an exception, so a bridge log and a rig log
 * should be readable side by side without translation.
 */
const t0 = Date.now();
const stamp = (): string => ((Date.now() - t0) / 1000).toFixed(2).padStart(7);

/** An event worth a line: a connection, a turn, a decision. */
export const log = (...a: unknown[]): void => console.log(`[${stamp()}]`, ...a);
/** Detail under an event: headers, the payload sent. */
export const info = (...a: unknown[]): void => console.log(`[${stamp()}]  `, ...a);
/** Something that is not what it should be, but not fatal. */
export const warn = (...a: unknown[]): void => console.log(`[${stamp()}]  !`, ...a);
/** A failure. */
export const err = (...a: unknown[]): void => console.log(`[${stamp()}]  X`, ...a);
/** A heading, so a long log can be scanned rather than read. */
export const section = (s: string): void => console.log(`\n[${stamp()}] == ${s} ==`);
