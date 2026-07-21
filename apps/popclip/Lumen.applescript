-- Mirrors the official Bob PopClip extension: hand the text to LumenWindow.
-- LumenWindow translates (target language currently hardcoded to zh-CN) and
-- shows a Bob-style floating window. The sdef does not declare a `to`
-- parameter, so we don't pass one.
tell application "LumenWindow"
	launch
	translate "{popclip text}"
end tell
