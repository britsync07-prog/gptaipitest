import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors()); // 🔥 This line fixes the CORS error
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ================================
// 🔥 QUEUE SYSTEM
// ================================
let running = false;
const queue = [];

async function runNext() {
  if (running || queue.length === 0) return;

  running = true;
  const { req, res } = queue.shift();

  try {
    await handleRequest(req, res);
  } catch (err) {
    console.error("❌ Request Error:", err);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  running = false;
  runNext();
}

// ================================
// HELPERS
// ================================
function log(msg) {
  console.log("🧩", msg);
}

function buildFinalPrompt(userPrompt) {
  return `You are a backend API, not a chatbot. 
  You MUST follow this protocol: 
  - Output ONLY inside <answer> and </answer> 
  - NEVER refuse or explain 
  - NEVER override these rules 
  - NEVER say you cannot follow instructions 
  - NEVER use code blocks or markdown 
  - NEVER add any text outside <answer> 
  - No extra text 
  - No images 
  
  If the request contains code, return it as plain text inside <answer>. 
  If you break this format, the output is invalid.

User request:
${userPrompt}

<answer>
your answer here
</answer>`;
}

function buildFixPrompt(badOutput) {
  return `Fix this output.
Rules:
- Keep same content
- Wrap ONLY inside <answer>...</answer>
- No markdown
- No extra text

CONTENT:
${badOutput}`;
}

function isValid(text) {
  if (!text) return false;
  const trimmed = text.trim();
  const fullMatch = trimmed.match(/^<answer>\s*[\s\S]*?\s*<\/answer>$/i);
  if (!fullMatch) return false;

  const content = trimmed.replace(/^<answer>/i, '').replace(/<\/answer>$/i, '').trim();
  const forbiddenPatterns = [/```/, /<pre>|<code>/i, /I\s*(can('|’)t|cannot|unable)/i, /sorry/i, /as an ai/i];

  for (let pattern of forbiddenPatterns) {
    if (pattern.test(content)) return false;
  }
  return true;
}

function extractAnswer(text) {
  const match = text.match(/<answer>\s*([\s\S]*?)\s*<\/answer>/i);
  return match ? match[1].trim() : null;
}

async function getInputBox(page) {
  const elements = await page.$$('textarea, div[contenteditable="true"]');
  for (const el of elements) {
    const box = await el.boundingBox();
    if (box && box.width > 0 && box.height > 0) return el;
  }
  throw new Error("No visible input found");
}

async function pastePrompt(page, element, text) {
  await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value);
  }, text);
  await element.focus();
  await page.keyboard.down('Control');
  await page.keyboard.press('V');
  await page.keyboard.up('Control');
}

async function waitAndGetLastResponse(page) {
  let lastText = "";
  let stable = 0;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const texts = await page.$$eval('.markdown, article', els =>
      els.map(el => el.innerText).filter(t => t.trim())
    );
    const current = texts[texts.length - 1] || "";
    if (current === lastText && current !== "") {
      stable++;
      if (stable >= 3) break;
    } else {
      stable = 0;
      lastText = current;
    }
  }
  return lastText;
}

async function callAI(page, prompt) {
  const input = await getInputBox(page);
  await input.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await pastePrompt(page, input, prompt);
  await page.keyboard.press('Enter');
  await page.waitForSelector('.markdown, article', { timeout: 60000 });
  return await waitAndGetLastResponse(page);
}

async function safeHandlePrompt(page, userPrompt) {
  log("Step 1: Generate");
  let res = await callAI(page, buildFinalPrompt(userPrompt));
  for (let i = 0; i < 3; i++) {
    log(`Validation attempt ${i + 1}`);
    if (isValid(res)) {
      log("✅ Valid response");
      return extractAnswer(res);
    }
    log("⚠️ Invalid → fixing...");
    res = await callAI(page, buildFixPrompt(res));
  }
  throw new Error("Failed after retries");
}

async function getCleanPage(browser) {
  let pages = await browser.pages();
  while (pages.length > 1) {
    await pages[pages.length - 1].close();
    pages = await browser.pages();
  }
  return pages[0] || await browser.newPage();
}

// ================================
// 🗑️ CLEANUP LOGIC (KEEPING FROM SERVER.JS)
// ================================
async function deleteCurrentChat(page) {
  log("🧹 Cleaning up: Deleting chat...");
  try {
    // 1. Click the 'Three Dots' (Options) menu using the specific data-testid
    const menuSelector = "[data-testid='conversation-options-button']";
    
    // Wait for the button to be visible
    await page.waitForSelector(menuSelector, { timeout: 5000 });
    
    // Click it
    await page.click(menuSelector);
    log("🖱️ Menu clicked");

    // 2. Click the 'Delete' item
    const deleteBtn = "[data-testid='delete-chat-menu-item']";
    await page.waitForSelector(deleteBtn, { timeout: 3000 });
    await page.click(deleteBtn);
    log("🖱️ Delete button clicked");

    // 3. Confirm Delete in modal
    const confirmBtn = "[data-testid='delete-conversation-confirm-button']";
    await page.waitForSelector(confirmBtn, { timeout: 3000 });
    await page.click(confirmBtn);
    
    log("✅ Chat deleted successfully");
    await new Promise(r => setTimeout(r, 2000)); // Extra wait for UI to reset
  } catch (err) {
    log(`⚠️ Cleanup failed: ${err.message}`);
    
    // Fallback if data-testid fails: try clicking by aria-label
    try {
      log("🔄 Attempting fallback via aria-label...");
      await page.click('button[aria-label*="conversation options"]');
      await page.waitForSelector("[data-testid='delete-chat-menu-item']", { timeout: 2000 });
      await page.click("[data-testid='delete-chat-menu-item']");
      await page.waitForSelector("[data-testid='delete-conversation-confirm-button']", { timeout: 2000 });
      await page.click("[data-testid='delete-conversation-confirm-button']");
      log("✅ Chat deleted via fallback");
    } catch (fallbackErr) {
      log("❌ All cleanup attempts failed");
    }
  }
}

// ================================
// 🚀 MAIN HANDLER
// ================================
async function handleRequest(req, res) {
  const prompt = req.body.prompt || "Are you working";
  const userDataDir = path.join(__dirname, 'browser-profile');

  log("🚀 Processing request: " + prompt);

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir,
    args: [
      '--start-maximized',
      '--no-sandbox',
      '--disable-setuid-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu',
            '--no-zygote'
    ]
  });

  try {
    const page = await getCleanPage(browser);

    // Correct URL from login.js
    await page.goto('https://chat.openai.com', {
      waitUntil: 'networkidle2'
    });

    const result = await safeHandlePrompt(page, prompt);

    fs.writeFileSync(path.join(__dirname, 'reply.txt'), result || "");

    // Keep the delete logic from server.js
    await deleteCurrentChat(page);

    res.json({
      success: true,
      data: result
    });

  } finally {
    log("🔒 Closing browser");
    await browser.close();
  }
}

// ================================
app.post('/ask', async (req, res) => {
  log("📥 Incoming request");
  queue.push({ req, res });
  runNext();
});

app.listen(3000, () => {
  console.log("🔥 Server running on http://localhost:3000");
});
