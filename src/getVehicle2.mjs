import { MongoClient, ObjectId } from 'mongodb';
const MONGO_URI = 'mongodb://dealvercel:juicehead2410@72.60.118.141:27017/dealerversal?authSource=admin';
const client = new MongoClient(MONGO_URI);
try {
  await client.connect();
  const db = client.db('dealerversal');
  
  const item = await db.collection('inventory').findOne({ _id: new ObjectId('6a9e104c215cda1387bbe3d6') });
  if (item) {
    console.log('Year:', item.year);
    console.log('Make:', item.make);
    console.log('Model:', item.model);
    console.log('Trim:', item.trim);
    console.log('Title:', item.title);
    console.log('Price:', item.price);
    console.log('Mileage:', item.mileage);
    console.log('VIN:', item.vin);
    console.log('SiteUrl:', item.siteUrl);
    console.log('Highlighted Features:', JSON.stringify(item.highlighted_features));
    console.log('Packages:', JSON.stringify(item.packages));
    console.log('');
    console.log('=== IMAGES ===');
    if (item.images) {
      item.images.slice(0, 5).forEach((img, i) => {
        console.log(`Image ${i+1}:`, typeof img === 'string' ? img : JSON.stringify(img).slice(0, 300));
      });
    }
  } else {
    console.log('Not found');
  }
} finally {
  await client.close();
}
