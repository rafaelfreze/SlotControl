/** Read-only mirror of the reconciler's LOT_SIZE quantization. A whole
 * executable step uncovered is not dust and never certifies a paused TP. */
export function pausedPositionCovered(quantity: number, remainingTp: number, quantityStep: number) {
  return [quantity, remainingTp, quantityStep].every(Number.isFinite)
    && quantity > 0 && remainingTp > 0 && quantityStep > 0
    && remainingTp <= quantity + 1e-10
    && Math.floor((Math.max(0, quantity - remainingTp) + 1e-10) / quantityStep) === 0;
}
