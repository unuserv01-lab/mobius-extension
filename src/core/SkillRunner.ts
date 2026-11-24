// SkillRunner — deterministic Layer 2 interpreter, ported from Android SkillRunner.kt.
// No LLM calls, no branching beyond the skill's own `when` conditions.
// Resolves $params/$vars (missing ref fails the step loudly), honors onFail
// (fail | skip | stop) and maxRetries, enforces maxSteps + wall-clock timeoutMs.
// GATE NOTE: the extension has no ActionGate / approval UI in the service
// worker. All web skill tools are read-only by construction (navigate, read,
// extract — nothing writes, nothing sends). A step marked risk="irreversible"
// therefore FAILS CLOSED instead of running blind.
import type { Skill, SkillOutcome, StepResult } from './Skill';

export interface ToolResult {
  success: boolean;
  message: string;
  data?: Record<string, string>;
}

export function okResult(message: string, data?: Record<string, string>): ToolResult {
  return { success: true, message, data };
}

export function failResult(message: string): ToolResult {
  return { success: false, message };
}

/** One Layer 1 tool call. Implemented by WebSkillTools (service-worker side). */
export interface SkillToolAdapter {
  call(tool: string, args: Record<string, string>): Promise<ToolResult>;
}

const REF = /\$([A-Za-z0-9_.]+)/g;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SkillRunner {
  async run(
    skill: Skill,
    params: Record<string, string>,
    tool: SkillToolAdapter,
    onStatus: (msg: string) => void = () => undefined,
  ): Promise<SkillOutcome> {
    if (skill.steps.length > skill.maxSteps) {
      return {
        success: false,
        partial: false,
        message: `Skill '${skill.id}' has ${skill.steps.length} steps but maxSteps is ${skill.maxSteps}.`,
        steps: [],
        vars: { ...params },
      };
    }

    const vars: Record<string, string> = {};
    for (const p of skill.params) {
      if (params[p.name] !== undefined) vars[p.name] = params[p.name];
      else if (p.default) vars[p.name] = p.default;
    }

    const deadline = Date.now() + skill.timeoutMs;
    const results: StepResult[] = [];
    let last: ToolResult | null = null;
    let failed = false;
    let partial = false;
    let failMessage = '';

    for (let index = 0; index < skill.steps.length; index++) {
      const step = skill.steps[index];
      if (Date.now() > deadline) {
        failed = true;
        failMessage = `Skill timed out after ${skill.timeoutMs}ms at step ${index + 1}.`;
        results.push({ index, tool: step.tool, success: false, message: failMessage, durationMs: 0 });
        break;
      }
      if (step.when && !evalWhen(step.when, vars, last)) {
        results.push({ index, tool: step.tool, success: true, message: 'skipped (when false)', durationMs: 0 });
        continue;
      }

      onStatus(`Step ${index + 1}/${skill.steps.length}: ${step.tool}...`);

      // Resolve $params/$vars ONCE. A missing reference fails the step, loudly.
      let resolved: Record<string, string> | null = null;
      let resolveError: string | null = null;
      try {
        const r: Record<string, string> = {};
        for (const [k, v] of Object.entries(step.args)) r[k] = resolveRefs(v, vars);
        resolved = r;
      } catch (e) {
        resolveError = e instanceof Error ? e.message : String(e);
      }

      const started = Date.now();
      let result: ToolResult;
      if (resolved === null) {
        result = failResult(resolveError ?? 'missing parameter');
      } else if (step.risk === 'irreversible') {
        // Fail closed: no approval UI exists in the service worker.
        result = failResult('Step is marked irreversible, but the extension has no approval UI — refused.');
      } else {
        let attempt = 0;
        for (;;) {
          try {
            result = await tool.call(step.tool, resolved);
          } catch (e) {
            result = failResult(e instanceof Error ? e.message : String(e));
          }
          if (result.success || attempt >= step.maxRetries) break;
          attempt++;
          await sleep(300);
        }
      }
      const duration = Date.now() - started;
      results.push({ index, tool: step.tool, success: result.success, message: result.message, durationMs: duration });

      if (result.success) {
        last = result;
        if (step.storeAs) {
          vars[step.storeAs] = result.message;
          for (const [k, v] of Object.entries(result.data ?? {})) vars[`${step.storeAs}.${k}`] = v;
        }
      } else {
        last = result;
        if (step.onFail === 'skip') {
          partial = true;
        } else if (step.onFail === 'stop') {
          partial = true;
          failMessage = `Stopped at step ${index + 1} (${step.tool}): ${result.message}`;
          break;
        } else {
          failed = true;
          failMessage = `Step ${index + 1} (${step.tool}) failed: ${result.message}`;
          break;
        }
      }
    }

    const lastOk = [...results].reverse().find((r) => r.success);
    const message = failed
      ? failMessage
      : partial
        ? failMessage
          ? `Partially done — ${failMessage}`
          : `Partially done (some steps skipped): ${lastOk?.message ?? skill.name}.`
        : lastOk?.message && lastOk.message.trim()
          ? lastOk.message
          : `Done: ${skill.name}.`;
    return { success: !failed, partial, message, steps: results, vars };
  }
}

/** Replaces $name with vars[name]; a missing reference throws. */
function resolveRefs(value: string, vars: Record<string, string>): string {
  let missing: string | null = null;
  const out = value.replace(REF, (_m, name: string) => {
    if (vars[name] !== undefined) return vars[name];
    missing = name;
    return _m;
  });
  if (missing !== null) throw new Error(`missing parameter/var '$${missing}'`);
  return out;
}

/** "a && b": every clause must hold. */
function evalWhen(expr: string, vars: Record<string, string>, last: ToolResult | null): boolean {
  return expr
    .split('&&')
    .map((p) => p.trim())
    .every((part) => evalAtom(part, vars, last));
}

function evalAtom(atom: string, vars: Record<string, string>, last: ToolResult | null): boolean {
  const negated = atom.startsWith('!');
  const core = negated ? atom.slice(1).trim() : atom;
  let value = false;
  if (core === 'last.success') value = last?.success === true;
  else if (core === 'last.failed') value = last?.success === false;
  else if (core.startsWith('vars.')) {
    const rest = core.slice('vars.'.length);
    if (rest.includes(' contains ')) {
      const [k, v] = rest.split(' contains ');
      value = (vars[k.trim()] ?? '').includes(unquote(v.trim()));
    } else if (rest.includes('==')) {
      const [k, v] = rest.split('==');
      value = vars[k.trim()] === unquote(v.trim());
    } else if (rest.includes('!=')) {
      const [k, v] = rest.split('!=');
      value = vars[k.trim()] !== unquote(v.trim());
    } else {
      const v = vars[rest];
      value = v !== undefined && v.trim() !== '';
    }
  }
  return negated ? !value : value;
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}
