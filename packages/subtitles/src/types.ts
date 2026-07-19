/**
 * @lumen/subtitles — subtitle cue types.
 *
 * Timestamps are always expressed in seconds (floating point). Parsers convert
 * the on-disk `HH:MM:SS,mmm` / `HH:MM:SS.mmm` forms into seconds; serializers
 * convert back.
 */

/** A single subtitle cue. */
export interface SubtitleCue {
  /** Stable identifier (typically the SRT/VTT cue index as a string). */
  id: string;
  /** Start time in seconds. */
  start: number;
  /** End time in seconds. */
  end: number;
  /** Cue text. May contain a single line or multiple lines separated by `\n`. */
  text: string;
}

/** A translated subtitle cue, preserving the original text. */
export interface TranslatedCue {
  id: string;
  start: number;
  end: number;
  /** Translated text. */
  text: string;
  /** Original (source-language) cue text. */
  originalText: string;
}
