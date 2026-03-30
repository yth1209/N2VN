Invoke-RestMethod -Uri "http://localhost:3000/parsing/characters" -Method POST -Headers @{"Content-Type"="application/json"} -Body '{"novelTitle": "wuxia"}'

Invoke-RestMethod -Uri "http://localhost:3000/parsing/scenes" -Method POST -Headers @{"Content-Type"="application/json"} -Body '{"novelTitle": "wuxia"}'


curl --request POST \
     --url https://cloud.leonardo.ai/api/rest/v1/generations \
     --header 'accept: application/json' \
     --header 'authorization: Bearer c7fb5857-e0b2-4d18-97b3-23d2e37fbcfd' \
     --header 'content-type: application/json' \
     --data '{
  "prompt": "(detailed wuxia illustration, masterpiece, aesthetic martial arts lighting, high quality webtoon style:1.2), A young female martial artist with reddish-brown hair tied in a high ponytail and playful yet bold amber eyes. She has a lithe, agile physique, wearing a basic grey martial uniform with red fabric straps on sleeves and waist. She carries an old, heavy wooden sword with a plum blossom pattern., full body shot, full length portrait, showing entire body from head to feet, standing, zoomed out, distant angle, isolated on a simple solid white background, no background",
  "width": 576,
  "height": 1024,
  "modelId": "7b592283-e8a7-4c5a-9ba6-d18c31f258b9",
  "negative_prompt": "background details, scenery, complex background, outdoors, indoors, cropped, out of frame, cut off, close-up, portrait, upper body, missing limbs, amputated, invisible head, unseen feet",
  "num_images": 1,
  "transparency": "disabled",
  "styleUUID": "dee282d3-891f-4f73-ba02-7f8131e5541b"
}'