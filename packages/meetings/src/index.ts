import type { CaptionAdapter } from "./captions.js";
import { createGoogleMeetAdapter } from "./adapters/google-meet.js";
import { createTeamsAdapter } from "./adapters/teams.js";
import { createZoomAdapter } from "./adapters/zoom.js";

export { createCaptionTranslator, createCaptionOverlay } from "./captions.js";
export { createGoogleMeetAdapter } from "./adapters/google-meet.js";
export { createTeamsAdapter } from "./adapters/teams.js";
export { createZoomAdapter } from "./adapters/zoom.js";
export type { Caption, CaptionAdapter, CaptionTranslator } from "./captions.js";

const ALL_ADAPTERS: (() => CaptionAdapter)[] = [
  createGoogleMeetAdapter,
  createTeamsAdapter,
  createZoomAdapter,
];

/** Pick the right adapter for a URL, or null if none match. */
export function pickAdapter(url: string): CaptionAdapter | null {
  for (const factory of ALL_ADAPTERS) {
    const a = factory();
    if (a.detect(url)) return a;
  }
  return null;
}
