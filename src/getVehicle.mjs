import { MongoClient, ObjectId } from 'mongodb';
const MONGO_URI = 'mongodb://dealvercel:juicehead2410@72.60.118.141:27017/dealerversal?authSource=admin';
const client = new MongoClient(MONGO_URI);
try {
  await client.connect();
  const db = client.db('dealerversal');
  
  const item = await db.collection('inventory').findOne({ _id: new ObjectId('6aa09a6b215cda1387bbe509') });
  if (item) {
    console.log('=== VEHICLE DETAILS ===');
    console.log('Year:', item.year);
    console.log('Make:', item.make);
    console.log('Model:', item.model);
    console.log('Trim:', item.trim);
    console.log('Title:', item.title);
    console.log('Price:', item.price);
    console.log('Mileage:', item.mileage);
    console.log('VIN:', item.vin);
    console.log('Link:', item.link);
    console.log('SiteUrl:', item.siteUrl);
    console.log('Features:', JSON.stringify(item.features)?.slice(0, 500));
    console.log('Highlighted Features:', JSON.stringify(item.highlighted_features)?.slice(0, 500));
    console.log('Packages:', JSON.stringify(item.packages)?.slice(0, 300));
    console.log('');
    console.log('=== IMAGES ===');
    if (item.images && item.images.length > 0) {
      item.images.forEach((img, i) => {
        console.log(`Image ${i+1}:`, typeof img === 'string' ? img : JSON.stringify(img).slice(0, 300));
      });
    }
    console.log('');
    console.log('ALL KEYS:', Object.keys(item).join(', '));
  } else {
    console.log('Not found. Trying by VIN...');
    const byVin = await db.collection('inventory').findOne({ vin: '5TDACAB56TS30N904' });
    if (byVin) {
      console.log('Found by VIN!');
      console.log(JSON.stringify(byVin, null, 2).slice(0, 5000));
    } else {
      // Search for Grand Highlander
      const sample = await db.collection('inventory').find({ model: /highlander/i }).limit(3).toArray();
      console.log('Highlanders found:', sample.length);
      if (sample.length > 0) console.log(JSON.stringify(sample[0], null, 2).slice(0, 3000));
    }
  }
} finally {
  await client.close();
}
