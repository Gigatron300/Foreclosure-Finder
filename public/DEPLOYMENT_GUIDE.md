# Foreclosure Finder - Deployment Guide

This guide will walk you through deploying your foreclosure scraper for **free** on Render.com. No coding knowledge required - just follow the steps!

---

## What You're Setting Up

1. **A web scraper** that automatically pulls foreclosure data from:
   - CivilView (Camden County, NJ)
   - Bid4Assets (Montgomery County, PA)

2. **A website** where you can search and filter properties

3. **Automatic updates** - data refreshes on a schedule you set

---

## Step 1: Create a GitHub Account (if you don't have one)

1. Go to [github.com](https://github.com)
2. Click "Sign up"
3. Follow the prompts to create a free account
4. Verify your email

---

## Step 2: Upload the Code to GitHub

1. Once logged into GitHub, click the **+** icon in the top right
2. Select **"New repository"**
3. Name it: `foreclosure-finder`
4. Make sure "Public" is selected (required for free Render hosting)
5. Check ✅ "Add a README file"
6. Click **"Create repository"**

Now upload the project files:

1. Click **"Add file"** → **"Upload files"**
2. Drag and drop ALL the files from the foreclosure-scraper folder:
   - `package.json`
   - `server.js`
   - `scraper.js`
   - `public/index.html` (you'll need to create the public folder first)
   
   **To create the public folder:**
   - Click "Add file" → "Create new file"
   - Type `public/index.html` as the filename
   - Paste the contents of index.html
   - Click "Commit changes"

3. Click **"Commit changes"**

---

## Step 3: Sign Up for Render.com

1. Go to [render.com](https://render.com)
2. Click **"Get Started for Free"**
3. Sign up with your GitHub account (easiest option)
4. Authorize Render to access your GitHub

---

## Step 4: Create a New Web Service

1. From your Render dashboard, click **"New +"**
2. Select **"Web Service"**
3. Connect your GitHub repository:
   - Find `foreclosure-finder` in the list
   - Click **"Connect"**

4. Configure the service:
   - **Name:** `foreclosure-finder` (or whatever you want)
   - **Region:** Choose closest to you (e.g., "Ohio" for East Coast)
   - **Branch:** `main`
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`

5. Select the **Free** plan

6. Click **"Create Web Service"**

---

## Step 5: Wait for Deployment

- Render will now build and deploy your app
- This takes about 2-5 minutes
- You'll see logs scrolling - this is normal!
- When you see "Your service is live" - you're done!

---

## Step 6: Access Your App

1. Render will give you a URL like: `https://foreclosure-finder-xxxx.onrender.com`
2. Click that URL to open your app
3. **Important:** The first time you visit, there's no data yet!

---

## Step 7: Run Your First Scrape

1. Open your app URL
2. Click the **"Refresh Data from Counties"** button
3. Wait 5-10 minutes (scraping takes time!)
4. The page will alert you when complete
5. Your properties will now appear!

---

## Step 8: (Optional) Set Up Automatic Scraping

To have data refresh automatically every day:

1. Go back to Render dashboard
2. Click **"New +"** → **"Cron Job"**
3. Connect the same repository
4. Configure:
   - **Name:** `foreclosure-scraper-daily`
   - **Schedule:** `0 6 * * *` (runs at 6 AM daily)
   - **Command:** `node scraper.js`
5. Select **Free** plan
6. Click **"Create Cron Job"**

---

## Troubleshooting

### "No properties found"
- Click "Refresh Data from Counties" and wait for it to complete
- Check that the scrape finished successfully

### App is slow to load
- Free Render apps "sleep" after 15 minutes of inactivity
- First load after sleeping takes 30-60 seconds
- After that, it's fast

### Scrape fails or times out
- Some county sites may block automated access
- Try running the scrape at different times
- The scraper has retry logic built in

### Need more help?
- Check Render's logs: Dashboard → Your Service → Logs
- The logs show exactly what's happening

---

## Understanding the Free Tier Limits

**Render Free Tier includes:**
- 750 hours/month of runtime (plenty for one app)
- Apps sleep after 15 min of inactivity
- Auto-wake when someone visits
- Limited to one cron job

**This is plenty for personal use!** If you need always-on service, their paid tier starts at $7/month.

---

## Adding More Counties (Advanced)

The scraper can be extended to add more counties. You would need to:

1. Find the county's sheriff sale website
2. Add a new scraper function in `scraper.js`
3. Follow the pattern of the existing scrapers

If you want help adding counties, just ask!

---

## Your App URLs

After deployment, bookmark these:

- **Your App:** `https://[your-app-name].onrender.com`
- **API (raw data):** `https://[your-app-name].onrender.com/api/properties`
- **CSV Export:** `https://[your-app-name].onrender.com/api/export/csv`

---

Congratulations! You now have a fully functional foreclosure property finder that automatically scrapes real data from county websites! 🏠
