# LinkedIn Scout — Installation Guide

## What This Does
A Chrome extension that extracts LinkedIn profile data and generates 
ready-to-paste prompts for Claude. Three buttons:

1. **ICP Qualifier** — Is this person worth pursuing? Green/Amber/Red score.
2. **Signal & Lever Finder** — What's blocking them? What's the lever?
3. **Engagement & Message** — Post comment + queued DM in your voice.

No API key needed. No cost. Copy prompt → paste into Claude → get result.

---

## Installation (2 minutes)

1. Open Chrome and go to: **chrome://extensions**
2. Turn on **Developer mode** (toggle, top right)
3. Click **Load unpacked**
4. Select the **linkedin-scout** folder
5. The extension appears in your toolbar (pin it for easy access)

---

## How To Use

1. Go to any LinkedIn profile (linkedin.com/in/...)
2. Click the LinkedIn Scout icon in your toolbar
3. Click whichever prompt you need
4. Click **Copy Prompt**
5. Paste into a new Claude conversation
6. Read the result, make your decision

---

## Updating Your ICP Criteria

Open **popup.js** and edit the `ICP_CONTEXT` block at the top.
This is where your targeting criteria lives. Keep it updated as your 
ICP sharpens.

---

## Upgrading To API Later

When you have a Claude API key, the three `generatePrompt` functions 
can be replaced with direct API calls. The prompts themselves stay 
the same — you just remove the copy/paste step.

---

## Notes

- LinkedIn renders dynamically so some profiles extract better than others.
  If data looks thin, scroll down the profile before clicking the button.
- Recent posts are only visible if they appear on the profile page.
  If someone doesn't post publicly, that section will be empty.
- This reads the page — it doesn't interact with LinkedIn at all.
  No automation flags.
