// SkillRegistry — loads the bundled skill JSONs and scores keyword triggers.
// Same scoring as Android SkillRegistry: multi-word trigger contained: +3,
// single-word trigger contained: +2, any word of a trigger present: +1.
// A match needs score >= 3 AND a strict win over the runner-up; otherwise
// "no clear match" and the caller falls back to the LLM classifier (TaskRouter).
import { parseSkill, type Skill } from './Skill';
import shopeeSkillJson from '../skills/shopee_price_search.json';
import tokopediaSkillJson from '../skills/tokopedia_price_search.json';
import whatsappSkillJson from '../skills/whatsapp_read.json';

export interface SkillMatch {
  skill: Skill;
  score: number;
}

export class SkillRegistry {
  private skills: Skill[];

  constructor() {
    this.skills = [shopeeSkillJson, tokopediaSkillJson, whatsappSkillJson]
      .map((j) => parseSkill(j))
      .filter((s): s is Skill => s !== null);
  }

  all(): Skill[] {
    return this.skills;
  }

  byId(id: string): Skill | undefined {
    return this.skills.find((s) => s.id === id);
  }

  match(userText: string): SkillMatch | null {
    const t = userText.toLowerCase();
    let best: Skill | null = null;
    let bestScore = 0;
    let secondScore = 0;
    for (const skill of this.skills) {
      let score = 0;
      for (const rawTrigger of skill.triggers) {
        const trigger = rawTrigger.toLowerCase().trim();
        if (!trigger) continue;
        if (t.includes(trigger)) {
          score += trigger.includes(' ') ? 3 : 2;
        } else {
          const words = trigger.split(/\s+/).filter((w) => w.length > 2);
          if (words.length > 0 && words.some((w) => t.includes(w))) score += 1;
        }
      }
      if (score > bestScore) {
        secondScore = bestScore;
        bestScore = score;
        best = skill;
      } else if (score > secondScore) {
        secondScore = score;
      }
    }
    return best !== null && bestScore >= 3 && bestScore > secondScore ? { skill: best, score: bestScore } : null;
  }
}
