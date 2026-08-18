export interface RequestGate {
  next: () => number;
  isCurrent: (generation: number) => boolean;
}

/** Guards async responses so only the latest request may update view state. */
export function createRequestGate(): RequestGate {
  let current = 0;
  return {
    next: () => ++current,
    isCurrent: (generation) => generation === current,
  };
}
