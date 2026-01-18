// server.js
// Backend for ZumbaWithPooh Gallery (Cloudinary + MongoDB Atlas)

require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const { v2: cloudinary } = require('cloudinary');
const streamifier = require('streamifier');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

/* =========================
   MIDDLEWARE
========================= */

app.use(cors({
  origin: (origin, callback) => {
    // Allow local development from any origin (including file:// which appears as "null").
    // Tighten this in production.
    callback(null, true);
  },
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* =========================
   MONGODB CONNECTION
========================= */

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('❌ Missing MONGODB_URI environment variable');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

/* =========================
   CLOUDINARY CONFIG
========================= */

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
  console.error('❌ Missing one or more Cloudinary env vars: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET');
  process.exit(1);
}

/* =========================
   EMAIL (CONTACT NOTIFICATIONS)
========================= */

const CONTACT_TO_EMAIL = process.env.CONTACT_TO_EMAIL || '';
const CONTACT_FROM_EMAIL = process.env.CONTACT_FROM_EMAIL || process.env.SMTP_USER || '';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || SMTP_PORT === 465;

let mailTransporter = null;

if (SMTP_HOST && CONTACT_TO_EMAIL) {
  const transporterOptions = {
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE
  };

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    transporterOptions.auth = {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    };
  }

  if (String(process.env.SMTP_IGNORE_TLS_ERRORS || '').toLowerCase() === 'true') {
    transporterOptions.tls = { rejectUnauthorized: false };
  }

  try {
    mailTransporter = nodemailer.createTransport(transporterOptions);
    mailTransporter.verify()
      .then(() => console.log('✅ Email transporter ready'))
      .catch(err => console.warn('⚠️ Email transporter verification failed:', err.message));
  } catch (err) {
    console.error('❌ Failed to set up email transporter:', err);
  }
} else {
  console.log('ℹ️ Contact email notifications disabled (missing SMTP_HOST or CONTACT_TO_EMAIL)');
}

/* =========================
   MULTER SETUP
========================= */

const upload = multer();

/* =========================
   SCHEMAS
========================= */

// Card data (branch wise)
const cardDataSchema = new mongoose.Schema({
  branch: { type: String, required: true },
  cards: [
    {
      cardNum: Number,
      beforeImg: String,
      afterImg: String,
      details: String,
      name: String,
      beforeWeight: String,
      afterWeight: String
    }
  ]
});
const CardData = mongoose.model('CardData', cardDataSchema);

// Image schema
const imageSchema = new mongoose.Schema({
  url: { type: String, required: true },
  cardNum: { type: Number, required: true },
  slot: { type: String, enum: ['before', 'after'], required: true },
  createdAt: { type: Date, default: Date.now }
});
const Image = mongoose.model('Image', imageSchema);

// Latest offer schema
const offerSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  title: { type: String, default: '' },
  details: { type: String, default: '' },
  imageUrl: { type: String, default: '' },
  updatedAt: { type: Date, default: Date.now }
});
const Offer = mongoose.model('Offer', offerSchema);

// Contact inquiry schema
const contactInquirySchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, default: '' },
  message: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const ContactInquiry = mongoose.model('ContactInquiry', contactInquirySchema);

// Video reviews schema
const videoReviewSchema = new mongoose.Schema({
  url: { type: String, required: true },
  title: { type: String, default: '' },
  fileName: { type: String, default: '' },
  mimeType: { type: String, default: '' },
  publicId: { type: String, default: '' },
  uploadedAt: { type: Date, default: Date.now }
});
const VideoReview = mongoose.model('VideoReview', videoReviewSchema);

/* =========================
   ROUTES
========================= */

// ✅ Upload Image
app.post('/api/upload', upload.single('image'), async (req, res) => {
  const { branch, cardNum, slot } = req.body;

  const cardNumNum = Number(cardNum);

  if (!req.file || !branch || !Number.isFinite(cardNumNum) || !slot) {
    return res.status(400).json({ error: 'Missing image, branch, cardNum or slot' });
  }

  try {
    const uploadToCloudinary = (buffer) => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'zumba-gallery' },
          (err, result) => {
            if (result) resolve(result);
            else reject(err);
          }
        );
        streamifier.createReadStream(buffer).pipe(stream);
      });
    };

    const result = await uploadToCloudinary(req.file.buffer);

    // Remove old image for same card & slot
    await Image.deleteMany({ cardNum: cardNumNum, slot });

    const image = new Image({
      url: result.secure_url,
      cardNum: cardNumNum,
      slot
    });

    await image.save();

    // Also persist the URL into the branch card data so the gallery can reload it.
    // (The frontend loads images from CardData via /api/load-cards.)
    let cardData = await CardData.findOne({ branch });
    if (!cardData) {
      cardData = new CardData({ branch, cards: [] });
    }

    let card = cardData.cards.find(c => c.cardNum === cardNumNum);
    if (!card) {
      cardData.cards.push({ cardNum: cardNumNum });
      card = cardData.cards[cardData.cards.length - 1];
    }

    if (slot === 'before') card.beforeImg = result.secure_url;
    if (slot === 'after') card.afterImg = result.secure_url;

    await cardData.save();

    res.status(201).json({
      url: result.secure_url,
      cardNum: cardNumNum,
      slot,
      branch
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Image upload failed' });
  }
});

// ✅ Get Images
app.get('/api/images', async (req, res) => {
  try {
    const { cardNum, slot } = req.query;
    const filter = {};
    if (cardNum) filter.cardNum = cardNum;
    if (slot) filter.slot = slot;

    const images = await Image.find(filter).sort({ createdAt: 1 });
    res.json(images);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load images' });
  }
});

// ✅ Save Cards (branch wise)
app.post('/api/save-cards', async (req, res) => {
  const { branch, cards } = req.body;

  if (!branch || !Array.isArray(cards)) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  try {
    await CardData.deleteMany({ branch });
    await new CardData({ branch, cards }).save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save cards' });
  }
});

// ✅ Load Cards
app.get('/api/load-cards', async (req, res) => {
  const { branch } = req.query;
  if (!branch) return res.status(400).json({ error: 'Missing branch' });

  try {
    const data = await CardData.findOne({ branch });
    // Frontend expects an object with a `cards` array
    res.json({ cards: data ? data.cards : [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cards' });
  }
});

// ✅ Latest Offer (index.html)
app.get('/api/offers/latest', async (req, res) => {
  try {
    const offer = await Offer.findOne({ key: 'latestOffer' });
    if (!offer) return res.json(null);
    res.json({
      title: offer.title || '',
      details: offer.details || '',
      imageUrl: offer.imageUrl || '',
      updatedAt: offer.updatedAt
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load offer' });
  }
});

app.post('/api/offers/latest', async (req, res) => {
  const { title = '', details = '', imageUrl = '' } = req.body || {};
  if (!title && !details && !imageUrl) {
    return res.status(400).json({ error: 'Nothing to save' });
  }
  try {
    const offer = await Offer.findOneAndUpdate(
      { key: 'latestOffer' },
      { key: 'latestOffer', title, details, imageUrl, updatedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({
      title: offer.title || '',
      details: offer.details || '',
      imageUrl: offer.imageUrl || '',
      updatedAt: offer.updatedAt
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save offer' });
  }
});

app.delete('/api/offers/latest', async (req, res) => {
  try {
    await Offer.deleteOne({ key: 'latestOffer' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete offer' });
  }
});

// ✅ Contact inquiries
app.post('/api/contact/inquiries', async (req, res) => {
  const { name, email, phone = '', message } = req.body || {};

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const inquiry = await ContactInquiry.create({ name, email, phone, message });

    let emailSent = false;
    if (mailTransporter && CONTACT_TO_EMAIL && CONTACT_FROM_EMAIL) {
      const emailSubject = `New Contact Inquiry from ${name || 'Visitor'}`;
      const plainTextBody = [
        `You have received a new contact inquiry via ZumbaWithPooh.com`,
        '',
        `Name: ${name}`,
        `Email: ${email}`,
        `Phone: ${phone || 'Not provided'}`,
        '',
        'Message:',
        message,
        '',
        `Submitted at: ${new Date(inquiry.createdAt).toLocaleString()}`
      ].join('\n');

      const htmlBody = `
        <h2>New Contact Inquiry</h2>
        <p><strong>Name:</strong> ${name}</p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Phone:</strong> ${phone || 'Not provided'}</p>
        <p><strong>Submitted at:</strong> ${new Date(inquiry.createdAt).toLocaleString()}</p>
        <hr>
        <p><strong>Message:</strong></p>
        <p style="white-space: pre-line;">${message}</p>
      `;

      try {
        await mailTransporter.sendMail({
          from: CONTACT_FROM_EMAIL,
          to: CONTACT_TO_EMAIL,
          replyTo: email,
          subject: emailSubject,
          text: plainTextBody,
          html: htmlBody
        });
        emailSent = true;
      } catch (mailErr) {
        console.error('❌ Failed to send contact inquiry email:', mailErr);
      }
    }

    const responsePayload = inquiry.toObject();
    responsePayload.emailSent = emailSent;

    res.status(201).json(responsePayload);
  } catch (err) {
    console.error('Failed to save inquiry:', err);
    res.status(500).json({ error: 'Failed to save inquiry' });
  }
});

app.get('/api/contact/inquiries', async (req, res) => {
  try {
    const inquiries = await ContactInquiry.find().sort({ createdAt: -1 });
    res.json(inquiries);
  } catch (err) {
    console.error('Failed to load inquiries:', err);
    res.status(500).json({ error: 'Failed to load inquiries' });
  }
});

// ✅ Video reviews
app.post('/api/videos', async (req, res) => {
  const { url, title = '', fileName = '', mimeType = '', publicId = '' } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: 'Missing video URL' });
  }

  try {
    const video = await VideoReview.create({ url, title, fileName, mimeType, publicId });
    res.status(201).json(video);
  } catch (err) {
    console.error('Failed to save video:', err);
    res.status(500).json({ error: 'Failed to save video' });
  }
});

app.get('/api/videos', async (req, res) => {
  try {
    const videos = await VideoReview.find().sort({ uploadedAt: -1 });
    res.json(videos);
  } catch (err) {
    console.error('Failed to load videos:', err);
    res.status(500).json({ error: 'Failed to load videos' });
  }
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
