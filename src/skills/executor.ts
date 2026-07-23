import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { TOOL_REGISTRY } from '../tools/index.js';

const skillDefSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().min(1),
  allowedTools: z.array(z.string()).min(1),
  triggers: z.array(z.string()).min(1),
  approvalRequired: z.boolean().default(true),
});

const skillsSchema = z.object({
  skills: z.record(z.string().min(1), skillDefSchema),
});

export interface ValidatedSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
  allowedTools: string[];
  triggers: string[];
  approvalRequired: boolean;
}

export function loadSkills(skillsPath: string): ValidatedSkill[] {
  const raw = readFileSync(skillsPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(`Failed to parse skills YAML: ${String(err)}`);
  }

  const result = skillsSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Skills validation failed:\n${issues}`);
  }

  const baseDir = resolve(skillsPath, '..', '..');
  const knownToolNames = new Set(TOOL_REGISTRY.map((t) => t.name));
  const skills: ValidatedSkill[] = [];

  for (const [id, def] of Object.entries(result.data.skills)) {
    const instructionsPath = resolve(baseDir, def.instructions);
    if (!existsSync(instructionsPath)) {
      throw new Error(
        `Skill instructions not found: ${instructionsPath}`,
      );
    }

    const instructions = readFileSync(instructionsPath, 'utf-8');
    if (instructions.trim().length === 0) {
      throw new Error(`Skill instructions empty: ${id}`);
    }

    for (const toolName of def.allowedTools) {
      if (!knownToolNames.has(toolName)) {
        throw new Error(
          `Unknown tool "${toolName}" in skill "${id}"`,
        );
      }
    }

    skills.push({
      id,
      name: def.name,
      description: def.description,
      instructions,
      allowedTools: def.allowedTools,
      triggers: def.triggers,
      approvalRequired: def.approvalRequired,
    });
  }

  return skills;
}

let _skills: ValidatedSkill[] | null = null;

export function loadSkillsRegistry(path: string): ValidatedSkill[] {
  if (_skills) return _skills;
  _skills = loadSkills(path);
  return _skills;
}

export function getAllSkills(): ValidatedSkill[] {
  return _skills ?? [];
}

export function matchSkill(input: string): ValidatedSkill | null {
  const normalized = input.toLowerCase();
  for (const skill of getAllSkills()) {
    for (const trigger of skill.triggers) {
      if (normalized.includes(trigger.toLowerCase())) {
        return skill;
      }
    }
  }
  return null;
}

export function resetSkills(): void {
  _skills = null;
}
