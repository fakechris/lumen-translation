import { describe, expect, it } from 'vitest';

import { captionReducer, initialCaptionState, shouldAcceptCaptionSession } from '../caption-state';
import { captionFixtureState } from '../caption-fixtures';

describe('caption session ordering', () => {
  it('rejects a stale recovery response after a newer session starts', () => {
    expect(shouldAcceptCaptionSession(true, 8, 7)).toBe(false);
    expect(shouldAcceptCaptionSession(true, 8, 8)).toBe(true);
    expect(shouldAcceptCaptionSession(true, 8, 9)).toBe(true);
    expect(shouldAcceptCaptionSession(false, null, 9)).toBe(false);
  });
});

describe('caption visual fixtures', () => {
  it('provides a fully local continuous-flow state', () => {
    const fixture = captionFixtureState('continuous');

    expect(fixture?.captions).toHaveLength(2);
    expect(fixture?.captions[1]).toMatchObject({ corrected: true });
    expect(fixture?.draft?.stablePrefixLength).toBeGreaterThan(0);
  });

  it('does not activate for missing or unknown fixture names', () => {
    expect(captionFixtureState(null)).toBeNull();
    expect(captionFixtureState('unknown')).toBeNull();
    expect(captionFixtureState('constructor')).toBeNull();
  });
});

describe('caption flow', () => {
  it('replaces a partial in place and tracks the stable prefix', () => {
    const first = captionReducer(initialCaptionState, {
      type: 'partial',
      event: {
        revision: 1,
        utterance: 7,
        seq: 0,
        appName: 'Player',
        text: 'hello wor',
        isFinal: false,
      },
    });
    const second = captionReducer(first, {
      type: 'partial',
      event: {
        revision: 2,
        utterance: 7,
        seq: 0,
        appName: 'Player',
        text: 'hello world',
        isFinal: false,
      },
    });

    expect(second.draft).toMatchObject({
      utterance: 7,
      sourceText: 'hello world',
      stablePrefixLength: 9,
    });
    expect(second.captions).toEqual([]);
  });

  it('promotes all pieces of one utterance into one bilingual caption', () => {
    const withDraft = captionReducer(initialCaptionState, {
      type: 'partial',
      event: {
        revision: 1,
        utterance: 3,
        seq: 0,
        appName: 'Player',
        text: 'First sentence. Second sentence.',
        isFinal: false,
      },
    });
    const withDraftTranslation = captionReducer(withDraft, {
      type: 'draft-translation',
      utterance: 3,
      sourceText: 'First sentence. Second sentence.',
      translation: '第一句。第二句。',
    });
    const firstFinal = captionReducer(withDraftTranslation, {
      type: 'final',
      event: {
        revision: 2,
        utterance: 3,
        seq: 0,
        appName: 'Player',
        text: 'First sentence.',
        isFinal: true,
      },
    });
    const secondFinal = captionReducer(firstFinal, {
      type: 'final',
      event: {
        revision: 2,
        utterance: 3,
        seq: 1,
        appName: 'Player',
        text: 'Second sentence.',
        isFinal: true,
      },
    });

    expect(secondFinal.draft).toBeNull();
    expect(secondFinal.captions).toHaveLength(1);
    expect(secondFinal.captions[0]).toMatchObject({
      id: 'utterance-3',
      sourceText: 'First sentence. Second sentence.',
      translation: '第一句。第二句。',
    });
  });

  it('does not promote a draft translation when the final source changed', () => {
    const draft = captionReducer(initialCaptionState, {
      type: 'partial',
      event: {
        revision: 1,
        utterance: 4,
        seq: 0,
        appName: 'Player',
        text: 'draft wording',
        isFinal: false,
      },
    });
    const translated = captionReducer(draft, {
      type: 'draft-translation',
      utterance: 4,
      sourceText: 'draft wording',
      translation: '旧翻译',
    });
    const final = captionReducer(translated, {
      type: 'final',
      event: {
        revision: 2,
        utterance: 4,
        seq: 0,
        appName: 'Player',
        text: 'corrected wording',
        isFinal: true,
      },
    });

    expect(final.captions[0].translation).toBeUndefined();
  });

  it('applies a late refine in chronological place without moving old text to the bottom', () => {
    const first = captionReducer(initialCaptionState, {
      type: 'final',
      event: {
        revision: 1,
        utterance: 1,
        seq: 0,
        appName: 'Player',
        text: 'old text',
        isFinal: true,
      },
    });
    const second = captionReducer(first, {
      type: 'final',
      event: {
        revision: 2,
        utterance: 2,
        seq: 0,
        appName: 'Player',
        text: 'newer text',
        isFinal: true,
      },
    });
    const refined = captionReducer(second, {
      type: 'refine',
      event: { utterance: 1, appName: 'Player', text: 'corrected old text' },
    });

    expect(refined.captions.map((caption) => caption.sourceText)).toEqual([
      'corrected old text',
      'newer text',
    ]);
    expect(refined.captions[0].translation).toBeUndefined();
  });

  it('drops stale translations after a refine changes the source text', () => {
    const final = captionReducer(initialCaptionState, {
      type: 'final',
      event: {
        revision: 1,
        utterance: 5,
        seq: 0,
        appName: 'Player',
        text: 'before',
        isFinal: true,
      },
    });
    const refined = captionReducer(final, {
      type: 'refine',
      event: { utterance: 5, appName: 'Player', text: 'after' },
    });
    const stale = captionReducer(refined, {
      type: 'caption-translation',
      id: 'utterance-5',
      sourceText: 'before',
      translation: '旧译文',
    });

    expect(stale.captions[0].translation).toBeUndefined();
  });
});
