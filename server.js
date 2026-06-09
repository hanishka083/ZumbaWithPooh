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

function readEnv(name) {
  const raw = process.env[name];
  if (typeof raw !== 'string') return '';
  // Remove accidental wrapping quotes/spaces copied into .env values.
  return raw.trim().replace(/^['\"]|['\"]$/g, '');
}

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

const CLOUDINARY_CLOUD_NAME = readEnv('CLOUDINARY_CLOUD_NAME') || readEnv('CLOUD_NAME');
const CLOUDINARY_API_KEY = readEnv('CLOUDINARY_API_KEY') || readEnv('CLOUD_API_KEY');
const CLOUDINARY_API_SECRET = readEnv('CLOUDINARY_API_SECRET') || readEnv('CLOUD_API_SECRET');

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET
});

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.error('❌ Missing one or more Cloudinary env vars: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET');
  process.exit(1);
}

cloudinary.api.ping()
  .then(() => console.log('✅ Cloudinary credentials verified'))
  .catch((err) => {
    console.error('❌ Cloudinary API credential check failed. Verify CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET belong to the same account.');
    console.error('❌ Cloudinary error:', err?.message || err);
  });

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
cardDataSchema.index({ branch: 1 });
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
offerSchema.index({ key: 1 }, { unique: true });
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

const CACHE_TTL_MS = 60 * 1000;
const branchCardsCache = new Map();
const latestOfferCache = { value: null, expiresAt: 0 };

function readCache(entry) {
  if (!entry || Date.now() > entry.expiresAt) return null;
  return entry.value;
}

function writeCache(target, value) {
  target.value = value;
  target.expiresAt = Date.now() + CACHE_TTL_MS;
}

function clearBranchCache(branch) {
  if (branch) {
    branchCardsCache.delete(branch);
    return;
  }
  branchCardsCache.clear();
}

function clearOfferCache() {
  latestOfferCache.value = null;
  latestOfferCache.expiresAt = 0;
}

function extractCloudinaryPublicIdFromUrl(url) {
  if (!url || typeof url !== 'string') return '';

  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    const uploadIndex = pathParts.findIndex((part) => part === 'upload');
    if (uploadIndex === -1 || uploadIndex + 1 >= pathParts.length) return '';

    const afterUpload = pathParts.slice(uploadIndex + 1);

    // Skip Cloudinary version segment (e.g., v1712345678) if present.
    if (afterUpload[0] && /^v\d+$/.test(afterUpload[0])) {
      afterUpload.shift();
    }

    if (!afterUpload.length) return '';

    const joined = afterUpload.join('/');
    return joined.replace(/\.[^/.]+$/, '');
  } catch (err) {
    return '';
  }
}

function extractCloudinaryCloudNameFromUrl(url) {
  if (!url || typeof url !== 'string') return '';

  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    // Expected URL shape: /<cloud_name>/<resource_type>/upload/...
    return parts[0] || '';
  } catch (err) {
    return '';
  }
}

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
    clearBranchCache(branch);

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
    clearBranchCache(branch);
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
    const cachedCards = readCache(branchCardsCache.get(branch));
    if (cachedCards) {
      return res.json({ cards: cachedCards });
    }

    const data = await CardData.findOne({ branch }).lean();
    // Frontend expects an object with a `cards` array
    const cards = data ? data.cards : [];
    branchCardsCache.set(branch, { value: cards, expiresAt: Date.now() + CACHE_TTL_MS });
    res.json({ cards });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cards' });
  }
});

// ✅ Latest Offer (index.html)
app.get('/api/offers/latest', async (req, res) => {
  try {
    const cachedOffer = readCache(latestOfferCache);
    if (cachedOffer) {
      return res.json(cachedOffer);
    }

    const offer = await Offer.findOne({ key: 'latestOffer' }).lean();
    if (!offer) return res.json(null);
    const payload = {
      title: offer.title || '',
      details: offer.details || '',
      imageUrl: offer.imageUrl || '',
      updatedAt: offer.updatedAt
    };
    writeCache(latestOfferCache, payload);
    res.json(payload);
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
    clearOfferCache();
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
    clearOfferCache();
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
app.post('/api/videos/upload', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Missing video file' });
  }

  if (!req.file.mimetype || !req.file.mimetype.startsWith('video/')) {
    return res.status(400).json({ error: 'Only video files are allowed' });
  }

  try {
    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: 'video',
          folder: 'video-reviews',
          public_id: `review_${Date.now()}`
        },
        (err, result) => {
          if (result) resolve(result);
          else reject(err);
        }
      );

      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });

    const titleFromFile = (req.file.originalname || '').replace(/\.[^/.]+$/, '');

    const video = await VideoReview.create({
      url: uploaded.secure_url,
      title: uploaded.original_filename || titleFromFile,
      fileName: req.file.originalname || '',
      mimeType: req.file.mimetype || '',
      publicId: uploaded.public_id || ''
    });

    res.status(201).json(video);
  } catch (err) {
    console.error('Failed to upload video:', err);
    res.status(500).json({ error: 'Failed to upload video' });
  }
});

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

app.delete('/api/videos/:id', async (req, res) => {
  const { id } = req.params;
  const forceDbOnly = String(req.query.forceDbOnly || '').toLowerCase() === 'true';

  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ error: 'Invalid video id' });
  }

  try {
    const video = await VideoReview.findById(id);
    if (!video) {
      return res.status(404).json({ error: 'Video not found' });
    }

    const videoCloudName = extractCloudinaryCloudNameFromUrl(video.url);
    if (videoCloudName && videoCloudName !== CLOUDINARY_CLOUD_NAME) {
      if (forceDbOnly) {
        await VideoReview.findByIdAndDelete(id);
        return res.json({
          success: true,
          id,
          forceDbOnly: true,
          warning: 'Database record removed. Cloudinary asset remains in legacy cloud account.'
        });
      }

      return res.status(409).json({
        error: 'Video belongs to a different Cloudinary cloud than current server credentials',
        videoCloudName,
        configuredCloudName: CLOUDINARY_CLOUD_NAME,
        canForceDbOnly: true,
        hint: 'Use forceDbOnly=true to remove the website record only when the asset belongs to a legacy cloud account'
      });
    }

    const storedPublicId = (video.publicId || '').trim();
    const urlDerivedPublicId = extractCloudinaryPublicIdFromUrl(video.url);
    const cloudinaryCandidates = [storedPublicId, urlDerivedPublicId].filter((value, idx, arr) => value && arr.indexOf(value) === idx);

    if (cloudinaryCandidates.length) {
      let deletedFromCloudinary = false;
      let lastCloudinaryError = '';

      for (const candidate of cloudinaryCandidates) {
        try {
          const cloudinaryResult = await cloudinary.uploader.destroy(candidate, {
            resource_type: 'video',
            invalidate: true
          });

          // Cloudinary returns "ok" for deleted assets and "not found" when already absent.
          if (cloudinaryResult?.result === 'ok' || cloudinaryResult?.result === 'not found') {
            deletedFromCloudinary = true;
            if (cloudinaryResult?.result === 'not found') {
              console.warn('⚠️ Cloudinary video asset already missing:', candidate);
            }
            break;
          }

          lastCloudinaryError = `Unexpected Cloudinary response: ${JSON.stringify(cloudinaryResult)}`;
        } catch (cloudErr) {
          lastCloudinaryError = cloudErr?.message || 'Unknown Cloudinary delete failure';
        }
      }

      if (!deletedFromCloudinary) {
        console.error('❌ Failed to delete video from Cloudinary:', lastCloudinaryError);
        const errorText = String(lastCloudinaryError || '');
        const isAuthMismatch = /api_secret mismatch|invalid signature/i.test(errorText);

        if (isAuthMismatch) {
          return res.status(401).json({
            error: 'Cloudinary credentials are invalid for delete operation',
            details: errorText,
            configuredCloudName: CLOUDINARY_CLOUD_NAME,
            hint: 'Verify CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET from the same Cloudinary account'
          });
        }

        return res.status(502).json({
          error: 'Failed to delete video file from Cloudinary',
          details: errorText
        });
      }
    }

    await VideoReview.findByIdAndDelete(id);
    res.json({ success: true, id });
  } catch (err) {
    console.error('Failed to delete video:', err);
    res.status(500).json({ error: 'Failed to delete video' });
  }
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
