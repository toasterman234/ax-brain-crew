import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getConfig } from '../config.js';

export const KNOWN_VAULT_FOLDERS = ['Inbox', 'Projects', 'Areas', 'Knowledge', 'Meta'] as const;

export function isVaultInitialized(vaultPath: string): boolean {
  const agentsMd = resolve(vaultPath, 'AGENTS.md');
  if (!existsSync(agentsMd)) return false;

  const contents = readdirSync(vaultPath, { withFileTypes: true });
  return contents.some(
    (d) => d.isDirectory() && (KNOWN_VAULT_FOLDERS as readonly string[]).includes(d.name),
  );
}

export interface OnboardingState {
  phase: string;
  answers: Record<string, string>;
  askedQuestions: string[];
  startedAt: string;
  updatedAt: string;
}

export interface OnboardingQuestion {
  nextPhase: string;
  question: string;
  field: string;
  hint?: string;
  done: boolean;
}

export function getOnboardingStatePath(): string {
  const config = getConfig();
  return resolve(config.obsidianVaultPath, 'Meta', 'states', 'onboarding.json');
}

export function loadOnboardingState(): OnboardingState | null {
  const path = getOnboardingStatePath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as OnboardingState;
  } catch {
    return null;
  }
}

export function saveOnboardingState(state: OnboardingState): void {
  const path = getOnboardingStatePath();
  state.updatedAt = new Date().toISOString();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
}

export function createFreshState(): OnboardingState {
  const now = new Date().toISOString();
  return {
    phase: 'welcome',
    answers: {},
    askedQuestions: [],
    startedAt: now,
    updatedAt: now,
  };
}

export function applyAnswer(
  state: OnboardingState,
  field: string,
  answer: string,
  nextPhase: string,
): OnboardingState {
  return {
    ...state,
    phase: nextPhase,
    answers: { ...state.answers, [field]: answer },
    askedQuestions: [...state.askedQuestions, field],
    updatedAt: new Date().toISOString(),
  };
}

export function clearOnboardingState(): void {
  const path = getOnboardingStatePath();
  if (existsSync(path)) {
    writeFileSync(path, JSON.stringify(createFreshState(), null, 2), 'utf-8');
  }
}
