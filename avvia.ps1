# Diagramma Cascata - Avvio server locale
# Doppio clic per avviare; chiudi la finestra per fermare il server

$ErrorActionPreference = "Stop"
$port = 8000
$dir = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host "=========================================="
Write-Host "   Diagramma Cascata - Avvio server`n"
Write-Host "==========================================`n"

# Pulizia: uccidi eventuali server orfani sulla porta 8000
$zombies = netstat -ano | Select-String ":$port .*LISTENING" | ForEach-Object { $_ -split '\s+' | Where-Object { $_ -match '^\d+$' } }
if ($zombies) { $zombies | ForEach-Object { taskkill /PID $_ /F /ErrorAction SilentlyContinue } }
Start-Sleep -Seconds 1

# Avvia il server in background (nessuna finestra)
$proc = Start-Process -FilePath "python" -ArgumentList "-m", "http.server", $port, "--bind", "0.0.0.0" -WorkingDirectory $dir -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 3

# Verifica che sia in ascolto
$ok = (netstat -ano | Select-String ":$port .*LISTENING").Length -gt 0

if ($ok) {
    Write-Host "SERVER AVVIATO con successo.`n"
    Write-Host "Da questo PC:      http://localhost:$port/runme.html`n"
    Write-Host "Da telefono/Wi-Fi: http://<IP-PC>:$port/runme.html`n"
    Write-Host "Per trovare l'IP:  apri prompt e digita ipconfig`n"
    Write-Host "Cerca ""Indirizzo IPv4"".`n"
    Write-Host "Il server rimane in ascolto finché non chiudi questa finestra.`n"
} else {
    Write-Host "ERRORE: il server non è partito (porta $port occupata o python mancante).`n"
    Write-Host "Verifica: where python`n"
    $proc | Stop-Process -Force
}

# Mantieni la finestra aperta
if (-not $ok) { pause }
