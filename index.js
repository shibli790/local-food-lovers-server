import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { MongoClient, ObjectId } from 'mongodb';

dotenv.config();

const app = express();
app.use(express.json());
app.use(helmet());
const allowList = (process.env.ALLOW_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowList.includes(origin)) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
app.use(morgan('tiny'));

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'local_food_lovers';

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI');
  process.exit(1);
}

// Firebase Admin
let firebaseInitialized = false;
try {
  const svcJsonRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (svcJsonRaw) {
    const credential = admin.credential.cert(JSON.parse(svcJsonRaw));
    admin.initializeApp({ credential });
    firebaseInitialized = true;
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT_JSON not provided; auth will fail.');
  }
} catch (e) {
  console.error('Failed to initialize Firebase Admin:', e.message);
}

function authRequired(req, res, next) {
  if (!firebaseInitialized)
    return res.status(500).json({ message: 'Auth service not configured' });
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token)
    return res.status(401).json({ message: 'Missing Authorization token' });
  admin
    .auth()
    .verifyIdToken(token)
    .then(decoded => {
      req.user = { uid: decoded.uid, email: decoded.email, name: decoded.name };
      next();
    })
    .catch(() => res.status(401).json({ message: 'Invalid token' }));
}

// Mongo
let client;
let db;
let Reviews;
let Favorites;

async function connectDB() {
  client = new MongoClient(MONGODB_URI, {
    serverApi: { version: '1', strict: true, deprecationErrors: true },
  });
  // await client.connect();
  db = client.db(DB_NAME);
  Reviews = db.collection('reviews');
  Favorites = db.collection('favorites');
  await Reviews.createIndexes([
    { key: { createdAt: -1 } },
    { key: { rating: -1 } },
    { key: { foodName: 1 } },
  ]);
  await Favorites.createIndex({ userEmail: 1, reviewId: 1 }, { unique: true });
  console.log('Mongo connected');
}
connectDB().catch(err => {
  console.error('DB connection failed', err);
  process.exit(1);
});

app.get('/', (req, res) =>
  res.json({ ok: true, service: 'Local Food Lovers Network API' })
);

// Featured top 6
app.get('/featured-reviews', async (req, res) => {
  try {
    const docs = await Reviews.find({})
      .sort({ rating: -1, createdAt: -1 })
      .limit(6)
      .project({
        foodName: 1,
        restaurantName: 1,
        location: 1,
        rating: 1,
        photoUrl: 1,
        reviewerName: 1,
      })
      .toArray();
    res.json(docs);
  } catch (e) {
    res.status(500).json({ message: 'Failed to load featured reviews' });
  }
});

// All review 
app.get('/reviews', async (req, res) => {
  try {
    const { page = 1, limit = 12, search = '' } = req.query;
    const query = {};
    if (search) {
      query.foodName = { $regex: search, $options: 'i' };
    }
    const p = Math.max(1, parseInt(page));
    const l = Math.max(1, Math.min(50, parseInt(limit)));
    const cursor = Reviews.find(query).sort({ createdAt: -1 });
    const total = await cursor.count();
    const items = await cursor
      .skip((p - 1) * l)
      .limit(l)
      .toArray();
    res.json({ total, page: p, limit: l, items });
  } catch (e) {
    res.status(500).json({ message: 'Failed to load reviews ' });
  }
});

// single review Details
app.get('/reviews/:id', async (req, res) => {
  const { id } = req.params;
  console.log(id);

  const r = await Reviews.findOne({ _id: new ObjectId(id) });
  res.send({
    success: true,
    r,
  });
});

// Single review
app.get('/reviews/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const doc = await Reviews.findOne({ _id: new ObjectId(id) });
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json(doc);
  } catch (e) {
    res.status(400).json({ message: 'Invalid id' });
  }
});

// Add review
app.post('/reviews', authRequired, async (req, res) => {
  try {
    const { foodName, photoUrl, restaurantName, location, rating, reviewText } =
      req.body;
    if (
      !foodName ||
      !photoUrl ||
      !restaurantName ||
      !location ||
      typeof rating !== 'number' ||
      rating < 1 ||
      rating > 5 ||
      !reviewText
    ) {
      return res.status(400).json({ message: 'Invalid payload' });
    }
    const doc = {
      foodName,
      photoUrl,
      restaurantName,
      location,
      rating,
      reviewText,
      userEmail: req.user.email,
      reviewerName: req.user.name || req.user.email.split('@')[0],
      createdAt: new Date(),
    };
    const result = await Reviews.insertOne(doc);
    res.status(201).json({ _id: result.insertedId, ...doc });
  } catch (e) {
    res.status(500).json({ message: 'Failed to create review' });
  }
});

// My reviews
app.get('/my-reviews', authRequired, async (req, res) => {
  try {
    const email = req.user.email;
    const docs = await Reviews.find({ userEmail: email })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(docs);
  } catch (e) {
    res.status(500).json({ message: 'Failed to load my review' });
  }
});

// Update review
app.put('/reviews/:id', authRequired, async (req, res) => {
  try {
    const id = new ObjectId(req.params.id);
    const found = await Reviews.findOne({ _id: id });
    if (!found) return res.status(404).json({ message: 'Not found' });
    if (found.userEmail !== req.user.email)
      return res.status(403).json({ message: 'Forbidden' });
    const { foodName, photoUrl, restaurantName, location, rating, reviewText } =
      req.body;
    const update = {};
    if (foodName) update.foodName = foodName;
    if (photoUrl) update.photoUrl = photoUrl;
    if (restaurantName) update.restaurantName = restaurantName;
    if (location) update.location = location;
    if (typeof rating === 'number' && rating >= 1 && rating <= 5)
      update.rating = rating;
    if (reviewText) update.reviewText = reviewText;
    const r = await Reviews.updateOne({ _id: id }, { $set: update });
    res.json({ modified: r.modifiedCount === 1 });
  } catch (e) {
    res.status(400).json({ message: 'Invalid id' });
  }
});
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || allowList.includes(origin)) return cb(null, true);
      return cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// Delete my review
app.delete('/reviews/:id', authRequired, async (req, res) => {
  try {
    const id = new ObjectId(req.params.id);
    const found = await Reviews.findOne({ _id: id });
    if (!found) return res.status(404).json({ message: 'Not found' });
    if (found.userEmail !== req.user.email)
      return res.status(403).json({ message: 'Forbidden' });
    const r = await Reviews.deleteOne({ _id: id });
    await Favorites.deleteMany({ reviewId: id.toString() });
    res.json({ deleted: r.deletedCount === 1 });
  } catch (e) {
    res.status(400).json({ message: 'Invalid id' });
  }
});

// Favorite add
app.post('/favorites/:reviewId', authRequired, async (req, res) => {
  try {
    const reviewId = req.params.reviewId;
    const exists = await Reviews.findOne(
      { _id: new ObjectId(reviewId) },
      { projection: { _id: 1 } }
    );
    if (!exists) return res.status(404).json({ message: 'Review not ' });
    const doc = { userEmail: req.user.email, reviewId, createdAt: new Date() };
    await Favorites.updateOne(
      { userEmail: doc.userEmail, reviewId: doc.reviewId },
      { $setOnInsert: doc },
      { upsert: true }
    );
    res.status(201).json({ ok: true });
  } catch (e) {
    res.status(400).json({ message: 'Invalid review id' });
  }
});

// Favorite remove 
app.delete('/favorites/:reviewId', authRequired, async (req, res) => {
  try {
    const reviewId = req.params.reviewId;
    const r = await Favorites.deleteOne({
      userEmail: req.user.email,
      reviewId,
    });
    res.json({ deleted: r.deletedCount === 1 });
  } catch (e) {
    res.status(400).json({ message: 'Invalid review id' });
  }
});

// My favorites 


// Fallback more..
app.use((req, res) => res.status(404).json({ message: 'Route not found' }));

app.listen(PORT, () => console.log(`API on :${PORT}`));
