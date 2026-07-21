-- Mirrors the official Bob PopClip extension: hand the text to LumenWindow,
-- but also forward the user's PopClip option choices (engine, apiKey, model,
-- region, source/target lang) as a JSON record. LumenWindow applies these
-- overrides before translating, so PopClip is the quick-switch UI and the
-- LumenWindow Preferences window is the full management UI.
tell application "LumenWindow"
	launch
	configure "{\"engine\":\"{popclip option engine}\",\"apiKey\":\"{popclip option apiKey}\",\"model\":\"{popclip option model}\",\"region\":\"{popclip option region}\",\"sourceLang\":\"{popclip option sourceLang}\",\"targetLang\":\"{popclip option targetLang}\"}"
	translate "{popclip text}"
end tell
