import type { CaptionState } from './caption-state';

/**
 * Deterministic states for isolated caption visual tests.
 *
 * These fixtures deliberately bypass Tauri events, audio capture, settings,
 * credentials, and translation providers. They are rendered only when the
 * caption document is opened with an explicit `?fixture=...` query.
 */
const fixtures: Record<string, CaptionState> = {
  continuous: {
    appName: 'Preview',
    error: '',
    lastRevision: 12,
    captions: [
      {
        id: 'utterance-10',
        utterance: 10,
        lastSeq: 0,
        sourceText: 'We need to make the experience feel immediate.',
        translation: '我们需要让整个体验感觉即时而流畅。',
        corrected: false,
      },
      {
        id: 'utterance-11',
        utterance: 11,
        lastSeq: 0,
        sourceText: 'The final transcript can still be corrected afterward.',
        translation: '最终稿仍然可以在之后修正。',
        corrected: true,
      },
    ],
    draft: {
      utterance: 12,
      sourceText: 'Meanwhile the next sentence keeps moving as the speaker talks.',
      stablePrefixLength: 42,
      translation: '与此同时，下一句会随着说话人继续更新。',
    },
  },
  source: {
    appName: 'Preview',
    error: '',
    lastRevision: 3,
    captions: [
      {
        id: 'utterance-3',
        utterance: 3,
        lastSeq: 0,
        sourceText: 'Source captions remain visible while translation is pending.',
        corrected: false,
      },
    ],
    draft: null,
  },
  starting: {
    appName: 'Preview',
    error: '',
    lastRevision: 0,
    captions: [],
    draft: null,
  },
};

export function captionFixtureState(name: string | null): CaptionState | null {
  if (!name) return null;
  return fixtures[name] ?? null;
}
