import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { getConfig } from '../config.js';
import { createModelClient } from '../ai/clients.js';
import type {
  OnboardingState,
  OnboardingQuestion,
} from './state.js';

function loadSkillInstructions(): string {
  const config = getConfig();
  const path = resolve(config.obsidianVaultPath, '..', 'crew', 'skills', 'onboarding.md');
  return readFileSync(path, 'utf-8');
}

function buildPrompt(instructions: string, state: OnboardingState): string {
  return `${instructions}

## Current State

\`\`\`json
${JSON.stringify(state, null, 2)}
\`\`\`

## Your Task

Based on the current state above, determine the NEXT question to ask the user. Follow the onboarding flow phases in the instructions exactly.

Return ONLY a valid JSON object with these fields:
- nextPhase: string identifier for the next phase
- question: the question to ask the user (warm, conversational tone)
- field: short key for the answer (e.g., "name", "language", "life-areas")
- hint: optional hint or example (can be empty string)
- done: false (set to true ONLY when all phases complete and vault should be created)

If the state shows ALL required questions have been asked (phases 0-4 complete), set "done": true and "nextPhase": "create-vault". Present a summary of the vault you will create and ask for confirmation.`;
}

function parseQuestionResponse(text: string): OnboardingQuestion | null {
  try {
    const cleaned = text.replace(/```json\s*|\s*```/g, '').trim();
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;

    if (typeof parsed.question !== 'string' || typeof parsed.field !== 'string') {
      return null;
    }

    return {
      nextPhase: String(parsed.nextPhase ?? 'unknown'),
      question: String(parsed.question),
      field: String(parsed.field),
      hint: typeof parsed.hint === 'string' ? parsed.hint : undefined,
      done: typeof parsed.done === 'boolean' ? parsed.done : false,
    };
  } catch {
    return null;
  }
}

export async function askNextQuestion(state: OnboardingState): Promise<OnboardingQuestion> {
  const instructions = loadSkillInstructions();
  const prompt = buildPrompt(instructions, state);
  const llm = createModelClient('smart');

  const result = await llm.chat(
    { chatPrompt: [{ role: 'user', content: prompt }] },
    { stream: false },
  );

  const responseText =
    (result as any).results?.[0]?.content ??
    (result as any).results?.[0]?.text ??
    (result as any).message?.content ??
    (typeof result === 'string' ? result : JSON.stringify(result));

  const question = parseQuestionResponse(responseText);
  if (!question) {
    return {
      nextPhase: state.phase,
      question: 'Let me rephrase — can you tell me more about what you\'re looking for?',
      field: 'fallback',
      hint: '',
      done: false,
    };
  }

  return question;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeNote(vaultRoot: string, notePath: string, content: string): void {
  const fullPath = resolve(vaultRoot, notePath);
  ensureDir(dirname(fullPath));
  if (!existsSync(fullPath)) {
    writeFileSync(fullPath, content, 'utf-8');
  }
}

export function createVaultFromAnswers(answers: Record<string, string>): string[] {
  const config = getConfig();
  const vaultRoot = resolve(config.obsidianVaultPath);
  const created: string[] = [];
  const today = new Date().toISOString().split('T')[0]!;

  const areas = (answers['life-areas'] ?? '')
    .split(/[,;\n]/)
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);

  const userProfile = [
    '---',
    `name: "${answers.name ?? 'User'}"`,
    `primary-language: "${answers.language ?? 'en'}"`,
    `secondary-languages: ${JSON.stringify((answers['secondary-languages'] ?? '').split(/[,;\n]/).map((l) => l.trim()).filter(Boolean))}`,
    `role: "${answers.role ?? ''}"`,
    `motivation: "${answers.motivation ?? ''}"`,
    `obsidian-experience: "${answers['obsidian-experience'] ?? 'new'}"`,
    `life-areas: ${JSON.stringify(areas)}`,
    `terms-accepted: ${answers['terms-accepted'] ?? 'false'}`,
    `onboarding-date: "${today}"`,
    'ai-first: true',
    '---',
    '',
    '# User Profile',
    '',
    'Generated during onboarding on ' + today + '.',
    '',
    '## Personal',
    `- **Name**: ${answers.name ?? 'User'}`,
    `- **Role**: ${answers.role ?? ''}`,
    `- **Primary Language**: ${answers.language ?? 'en'}`,
    `- **Secondary Languages**: ${answers['secondary-languages'] ?? ''}`,
    `- **Motivation**: ${answers.motivation ?? ''}`,
    '',
    '## Vault Configuration',
    `- **Experience Level**: ${answers['obsidian-experience'] ?? 'new'}`,
    `- **Active Agents**: ${answers['agent-selection'] ?? 'all'}`,
    `- **Life Areas**: ${areas.join(', ')}`,
  ].join('\n');

  writeNote(vaultRoot, 'Meta/user-profile.md', userProfile);
  created.push('Meta/user-profile.md');

  for (const area of areas) {
    const areaName = area.charAt(0).toUpperCase() + area.slice(1);
    const areaFolder = `Areas/${areaName}`;
    const mocFile = `MOC/${areaName}.md`;

    const areaIndex = [
      '---',
      `date: ${today}`,
      'type: area',
      'tags:',
      `  - area/${area}`,
      'ai-first: true',
      '---',
      '',
      `# ${areaName}`,
      '',
      '## Purpose',
      '',
      '## Active Projects',
      '',
      '## Key Resources',
      '',
      '## MOC',
      `→ [[${mocFile.replace('.md', '')}]]`,
    ].join('\n');

    writeNote(vaultRoot, `${areaFolder}/_index.md`, areaIndex);
    created.push(`${areaFolder}/_index.md`);

    const moc = [
      '---',
      `date: ${today}`,
      'type: moc',
      'tags:',
      `  - moc/${area}`,
      'ai-first: true',
      '---',
      '',
      `# ${areaName} — Map of Content`,
      '',
      '## Overview',
      '',
      '## Key Notes',
      '',
      '## Active Projects',
      '',
      '## Related MOCs',
      '- [[MOC/Index|Master Index]]',
    ].join('\n');

    writeNote(vaultRoot, mocFile, moc);
    created.push(mocFile);

    const projectIndex = [
      '---',
      `date: ${today}`,
      'type: area',
      'tags:',
      `  - area/${area}`,
      'ai-first: true',
      '---',
      '',
      `# ${areaName} — Projects`,
      '',
      '## Active',
      '',
      '## Completed',
      '',
      '## Planned',
    ].join('\n');

    writeNote(vaultRoot, `${areaFolder}/Projects/_index.md`, projectIndex);
    created.push(`${areaFolder}/Projects/_index.md`);
  }

  const welcomeNote = [
    '---',
    `date: ${today}`,
    'type: note',
    'tags:',
    '  - system',
    '  - welcome',
    'ai-first: true',
    '---',
    '',
    '# Welcome to Your Vault',
    '',
    '## For future agents',
    '',
    `This vault was set up for ${answers.name ?? 'you'} on ${today}.`,
    `Active life areas: ${areas.join(', ') || 'none yet'}.`,
    'Start capturing: `npm run crew -- ask "Save this thought: [your thought]"`',
  ].join('\n');

  writeNote(vaultRoot, 'Inbox/Welcome to Your Vault.md', welcomeNote);
  created.push('Inbox/Welcome to Your Vault.md');

  return created;
}
