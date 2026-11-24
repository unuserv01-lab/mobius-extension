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
  const msg = message as { type?: string; text?: string };
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
  return false;
});
