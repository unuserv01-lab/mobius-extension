// Skill — LAYER 2 (declarative JSON recipes), ported from Android core/Skill.kt.
// A skill is DATA, not code: a JSON file composing Layer 1 tools into one task.
// Same schema as Android (id, name, description, triggers, params, steps,
// maxSteps, timeoutMs, summarize). Web skills use the web tool names
// (navigate, clickText, typeText, submit, readScreen, findText, extract,
// scroll, back, home, wait, waitForText) — see SkillRunner.callTool.
//
// `when` conditions: "last.success" | "last.failed" | "!last.success" |
// "vars.<name>" | "vars.<name> == \"v\"" | "!=" | "contains" — clauses joined with "&&".
// `risk: "irreversible"` — the extension has no approval UI in the service
// worker, so an irreversible step FAILS CLOSED (see SkillRunner).

export interface SkillParam {
  name: string;
  required?: boolean;
  default?: string | null;
}

export interface SkillStep {
  tool: string;
  args: Record<string, string>;
  storeAs?: string | null;
  when?: string | null;
  /** "fail" (default) | "skip" | "stop" */
  onFail: string;
  maxRetries: number;
  /** Only the exact value "irreversible" counts; anything else is ignored. */
  risk?: string | null;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  triggers: string[];
  params: SkillParam[];
  steps: SkillStep[];
  maxSteps: number;
  timeoutMs: number;
  summarize: boolean;
}

export interface StepResult {
  index: number;
  tool: string;
  success: boolean;
  message: string;
  durationMs: number;
}

export interface SkillOutcome {
  success: boolean;
  partial: boolean;
  message: string;
  steps: StepResult[];
  vars: Record<string, string>;
}

/** Parse one skill JSON object. Returns null when malformed (id/steps missing). */
export function parseSkill(json: unknown): Skill | null {
  try {
    if (typeof json !== 'object' || json === null) return null;
    const obj = json as Record<string, unknown>;
    const id = typeof obj.id === 'string' ? obj.id.trim() : '';
    if (!id) return null;
    const stepsJson = obj.steps;
    if (!Array.isArray(stepsJson)) return null;
    const steps: SkillStep[] = [];
    for (const s of stepsJson) {
      if (typeof s !== 'object' || s === null) continue;
      const so = s as Record<string, unknown>;
      const tool = typeof so.tool === 'string' ? so.tool.trim() : '';
      if (!tool) continue;
      const args: Record<string, string> = {};
      if (typeof so.args === 'object' && so.args !== null) {
        for (const [k, v] of Object.entries(so.args as Record<string, unknown>)) args[k] = String(v ?? '');
      }
      const onFailRaw = typeof so.onFail === 'string' ? so.onFail.toLowerCase() : 'fail';
      steps.push({
        tool,
        args,
        storeAs: typeof so.storeAs === 'string' && so.storeAs.trim() ? so.storeAs : null,
        when: typeof so.when === 'string' && so.when.trim() ? so.when : null,
        onFail: ['fail', 'skip', 'stop'].includes(onFailRaw) ? onFailRaw : 'fail',
        maxRetries: typeof so.maxRetries === 'number' ? Math.min(3, Math.max(0, Math.floor(so.maxRetries))) : 0,
        risk: so.risk === 'irreversible' ? 'irreversible' : null,
      });
    }
    if (steps.length === 0) return null;
    const params: SkillParam[] = [];
    if (Array.isArray(obj.params)) {
      for (const p of obj.params) {
        if (typeof p !== 'object' || p === null) continue;
        const po = p as Record<string, unknown>;
        const name = typeof po.name === 'string' ? po.name.trim() : '';
        if (!name) continue;
        params.push({
          name,
          required: po.required === true,
          default: typeof po.default === 'string' && po.default.trim() ? po.default : null,
        });
      }
    }
    const triggers: string[] = [];
    if (Array.isArray(obj.triggers)) {
      for (const t of obj.triggers) {
        if (typeof t === 'string' && t.trim()) triggers.push(t.trim());
      }
    }
    return {
      id,
      name: typeof obj.name === 'string' && obj.name ? obj.name : id,
      description: typeof obj.description === 'string' ? obj.description : '',
      triggers,
      params,
      steps,
      maxSteps: typeof obj.maxSteps === 'number' ? Math.min(100, Math.max(1, Math.floor(obj.maxSteps))) : 20,
      timeoutMs: typeof obj.timeoutMs === 'number' ? Math.min(300_000, Math.max(1_000, Math.floor(obj.timeoutMs))) : 60_000,
      summarize: obj.summarize === true,
    };
  } catch {
    return null;
  }
}
