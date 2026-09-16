Write-Host "=== Fix WhatsApp bot compatibility issues ===" -ForegroundColor Cyan

if (-not (Test-Path "index.js")) {
    Write-Host "ERROR: Run this from inside the project folder (the one containing index.js)" -ForegroundColor Red
    exit 1
}

Write-Host "[1/4] Rewriting index.js (msg.getChat -> msg.from.endsWith fix)..."
$content = Get-Content -Raw "index.js"
if ($content -match [regex]::Escape("msg.getChat()")) {
    $pattern = 'const chat = await msg\.getChat\(\);\r?\n\s*if \(chat\.isGroup\) return;'
    $content = [regex]::Replace($content, $pattern, 'if (msg.from.endsWith("@g.us")) return;')
    Set-Content -Path "index.js" -Value $content -NoNewline
    Write-Host "  -> fixed" -ForegroundColor Green
} else {
    Write-Host "  -> already fixed, no change needed" -ForegroundColor Yellow
}

Write-Host "[2/4] Patching node_modules\whatsapp-web.js Utils.js..."
$utilsPath = "node_modules\whatsapp-web.js\src\util\Injected\Utils.js"
if (Test-Path $utilsPath) {
    $utilsContent = Get-Content -Raw $utilsPath
    $needle = ".canCheckStatusRankingPosterGating(),"
    if ($utilsContent.Contains($needle)) {
        $utilsContent = $utilsContent.Replace($needle, "?.canCheckStatusRankingPosterGating?.() || false,")
        Set-Content -Path $utilsPath -Value $utilsContent -NoNewline
        Write-Host "  -> patched" -ForegroundColor Green
    } else {
        Write-Host "  -> already patched, no change needed" -ForegroundColor Yellow
    }
} else {
    Write-Host "  -> WARNING: file not found at $utilsPath" -ForegroundColor Red
}

Write-Host "[3/4] Restarting the bot fresh with PM2..."
pm2 delete agriculture-bot 2>$null | Out-Null
pm2 start index.js --name agriculture-bot
pm2 save

Write-Host "[4/4] Flushing old logs..."
pm2 flush agriculture-bot

Write-Host ""
Write-Host "=== Done. Showing live logs now (Ctrl+C stops watching, the bot keeps running) ===" -ForegroundColor Cyan
pm2 logs agriculture-bot
