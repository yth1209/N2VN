const axios = require('axios');

async function test() {
  try {
    const res = await axios.post('https://cloud.leonardo.ai/api/rest/v1/generations', {
      height: 1024,
      width: 576,
      modelId: "aa77f04e-3eec-4034-9c07-d0f619684628",
      prompt: "test anime girl, smile",
      num_images: 1,
      controlnets: [
        {
          initImageId: "af4e7891-c0e6-43a5-a87a-fba472b44f2c",
          initImageType: "GENERATED",
          preprocessorId: 133,
          strengthType: "High"
        }
      ]
    }, {
      headers: {
        accept: 'application/json',
        authorization: 'Bearer c7fb5857-e0b2-4d18-97b3-23d2e37fbcfd'
      }
    });
    console.log("SUCCESS:", res.data);
  } catch (e) {
    console.error("ERROR:");
    console.error(JSON.stringify(e.response?.data, null, 2));
  }
}
test();
