/**
 * Heuristic risk scorer — the Circuit Breaker's brain.
 * §S5: No LLM calls ever. Pure arithmetic.
 *
 * v1: hand-tuned weighted sum + sigmoid approximating MSR 2026 results.
 * v2: swappable for GBMScorer trained on AIDev.
 */

export interface RiskSignals {
  patchSize: number;
  filesTouched: number;
  configEdits: number;
  highRiskFiles: string[];
  estimatedConcerns: number;
}

export interface RiskScorer {
  score(signals: RiskSignals): number;
}

/**
 * Sigmoid function: maps any real number to (0, 1).
 */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export class HeuristicScorer implements RiskScorer {
  /**
   * Predict review effort from static signals.
   * Returns a score in [0, 1].
   */
  score(signals: RiskSignals): number {
    // Short-circuit: zero-diff is always 0
    if (
      signals.patchSize === 0 &&
      signals.filesTouched === 0 &&
      signals.configEdits === 0 &&
      signals.highRiskFiles.length === 0 &&
      signals.estimatedConcerns === 0
    ) {
      return 0;
    }

    // Weighted linear combination (hand-tuned to approximate MSR 2026 AUC 0.957)
    // Normalize each feature to a roughly [0, 1-ish] range
    const patchNorm = Math.min(signals.patchSize / 200, 5);     // 200 LoC → 1.0
    const fileNorm = Math.min(signals.filesTouched / 3, 5);      // 3 files → 1.0
    const configNorm = Math.min(signals.configEdits / 3, 3);     // 3 config edits → 1.0
    const riskNorm = Math.min(signals.highRiskFiles.length, 3);  // 0–3
    const concernNorm = Math.min(signals.estimatedConcerns / 2, 5); // 2 concerns → 1.0

    // Weights — patchSize and filesTouched are strongest predictors
    const raw =
      0.30 * patchNorm +
      0.20 * fileNorm +
      0.10 * configNorm +
      0.30 * riskNorm +    // high-risk files are very strong signal
      0.10 * concernNorm;

    // Sigmoid centered at ~0.4 so that moderate multi-file diffs land around 0.5
    // and trivial single-file fixes stay well below 0.3
    let score = sigmoid((raw - 0.4) * 4);

    // Hard floor: high-risk files always push score to ≥ 0.5
    // (spec §3: "touching auth/security => shouldDecompose: true")
    if (signals.highRiskFiles.length > 0) {
      score = Math.max(score, 0.5);
    }

    return Math.round(score * 1000) / 1000; // 3 decimal places
  }
}
