import os from "node:os";

/**
 * Which address to name in the OTA response.
 *
 * The device asks for OTA over the LAN and then connects to whatever address that
 * response named, so the address has to be one the device can route to: not
 * loopback, and not a virtual adapter. A Windows machine carries several of the
 * latter (Hyper-V, WSL, VMware, a VPN client), and picking one produces the worst
 * kind of failure — the device fetches OTA successfully, then never connects,
 * leaving nothing on the bridge's side to see. Choosing deliberately here is
 * cheaper than diagnosing that.
 */
const VIRTUAL_IFACE =
  /vEthernet|VMware|VirtualBox|Hyper-V|Loopback|WSL|Docker|Tailscale|ZeroTier|Bluetooth|Local Area Connection\*/i;

export interface CandidateAddress {
  name: string;
  address: string;
  virtual: boolean;
}

/** Every non-loopback IPv4 address this machine has, adapter name included. */
export function candidateAddresses(): CandidateAddress[] {
  const out: CandidateAddress[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== "IPv4" || i.internal) continue;
      out.push({ name, address: i.address, virtual: VIRTUAL_IFACE.test(name) });
    }
  }
  return out;
}

/** Lower is better: an ordinary home LAN first, a virtual adapter last. */
export function scoreAddress(address: string): number {
  if (/^192\.168\./.test(address)) return 0;
  if (/^10\./.test(address)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
}

/**
 * The address to use, unless configuration overrides it. Falls back to loopback
 * only when the machine has nothing else, in which case a device cannot reach the
 * bridge at all and the operator needs to know that rather than discover it.
 */
export function localIp(override?: string): string {
  if (override) return override;
  const all = candidateAddresses();
  const real = all.filter((c) => !c.virtual).sort((a, b) => scoreAddress(a.address) - scoreAddress(b.address));
  const pick = real[0] ?? all.sort((a, b) => scoreAddress(a.address) - scoreAddress(b.address))[0];
  return pick ? pick.address : "127.0.0.1";
}
