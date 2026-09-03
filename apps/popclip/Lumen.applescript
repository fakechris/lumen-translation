-- Hand the selected text to LumenTranslation, and also forward the user's
-- PopClip option choices (engine, apiKey, model, region, source/target lang)
-- as a JSON record. LumenTranslation applies these overrides before
-- translating, so PopClip is the quick-switch UI and the LumenTranslation
-- Preferences window is the full management UI.

-- Ensure the app is launched and running if it was not started yet.
set isRunning to false
try
	tell application "System Events"
		if exists (first process whose bundle identifier is "app.lumen.translation") then
			set isRunning to true
		end if
	end tell
end try

if not isRunning then
	try
		do shell script "open -b app.lumen.translation"
	on error
		try
			tell application "LumenTranslation" to launch
		end try
	end try
	-- Wait briefly for the companion app to initialize its scripting interface
	repeat 20 times
		delay 0.1
		try
			tell application "System Events"
				if exists (first process whose bundle identifier is "app.lumen.translation") then
					exit repeat
				end if
			end tell
		end try
	end repeat
	delay 0.2
end if

tell application "LumenTranslation"
	launch
	configure "{\"engine\":\"{popclip option engine}\",\"apiKey\":\"{popclip option apiKey}\",\"model\":\"{popclip option model}\",\"region\":\"{popclip option region}\",\"sourceLang\":\"{popclip option sourceLang}\",\"targetLang\":\"{popclip option targetLang}\"}"
	translate "{popclip text}"
end tell
