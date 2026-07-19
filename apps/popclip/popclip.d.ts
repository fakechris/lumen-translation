// Minimal ambient declarations for the PopClip JavaScript environment, in case
// @popclip/types is not resolvable in a given build context. These are merged
// with the real types from @popclip/types when present.

declare const popclip: {
  input: { text: string; matchedText: string; html?: string; markdown?: string };
  context: { browserUrl?: string; browserTitle?: string; appName?: string };
  modifiers: { command: boolean; option: boolean; shift: boolean; control: boolean };
  options: Record<string, string | boolean>;
  showText: (text: string) => void;
  copyText: (text: string) => void;
  pasteText: (text: string) => void;
  openUrl: (url: string) => void;
  showSuccess: () => void;
  showFailure: (message?: string) => void;
  showSettings: () => void;
};

declare const pasteboard: { text: string };
declare function sleep(ms: number): Promise<void>;
