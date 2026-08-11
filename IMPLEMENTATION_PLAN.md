# Windows port ‚Äî implementation plan

Goal: bring Lumen Translation's desktop experience to Windows. macOS ships a
Swift/AppKit menu-bar app (`apps/popclip-window`) driven by PopClip. **PopClip
does not exist on Windows**, so the selection-popup half of the product has to
be built from scratch alongside the translation window itself.

Packaging and CI mirror the sibling `lumen-asr` repo: Tauri v2, an NSIS
current-user installer, plus an MSIX for Microsoft Store ingestion, both
produced by `windows-latest` GitHub runners. Until the NSIS artifact is
code-signed it is a development preview, published with a SHA-256 manifest and
GitHub build-provenance attestation rather than presented as a trusted direct
release.

## What is macOS-only today

| Area               | macOS today                                 | Windows plan                            #]6ÁŒm¢Gß≤⁄Óù∆≠y“el };
    } catch (err) {
      lastError = `${preset.label}: ${(err as Error).message}`;
      console.warn(`[lumen] ${preset.id} failed; trying next provider`, err);
    }
  }
  throw new TranslationFailed(lastError);
}
