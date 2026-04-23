이제 각 Scene에 맞는 BGM을 생성하는 로직을 추가해줘.
캐릭터 이미지와 배경 이미지처럼 Scene 생성 로직에서 기존 bgm id + 설명을 input으로 넣고 어울리는것이 있으면 해당 bgm id를 반환하고, 없으면 새로 생성해서 반환해.
다만 bgm id는 uuid를 만들기 전이니 임의로 new_bgm_{num}형태로 넣어두면 이후 DB에 적재하며 uuid를 발급 받고, 이를 scenes.json에 다시 치환하여 저장하는 형태로 진행하면 좋을 것 같음.
위 DB와 scenes.json에 적재를 먼저 한 후, bgm gen ai를 활용해서 뽑으면 되. bgm 파일도 s3에 업로드. 
지금 background 이미지 생성도 문제가 있는데 먼저 background 이미지를 별도로 뽑다 보니, 후에 scene에서 사용되지 않는 배경 이미지들이 발생함. 실제 장소는 6개로 뽑으나, 적절한 scene 분배는 4개인 경우 등이 있음.
그래서 background 이미지도 scene을 추출하는 시점에 위 bgm처럼 함께 처리하는게 좋을 것 같음