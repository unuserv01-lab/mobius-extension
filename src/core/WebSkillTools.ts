// WebSkillTools — Layer 1 web tools for the SkillRunner (service-worker side).
// The runner runs in the service worker and cannot touch the DOM: every DOM
// action is forwarded to the active tab's content script (src/content/index.ts,
// MOBIUS_TOOL_* messages). Navigation runs here via chrome.tabs.
// All tools are READ-ONLY by construction: navigate, read, extract, scroll.
// Nothing here types into a checkout, clicks "buy", or sends anything.
import { failResult, okResult, type SkillToolAdapter, type ToolResult } from './SkillRunner';

type ContentResult = { ok: boolean; text?: string; matches?: string[]; found?: boolean; error?: string };

export class WebSkillTools implements SkillToolAdapter {
  private tabId: number | null = null;

  async call(tool: string, args: Record<string, string>): Promise<ToolResult> {
    switch (tool) {
      case 'navigate':
        return this.navigate(args.url ?? '');
      case 'clickText':
        return this.toTab('MOBIUS_TOOL_CLICK_TEXT', { text: args.text ?? '', exact: args.exact === 'true' });
      case 'typeText':
        return this.toTab('MOBIUS_TOOL_TYPE_TEXT', { text: args.text ?? '' });
      case 'submit':
        return this.toTab('MOBIUS_TOOL_SUBMIT', {});
      case 'readScreen':
        return this.readScreen(args.limit ? Number(args.limit) : 200);
      case 'findText':
        return this.toTab('MOBIUS_TOOL_FIND_TEXT', { text: args.text ?? '', exact: args.exact === 'true' });
      case 'extract':
        return this.extract(args.pattern ?? '', args.max ? Number(args.max) : 5);
      case 'scroll':
        return this.toTab('MOBIUS_TOOL_SCROLL', {});
      case 'back':
        return this.toTab('MOBIUS_TOOL_BACK', {});
      case 'home':
        return this.toTab('MOBIUS_TOOL_HOME', {});
      case 'wait':
        await new Promise((r) => setTimeout(r, args.ms ? Number(args.ms) : 1000));
        return okResult(`Waited ${args.ms ?? '1000'}ms.`);
      case 'waitForText':
        return this.toTab('MOBIUS_TOOL_WAIT_FOR_TEXT', { text: args.text ?? '', timeoutMs: String(args.timeoutMs ? Number(args.timeoutMs) : 5000) });
      default:
        return failResult(`Unknown tool: ${tool}`);
    }
  }

  private async navigate(rawUrl: string): Promise<ToolResult> {
    if (!rawUrl) return failResult('navigate needs a url.');
    const url = encodeURI(rawUrl);
    try {
      const tab = await this.activeTab();
      if (tab?.id !== undefined) {
        this.tabId = tab.id;
        await chrome.tabs.update(tab.id, { url });
        await this.waitForLoad(tab.id, 20_000);
        return okResult(`Opened ${url}`);
      }
      const created = await chrome.tabs.create({ url });
      if (created.id !== undefined) {
        this.tabId = created.id;
        await this.waitForLoad(created.id, 20_000);
        return okResult(`Opened ${url} in a new tab`);
      }
      return failResult('Could not open a tab.');
    } catch (e) {
      return failResult(e instanceof Error ? e.message : String(e));
    }
  }

  private async readScreen(limit: number): Promise<ToolResult> {
    const res = await this.toTab('MOBIUS_TOOL_READ_PAGE', {});
    if (!res.success || !res.data?.text) return res;
    const text = res.data.text;
    const capped = text.slice(0, Math.max(1000, limit * 100));
    return okResult(capped.slice(0, 400) + (capped.length > 400 ? '…' : ''), { text: capped });
  }

  private async extract(pattern: string, max: number): Promise<ToolResult> {
    if (!pattern) return failResult('extract needs a pattern.');
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'g');
    } catch {
      return failResult(`Invalid pattern: ${pattern}`);
    }
    const res = await this.toTab('MOBIUS_TOOL_EXTRACT', { pattern, max: String(max) });
    if (!res.success) return res;
    const matches = res.data?.matches ? res.data.matches.split('\n').filter(Boolean) : [];
    void re;
    if (matches.length === 0) return failResult('No matches found on this page.');
    const shown = matches.slice(0, max);
    return okResult(`Found ${matches.length} price(s): ${shown.join(', ')}`, { matches: shown.join('\n'), count: String(matches.length) });
  }

  private async toTab(type: string, payload: Record<string, string | boolean>): Promise<ToolResult> {
    try {
      const tab = await this.activeTab();
      if (tab?.id === undefined) return failResult('No active tab — open a page first.');
      this.tabId = tab.id;
      const res = (await chrome.tabs.sendMessage(tab.id, { type, ...payload })) as ContentResult | undefined;
      if (!res) return failResult('Content script did not answer (reload the page and try again).');
      if (!res.ok) return failResult(res.error ?? 'Tool failed on the page.');
      if (res.text !== undefined) return okResult(res.text.slice(0, 400), { text: res.text });
      if (res.matches !== undefined) return okResult(res.matches.join(', '), { matches: res.matches.join('\n') });
      if (res.found !== undefined) return res.found ? okResult(`Found "${(payload as { text?: string }).text ?? ''}" on the page.`) : failResult(`"${(payload as { text?: string }).text ?? ''}" not found on the page.`);
      return okResult('Done.');
    } catch (e) {
      return failResult(e instanceof Error ? e.message : String(e));
    }
  }

  private async activeTab(): Promise<chrome.tabs.Tab | undefined> {
    if (this.tabId !== null) {
      try {
        const tab = await chrome.tabs.get(this.tabId);
        if (tab) return tab;
      } catch {
        this.tabId = null;
      }
    }
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  private waitForLoad(tabId: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      const listener = (id: number, info: { status?: string }): void => {
        if (id === tabId && info.status === 'complete') {
          clearTimeout(timer);
          done();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  }
}
