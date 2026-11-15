# Änderungen (15.11.2026): flüssiger, keine Hänger, übersichtlichere rechte Seite

## Warum die Seite hing
Render (kostenloser Plan) hat sehr wenig CPU und schläft nach 15 min ohne Besucher ein.
Jeder Klick hat alle Statistiken neu gerechnet, und alte Anfragen liefen beim Regionswechsel weiter.
Mehrere Anfragen gleichzeitig → alle wurden langsam → „Loading…“ ohne Ende.

## Backend (backend/app.py)
- Ergebnis-Cache: jede Auswertung wird einmal gerechnet und gespeichert (2. Aufruf: Millisekunden).
- Gleiche Anfragen, die gleichzeitig kommen, warten auf eine einzige Berechnung statt doppelt zu rechnen.
- Warm-up: Nach dem Start werden die mitgelieferten Studiengebiete vorberechnet → Demo-Buttons sofort da.
- GZip: die Weltkarte (750 kB) wird komprimiert übertragen.
- /health zeigt jetzt, ob das Warm-up fertig ist.

## Frontend
- Beim Wechsel der Region werden alte Anfragen abgebrochen.
- Ladeanzeige mit Sekundenzähler; nach 12 s Hinweis „Server wacht gerade auf“.
- Zeitlimit 2 min, danach Fehlerkarte mit „Try again“-Button statt endlosem Laden.
- Rechte Seite: breiter (40 % statt max. 475 px), mit der Maus ziehbar (Doppelklick = zurücksetzen), Knopf „Wider“.
- Übersicht: oben Zähler (signifikant / möglich / kein Trend); jede Variable zeigt Trend pro Jahrzehnt,
  Änderung in % und das Ergebnis-Abzeichen; sortiert: signifikante Trends zuerst.
- Detail: 4 Kennzahlen – Trend pro Jahrzehnt (mit 95 %-Bereich), Gesamtänderung, Signifikanz
  (Seasonal Kendall p, Mann-Kendall p, FDR q), Zeitraum. Größeres Diagramm.
- „Clear trend“ hieß wie ein Button → jetzt „Significant trend / Possible trend / No significant trend“.
- Einheiten lesbar (kg/m² statt kg m-2), leere Klammer „()“ an der Diagrammachse entfernt.
- Doppelter „Overview ›“-Knopf wird ausgeblendet, solange die Seite offen ist.

## Neues Studiengebiet
- Homokhátság („Hungary's hidden desert“, Box 19, 46, 20.5, 47.3) mit 6 GLDAS-Giovanni-CSVs in data/giovanni/.
- Neuer erster Demo-Button; Carpathian Basin bleibt als zweiter Button.
- Giovanni-Dateien werden Boxen nur noch zugeordnet, wenn sich die Flächen weitgehend decken
  (sonst bekam das kleine Gebiet die Daten der großen Carpathian-Box).

## Tests
python tests/test_api.py → ALL PASS · python tests/test_stats.py → ALL PASS

## So kommt es online
1. Inhalt dieses Ordners in den Repo-Ordner „earthtrend-explorer 3“ kopieren (alles ersetzen), committen, pushen.
2. In Render prüfen, dass der neueste Commit deployed ist (sonst „Manual Deploy → Deploy latest commit“).
3. Vor der Präsentation die Seite 1–2 min vorher einmal öffnen (Server aufwecken).
   Dauerhaft wach: kostenloser Ping-Dienst (z. B. UptimeRobot) alle 10 min auf /health, oder Render „Starter“-Plan.
