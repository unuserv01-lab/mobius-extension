// Content script entry — runs on every page (document_idle).
//  1. Mounts the floating bubble if the user has it enabled (default ON).
//  2. Answers Core requests: read WhatsApp last message / read page text /
//     insert a reply draft into the WhatsApp message box.
import { STORAGE_KEYS } from '../config/constants';
import { ActionExecutor } from './ActionExecutor';
import { BubbleWidget } from './BubbleWidget';
import { DomReader } from './DomReader';

async function bubbleEnabled(): Promise<boolean> {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEYS.permissions);
    const perms = data[STORAGE_KEYS.permissions] as { bubble?: boolean } | undefined;
    return perms?.bubble !== false; // default ON
  } catch {
    return true;
  }
}

void bubbleEnabled().then((enabled) => {
  if (enabled) new BubbleWidget().mount();
});

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as { type?: string; text?: string; pattern?: string; max?: string; exact?: boolean; timeoutMs?: string };
  if (msg?.type === 'MOBIUS_READ_WA') {
    sendResponse(DomReader.readLastWhatsAppMessage());
    return false;
  }
  if (msg?.type === 'MOBIUS_READ_PAGE') {
    sendResponse(DomReader.readPageText());
    return false;
  }
  if (msg?.type === 'MOBIUS_INSERT_REPLY') {
    sendResponse(ActionExecutor.insertWhatsAppReply(msg.text ?? ''));
    return false;
  }
  // Skill tools (v7, deterministic, read-only) — called by WebSkillTools.
  if (msg?.type === 'MOBIUS_TOOL_CLICK_TEXT') {
    sendResponse(ActionExecutor.clickText(msg.text ?? '', msg.exact === true));
    return false;
  }
  if (msg?.type === 'MOBIUS_TOOL_TYPE_TEXT') {
    sendResponse(ActionExecutor.typeText(msg.text ?? ''));
    return false;
  }
  if (msg?.type === 'MOBIUS_TOOL_SUBMIT') {
    sendResponse(ActionExecutor.submit());
    return false;
  }
  if (msg?.type === 'MOBIUS_TOOL_READ_PAGE') {
    sendResponse(DomReader.readPageText());
    return false;
  }
  if (msg?.type === 'MOBIUS_TOOL_FIND_TEXT') {
    sendResponse(DomReader.findText(msg.text ?? '', msg.exact === true));
    return false;
  }
  if (msg?.type === 'MOBIUS_TOOL_EXTRACT') {
    sendResponse(DomReader.extract(msg.pattern ?? '', msg.max ? Number(msg.max) : 5));
    return false;
  }
  if (msg?.type === 'MOBIUS_TOOL_SCROLL') {
    sendResponse(ActionExecutor.scroll());
    return false;
  }
  if (msg?.type === 'MOBIUS_TOOL_BACK') {
    history.back();
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'MOBIUS_TOOL_HOME') {
    location.href = `${location.origin}/`;
    sendResponse({ ok: true });
    return false;
  }
  if (msg?.type === 'MOBIUS_TOOL_WAIT_FOR_TEXT') {
    void DomReader.waitForText(msg.text ?? '', msg.timeoutMs ? Number(msg.timeoutMs) : 5000).then((r) => sendResponse(r));
    return true; // async response
  }
  return false;
});
