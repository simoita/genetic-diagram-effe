# Cascade Bridge — ponte tra Diagramma Cascata e Fusion 360

Add-in Fusion 360 che collega direttamente il diagramma condiviso all'app web.

- legge e scrive lo **stesso documento Supabase** dell'app (merge per campo e controllo di versione);
- in alternativa carica il file **`cascade_fusion_bridge.json`** esportato dall'app;
- crea e aggiorna i **parametri utente** di Fusion;
- **rinomina i parametri** in Fusion: Fusion aggiorna da solo tutte le espressioni e le feature che li usano;
- legge i valori da Fusion e li riscrive nel diagramma (cloud o file);
- collega i **file delle varianti** e li inserisce nel modello (STEP, IGES, SAT, SMT, F3D, DXF);
- esporta un CSV con tutte le varianti e i loro 5 parametri.

## Installazione (Windows)

1. Chiudi Fusion 360.
2. Esegui `fusion360\installa_addin.bat`.
   Il file copia la cartella interna `CascadeBridge` (con `.py`, `.manifest` e
   `palette`) in
   `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\CascadeBridge`.
3. Apri Fusion 360 → **Strumenti → Add-in → Script e Add-in** → scheda **Add-in**.
4. Seleziona **CascadeBridge** (è il nome della cartella) e premi **Run**.
5. Nella scheda **Strumenti**, pannello **Script e Add-in**, compare il comando **Cascade Bridge**.

La cartella deve contenere direttamente `CascadeBridge.py`, `CascadeBridge.manifest`
e `palette\index.html`. Fusion non accetta il solo file `.py`: installa la cartella
`CascadeBridge`, non la cartella `fusion360` che la contiene.

Installazione manuale (Windows o Mac): copia la cartella `CascadeBridge` (quella
interna a `fusion360`) in

- Windows: `%APPDATA%\Autodesk\Autodesk Fusion 360\API\AddIns\`
- macOS: `~/Library/Application Support/Autodesk/Autodesk Fusion 360/API/AddIns/`

## Primo collegamento

Apri la palette e vai in **Impostazioni**.

**Metodo A — cartella progetto (consigliato)**
1. Premi **Sfoglia…** e scegli la cartella `Diagramma cascata`
   (quella che contiene `runme.html`, `app.js` e `supabase-config.js`).
2. L'add-in legge da solo URL, chiave publishable e ID del diagramma.
3. Premi **Salva impostazioni**.

**Metodo B — file ponte**
1. Nell'app web premi **Fusion 360** nella barra e scarica `cascade_fusion_bridge.json`.
2. Nella palette premi **Carica JSON** e apri il file.

**Metodo C — manuale**
Inserisci URL Supabase, chiave publishable/anon e ID diagramma
(`00000000-0000-0000-0000-000000000000` nel progetto attuale).

La chiave anon è pubblica per definizione; **non** usare mai la `service_role`.

## Uso

- **Pagina / Parte**: scegli la pagina e la variante da applicare al modello.
- **Parametri**: i 5 nomi sono globali, i valori sono quelli della variante scelta.
  - **Salva e applica a Fusion**: salva nomi/valori nel diagramma e li applica al modello.
  - **Salva nel diagramma**: scrive solo nel cloud/file ponte.
  - **Solo Fusion**: applica al modello senza toccare il diagramma.
  - **Da Fusion al diagramma**: legge nomi e valori dal modello e li riporta nel diagramma.
  - **Riallinea nomi**: rinomina i parametri Fusion già esistenti senza crearne.
- **Diagramma**: esplora fasi, zone e parti; un clic seleziona la variante.
- **File**: collega il file locale della variante, aprilo o inseriscilo nel modello.
- **Impostazioni**: unità, rinomina automatica e aggiornamento dal cloud ogni 25 secondi.

### Rinomina globale

Se cambi il nome di un parametro nel diagramma (anche in una parte già esistente),
l'app web aggiorna subito tutte le parti. L'add-in, al successivo aggiornamento o
con **Salva e applica**, rinomina il parametro Fusion. Fusion mantiene il valore e
aggiorna automaticamente ogni espressione che referenzia il vecchio nome.

Anche il contrario funziona: rinomina il parametro in Fusion e premi
**Da Fusion al diagramma**; il nuovo nome viene applicato a tutte le parti del diagramma.

Nota: Fusion non accetta spazi o caratteri speciali nei nomi dei parametri.
L'add-in converte ad esempio `Parametro A` in `Parametro_A` e mostra il nome reale
nella colonna **In Fusion**.

## Unità

In Impostazioni scegli l'unità con cui il diagramma esprime i valori (`mm` predefinita).
Il valore viene scritto come espressione con unità (`12.5 mm`), quindi Fusion converte
correttamente anche se il documento usa un'altra unità. Sono accettate anche formule
o riferimenti a parametri esistenti (es. `Larghezza / 2`).

## File e cartella dati

Impostazioni, cache e CSV sono in `C:\Users\<utente>\CascadeBridge`
(macOS: `~/CascadeBridge`). La palette ha **Apri cartella dati**.

## Problemi comuni

- **La palette non si apre**: verifica che la cartella contenga `palette\index.html`
  e riavvia Fusion dopo l'installazione.
- **Nessun Design attivo**: apri un modello Fusion prima di applicare i parametri.
- **Diagramma non trovato nel cloud**: controlla ID diagramma e che l'app web abbia
  salvato almeno una pagina.
- **Conflitto di sincronizzazione**: l'add-in rilegge e riprova; se persiste, premi
  **Aggiorna** e riapplica.
- **Errore su un parametro**: il nome potrebbe essere già usato da un altro parametro
  del modello. Controlla la colonna **In Fusion** e il messaggio nella palette.
