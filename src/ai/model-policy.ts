import { getConfig } from '../config.js';
import type { ModelTier } from '../config.js';

export function getModelForTier(tier: ModelTier): string {
  return getConfig().modelTiers[tier];
}

export function getModelPolicy(): Record<ModelTier, string> {
  return getConfig().modelTiers;
}
