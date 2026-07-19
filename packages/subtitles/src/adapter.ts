/**
 * Video platform adapters.
 *
 * An adapter knows how to discover subtitle tracks on a given video platform,
 * load a track as `SubtitleCue[]`, and render bilingual `TranslatedCue[]` into
 * a host container element. Adapters are intentionally narrow interfaces so
 * that platform-specific code (player DOM, fetch auth, etc.) can live behind
 * them without leaking into the rest of the package.
 *
 * `CompositeAdapter` picks the right adapter for a URL by asking each
 * registered adapter (in registration order) whether it `detect`s the URL.
 */

import type { SubtitleCue, TranslatedCue } from "./types.js";

export interface SubtitleTrack {
  id: string;
  /** Human-readable label shown in track pickers. */
  label: string;
  /** BCP-47 language tag, e.g. `en`, `zh-Hans`. */
  lang: string;
  /** Adapter-specific source identifier (URL, track index, etc.). */
  source: string;
}

export interface VideoPlatformAdapter {
  /** Stable adapter id, e.g. `youtube`, `bilibili`. */
  id: string;
  /** Return true if this adapter handles the given video URL. */
  detect(url: string): boolean;
  /** List subtitle tracks available for the current video. */
  getSubtitleTracks(): Promise<SubtitleTrack[]>;
  /** Load a track's cues. */
  loadTrack(track: SubtitleTrack): Promise<SubtitleCue[]>;
  /** Render bilingual cues into a container element owned by the host. */
  renderBilingual(cues: TranslatedCue[], container: Element): void;
}

export class CompositeAdapter implements VideoPlatformAdapter {
  readonly id = "composite";
  private adapters: VideoPlatformAdapter[];
  private selected: VideoPlatformAdapter | null = null;

  constructor(adapters: VideoPlatformAdapter[] = []) {
    this.adapters = adapters;
  }

  register(adapter: VideoPlatformAdapter): void {
    this.adapters.push(adapter);
  }

  detect(url: string): boolean {
    const found = this.adapters.find((a) => a.detect(url)) ?? null;
    this.selected = found;
    return found !== null;
  }

  private require(): VideoPlatformAdapter {
    if (!this.selected) {
      throw new Error("CompositeAdapter.detect(url) must be called and return true first.");
    }
    return this.selected;
  }

  getSubtitleTracks(): Promise<SubtitleTrack[]> {
    return this.require().getSubtitleTracks();
  }

  loadTrack(track: SubtitleTrack): Promise<SubtitleCue[]> {
    return this.require().loadTrack(track);
  }

  renderBilingual(cues: TranslatedCue[], container: Element): void {
    this.require().renderBilingual(cues, container);
  }
}
