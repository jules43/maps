@echo off

setlocal enabledelayedexpansion

cd %~dp0

call export sw setup
call export sw mapimg
call export sw markers

magick ..\source\sw\mapimg\swmapfog-ea.png -resize 8192x8192 ..\source\sw\mapimg\swmapfog.png

call export sw applyfog

xcopy /Q /Y ..\source\sw\mapimg\swmap-fogged.png ..\source\swmap-final.png

export sw gentiles

endlocal
