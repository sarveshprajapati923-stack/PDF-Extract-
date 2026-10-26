import type { Settings } from './types';

export const DEFAULT_TEMPLATE =
  "Hello {name}, I'm {myName} from {myBusiness}. I found your business listing on a local map and wanted to ask if you'd like help with a website or online presence. I can share a few examples if useful. If not, no problem at all. Thank you!";

/** Builds the draft shown in WhatsApp. The user reviews and sends it manually. */
export function fillTemplate(
  s: Pick<Settings, 'myName' | 'myBusiness' | 'template'>,
  name: string,
): string {
  const tpl = s.template.trim() ? s.template : DEFAULT_TEMPLATE;
  return tpl
    .replace(/\{name\}/g, name)
    .replace(/\{myName\}/g, s.myName.trim() || '[your name]')
    .replace(/\{myBusiness\}/g, s.myBusiness.trim() || '[your business]');
}
