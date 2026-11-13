// Why connecting failed, in a few kinds the connection help can explain. Pure.

export type ConnProblem = "no-serial" | "no-port" | "busy" | "no-answer" | "bridge" | "other";

/** The kind of a connect error, from its name (Web Serial DOMException names are kept by explainOpenError). */
export function classifyConnError(e: unknown, kind: "usb" | "bridge" | "sim"): ConnProblem {
  if (kind === "bridge") return "bridge";
  const name = e instanceof Error ? e.name : "";
  if (name === "NotSupportedError") return "no-serial";
  if (name === "NotFoundError") return "no-port";
  if (name === "InvalidStateError" || name === "NetworkError") return "busy";
  if (name === "TimeoutError") return "no-answer";
  return "other";
}
