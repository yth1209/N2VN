Invoke-RestMethod -Uri "http://localhost:3000/parsing/characters" -Method POST -Headers @{"Content-Type"="application/json"} -Body '{"novelTitle": "wuxia"}'

Invoke-RestMethod -Uri "http://localhost:3000/parsing/scenes" -Method POST -Headers @{"Content-Type"="application/json"} -Body '{"novelTitle": "wuxia"}'