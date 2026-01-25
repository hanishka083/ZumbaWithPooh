# Zumba With Pooh – Project Guide

## Overview
- Single-page style marketing site backed by a lightweight Node/Express API for offer management, media uploads, and contact handling.
- Visual identity built around animated gradients, cinematic overlays, and playful typography (Inter + Pacifico) to match the high-energy fitness brand.
- Two-branch studio story supported by galleries, testimonials, schedules, and membership pricing.

## Front-End Pages
- **Landing ([index.html](index.html))**
	- Intro overlay with video curtain reveal and autoplay hero animation.
	- Dynamic offer modal (pulls from `/api/offers/latest`).
	- Class highlights, trainer spotlight, testimonials entry point, and footer contact shortcuts.
- **Services ([services.html](services.html))**
	- Multi-stage intro with muted video playlists for each weekday focus.
	- Panels for programs, daily session breakdown, benefits checklist, branch-wise timings, pricing tiers, and conversion CTA.
- **Branch Galleries ([branch1.html](branch1.html), [branch2.html](branch2.html))**
	- Before/after success cards with editable notes, Cloudinary-backed image swaps, and branch filters.
- **Testimonials ([video-reviews.html](video-reviews.html))**
	- Responsive video grid with sharing-friendly layout fed by backend review metadata.
- **Contact ([contact.html](contact.html))**
	- Dual-branch map embeds, enquiry form (POST `/api/contact/inquiries`), and admin-only inquiry viewer.
- **Popup & Utility Views ([popup.html](popup.html), [googlee37e3eff1dc7f270.html](googlee37e3eff1dc7f270.html))**
	- Lead-capture overlay and Google Search Console verification file.

## Shared UI/UX Highlights
- Reusable nav with hamburger sidebar, admin/login actions, and call-to-action buttons.
- Offer modal and testimonials selector reused across pages for consistent lead funnels.
- CSS-driven sparkles, gradients, and motion (keyframes for glow, bounce, shimmer, float).
- Mobile-first responsiveness via clamp-based typography, grid fallbacks, and sidebar navigation.

## Backend & Data Layer
- **Server ([server.js](server.js))**
	- Express 5 API with MongoDB (Mongoose) for structured storage.
	- Multer + Cloudinary streaming uploads, replacing previous card slots and persisting file URLs.
	- Offer CRUD endpoints, contact inquiry persistence, optional SMTP notifications, and video review catalog management.
- **Persistence Models**
	- `CardData` for branch galleries, `Image` for before/after slots, `Offer` for promos, `ContactInquiry` for form submissions, `VideoReview` for testimonial playlist.
- **Admin Controls (front-end)**
	- Password-gated panels for swapping offers, editing gallery metadata, and reviewing enquiries.

## Environment Variables
```
MONGODB_URI=...
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
CONTACT_TO_EMAIL=...
CONTACT_FROM_EMAIL=...
SMTP_HOST=...
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
SMTP_IGNORE_TLS_ERRORS=false
PORT=5000
```
- Offer editor and gallery uploads require Cloudinary credentials.
- Contact notifications only trigger when SMTP host, auth, and `CONTACT_TO_EMAIL` are supplied.

## Local Development
1. Install Node dependencies: `npm install`.
2. Supply environment variables (see `.env.example` guidance above).
3. Start backend server: `npm start` (serves API on configured `PORT`).
4. Open HTML files via live server or static hosting; ensure API URL constants match your environment.

## Deployment Notes
- Front-end can live on static hosting (Netlify, Vercel, S3) with API endpoints pointed to deployed Express instance (e.g., Render, Railway).
- Secure admin password storage, tighten CORS, and restrict offer/editor routes before production launch.