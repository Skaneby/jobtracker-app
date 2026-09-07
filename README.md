# jobtracker-app

Mobilappen (PWA) för [jobtracker](https://github.com/Skaneby/jobtracker) — ett
privat verktyg som bevakar jobbannonser och genererar utkast till CV och
personligt brev.

**Det här repot innehåller bara appens skal** — HTML, CSS, JavaScript och ikoner.
Det ligger publikt enbart för att GitHub Pages kräver ett publikt repo på
nuvarande plan.

Inga hemligheter finns här. Appen läser jobbdata direkt från det privata repot i
webbläsaren, med en personlig access token som användaren klistrar in en gång och
som bara sparas i telefonens `localStorage`. Varken token eller jobbdata passerar
det här repot.

Uppdateras genom att synka `pwa/` från huvudrepot.
