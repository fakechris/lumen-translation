export interface CaptionEvent {
  revision: number;
  utterance: number;
  seq: number;
  appName: string;
  text: string;
  isFinal: boolean;
}

export interface CaptionRefineEvent {
  utterance: number;
  appName: string;
  text: string;
}

export type CaptionWindowStatus =
  { kind: 'target'; message: string } | { kind: 'error'; message: string };

export interface CaptionLine {
  id: string;
  utterance: number;
  lastSeq: number;
  sourceText: string;
  translation?: string;
  corrected: boolean;
}

export interface CaptionDraft {
  utterance: number;
  sourceText: string;
  stablePrefixLength: number;
  translation?: string;
}

export interface CaptionState {
  captions: CaptionLine[];
  draft: CaptionDraft | null;
  appName: string;
  error: string;
  lastRevision: number;
}

export type CaptionAction =
  | { type: 'partial'; event: CaptionEvent }
  | { type: 'final'; event: CaptionEvent }
  | { type: 'refine'; event: CaptionRefineEvent }
  | {
      type: 'caption-translation';
      id: string;
      sourceText: string;
      translation: string;
    }
  | {
      type: 'draft-translation';
      utterance: number;
      sourceText: string;
      translation: string;
    }
  | { type: 'status'; status: CaptionWindowStatus }
  | { type: 'reset' };

export const initialCaptionState: CaptionState = {
  captions: [],
  draft: null,
  appName: '',
  error: '',
  lastRevision: 0,
};

export function shouldAcceptCaptionSession(
  active: boolean,
  currentSessionId: number | null,
  incomingSessionId: number,
): boolean {
  return active && (currentSessionId === null || incomingSessionId >= currentSessionId);
}

const CAPTION_HISTORY_LIMIT = 24;

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
}

function appendCaptionPiece(current: string, next: string): string {
  const left = current.trimEnd();
  const right = next.trimStart();
  if (!left) return right;
  if (!right) return left;

  const needsSpace = /^[A-Za-z0-9]/.test(right) && /[A-Za-z0-9.!?;,:)]$/.test(left);
  return `${left}${needsSpace ? ' ' : ''}${right}`;
}

export function captionReducer(state: CaptionState, action: CaptionAction): CaptionState {
  switch (action.type) {
    case 'partial': {
      const event = action.event;
      if (event.revision < state.lastRevision) return state;
      const sourceText = event.text.trim();
      if (!sourceText) return state;

      const previous = state.draft?.utterance === event.utterance ? state.draft : null;
      const stablePrefixLength = previous ? commonPrefixLength(previous.sourceText, sourceText) : 0;
      // Retain the existing draft translation while speech in the same utterance continues
      const translation = previous?.translation;

      return {
        ...state,
        appName: event.appName,
        error: '',
        lastRevision: event.revision,
        draft: {
          utterance: event.utterance,
          sourceText,
          stablePrefixLength,
          translation,
        },
      };
    }

    case 'final': {
      const event = action.event;
      if (event.revision < state.lastRevision) return state;
      const piece = event.text.trim();
      if (!piece) return state;

      const id = `utterance-${event.utterance}`;
      const existingIndex = state.captions.findIndex((caption) => caption.id === id);
      const draftForUtterance = state.draft?.utterance === event.utterance ? state.draft : null;
      let captions = state.captions;
      let committedSourceText = piece;

      if (existingIndex >= 0) {
        const existing = state.captions[existingIndex];
        if (event.seq <= existing.lastSeq) return { ...state, lastRevision: event.revision };
        const sourceText = appendCaptionPiece(existing.sourceText, piece);
        committedSourceText = sourceText;
        captions = state.captions.map((caption, index) =>
          index === existingIndex
            ? {
                ...caption,
                lastSeq: event.seq,
                sourceText,
                translation:
                  draftForUtterance?.sourceText === sourceText
                    ? draftForUtterance.translation
                    : caption.translation,
                corrected: false,
              }
            : caption,
        );
      } else {
        const promotedTranslation =
          draftForUtterance?.sourceText === piece ? draftForUtterance.translation : undefined;
        captions = [
          ...state.captions,
          {
            id,
            utterance: event.utterance,
            lastSeq: event.seq,
            sourceText: piece,
            translation: promotedTranslation,
            corrected: false,
          },
        ].slice(-CAPTION_HISTORY_LIMIT);
      }

      const keepDraft =
        draftForUtterance !== null &&
        draftForUtterance.sourceText !== committedSourceText &&
        draftForUtterance.sourceText.startsWith(committedSourceText);

      return {
        ...state,
        captions,
        draft: draftForUtterance ? (keepDraft ? draftForUtterance : null) : state.draft,
        appName: event.appName,
        error: '',
        lastRevision: event.revision,
      };
    }

    case 'refine': {
      const sourceText = action.event.text.trim();
      if (!sourceText) return state;
      const id = `utterance-${action.event.utterance}`;
      const existing = state.captions.find((caption) => caption.id === id);
      if (!existing) return state;

      return {
        ...state,
        appName: action.event.appName,
        captions: state.captions.map((caption) =>
          caption.id === id
            ? {
                ...caption,
                sourceText,
                translation: caption.sourceText === sourceText ? caption.translation : undefined,
                corrected: caption.sourceText !== sourceText,
              }
            : caption,
        ),
      };
    }

    case 'caption-translation':
      return {
        ...state,
        captions: state.captions.map((caption) =>
          caption.id === action.id && caption.sourceText === action.sourceText
            ? { ...caption, translation: action.translation }
            : caption,
        ),
      };

    case 'draft-translation':
      if (state.draft?.utterance !== action.utterance) {
        return state;
      }
      return {
        ...state,
        draft: { ...state.draft, translation: action.translation },
      };

    case 'status':
      if (action.status.kind === 'target') {
        return { ...state, appName: action.status.message, error: '' };
      }
      return { ...state, error: action.status.message };

    case 'reset':
      return { ...initialCaptionState };
  }
}
